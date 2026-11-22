// Must load before anything else so HTTP/Express/fetch instrumentation can
// patch those modules before they're used (#307). A `node --import` preload
// (see package.json) would guarantee strict ordering; this is the pragmatic
// version for a `tsx`-run dev/prod entrypoint.
import "./tracing.js";
import type { Server } from "node:http";
import { config } from "./config.js";
import { captureServerException } from "./lib/sentry.js";
import app from "./app.js";
import { rootLogger } from "./lib/logger.js";
import { beginShutdown, whenDrained, inFlightCount } from "./lib/lifecycle.js";
import { pgClient } from "./db/client.js";
import { startPoolMetrics, stopPoolMetrics } from "./db/client.js";
import { startPaymentReconciliationWorker, stopPaymentReconciliationWorker } from "./workers/paymentReconciliationWorker.js";
import { startRetryPendingWorker, stopRetryPendingWorker } from "./workers/retryPendingWorker.js";
import { startEventListener, stopEventListener } from "./workers/eventListener.js";
import { startWebhookOutboxWorker, stopWebhookOutboxWorker } from "./workers/webhookOutboxWorker.js";
import {
  startIdempotencyCleanupWorker,
  stopIdempotencyCleanupWorker,
} from "./workers/idempotencyCleanupWorker.js";
import {
  startUploadTempSweepWorker,
  stopUploadTempSweepWorker,
} from "./workers/uploadTempSweepWorker.js";
import { createPostgresRowStore, type PgSql } from "./lib/idempotencyPgStore.js";
import { closeRateLimitStore } from "./lib/rateLimit/index.js";
import { closeSignatureReplayStore } from "./middleware/requestSignatureAuth.js";
import { setWorkerLeader, recordWorkerPass } from "./lib/workerStatus.js";
// Advisory lock key used to elect a single leader across replicas. Only the
// instance holding this lock runs the background workers, so scaling out does
// not duplicate RPC load or let replicas write the same rows concurrently.
const WORKER_LEADER_LOCK_ID = config.WORKER_LEADER_LOCK_ID;

let workersStarted = false;
// Advisory locks are session-scoped, so the connection that took the lock is
// reserved for the process lifetime and the unlock must run on it too.
let leaderConnection: Awaited<ReturnType<typeof pgClient.reserve>> | null = null;

/**
 * Try to become the worker leader by acquiring a session-level Postgres
 * advisory lock on a dedicated connection. The lock is held for the process
 * lifetime and released during graceful shutdown.
 *
 * Returns true when this instance acquired the lock and should run workers.
 */
async function tryAcquireWorkerLeaderLock(): Promise<boolean> {
  try {
    const reserved = await pgClient.reserve();
    const [row] = await reserved<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${WORKER_LEADER_LOCK_ID}) AS locked`;
    if (row?.locked === true) {
      leaderConnection = reserved;
      setWorkerLeader(true);
      return true;
    }
    // Not the leader: return the connection to the pool.
    reserved.release();
    return false;
  } catch (err) {
    rootLogger.error({ event: "worker_leader_lock_error", err }, "failed to acquire worker leader lock");
    return false;
  }
}

async function releaseWorkerLeaderLock(): Promise<void> {
  const reserved = leaderConnection;
  if (!reserved) return;
  leaderConnection = null;
  setWorkerLeader(false);
  try {
    await reserved`SELECT pg_advisory_unlock(${WORKER_LEADER_LOCK_ID})`;
  } catch (err) {
    rootLogger.error({ event: "worker_leader_unlock_error", err }, "failed to release worker leader lock");
  } finally {
    reserved.release();
  }
}

let electionTimer: NodeJS.Timeout | null = null;
let healthCheckTimer: NodeJS.Timeout | null = null;

const ELECTION_RETRY_DELAY_MS = 5_000;
const HEALTH_CHECK_INTERVAL_MS = 5_000;

function startWorkers(): void {
  if (workersStarted) return;
  workersStarted = true;
  rootLogger.info({ event: "workers_started_as_leader" }, "acquired worker leader lock; starting background workers");
  startRetryPendingWorker();
  startPaymentReconciliationWorker();
  startEventListener();
  startWebhookOutboxWorker();
  // Sweep expired idempotency rows in bounded batches (#173). The deleter is
  // wired here so the worker stays independent of the Postgres client and can
  // be tested with a fake; only the elected leader runs it.
  const idempotencyRows = createPostgresRowStore(pgClient as unknown as PgSql);
  startIdempotencyCleanupWorker((batchSize) => idempotencyRows.deleteExpired(batchSize));
  // Reclaim upload temp files orphaned by process crashes; the sweep only
  // removes stale files inside the dedicated upload temp directory.
  startUploadTempSweepWorker();
  startLeaderHealthCheck();
}

function stopWorkers(): void {
  if (!workersStarted) return;
  workersStarted = false;
  stopRetryPendingWorker();
  stopPaymentReconciliationWorker();
  stopEventListener();
  stopWebhookOutboxWorker();
  stopIdempotencyCleanupWorker();
  stopUploadTempSweepWorker();
  rootLogger.info({ event: "workers_stopped" }, "background workers stopped");
}

function startLeaderHealthCheck(): void {
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  healthCheckTimer = setInterval(async () => {
    if (shuttingDown || !workersStarted || !leaderConnection) {
      if (healthCheckTimer) {
        clearInterval(healthCheckTimer);
        healthCheckTimer = null;
      }
      return;
    }
    try {
      const [row] = await leaderConnection<{ held: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory'
            AND objid = ${WORKER_LEADER_LOCK_ID}
            AND pid = pg_backend_pid()
        ) AS held
      `;
      if (!row?.held) {
        throw new Error("Advisory lock no longer held on active leader session");
      }
    } catch (err) {
      rootLogger.error(
        { event: "worker_leader_session_lost", err },
        "leader database session lost; stopping workers (#161)",
      );
      setWorkerLeader(false);
      stopWorkers();
      if (healthCheckTimer) {
        clearInterval(healthCheckTimer);
        healthCheckTimer = null;
      }
      try {
        leaderConnection?.release();
      } catch {}
      leaderConnection = null;

      // Resume standby election retry loop to re-acquire when DB is available (#160)
      void scheduleElection();
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

function scheduleElection(delayMs = ELECTION_RETRY_DELAY_MS): void {
  if (shuttingDown || !config.WORKERS_ENABLED || workersStarted) return;
  if (electionTimer) clearTimeout(electionTimer);
  electionTimer = setTimeout(async () => {
    electionTimer = null;
    await attemptLeaderElection();
  }, delayMs);
}

async function attemptLeaderElection(): Promise<void> {
  if (shuttingDown || !config.WORKERS_ENABLED || workersStarted) return;
  const isLeader = await tryAcquireWorkerLeaderLock();
  if (isLeader) {
    startWorkers();
  } else {
    rootLogger.info(
      { event: "workers_election_retry" },
      "another instance holds the worker leader lock; standby retrying election after backoff (#160)",
    );
    scheduleElection();
  }
}

async function startWorkersIfLeader(): Promise<void> {
  if (!config.WORKERS_ENABLED) {
    rootLogger.info(
      { event: "workers_disabled" },
      "WORKERS_ENABLED is false; skipping background workers",
    );
    return;
  }
  await attemptLeaderElection();
}

const server: Server = app.listen(config.PORT, () => {
  rootLogger.info(
    {
      event: "server_start",
      port: config.PORT,
      network: config.NETWORK,
      healthUrl: `http://localhost:${config.PORT}/health`,
    },
    "SynapsVault server started",
  );

  startPoolMetrics();
  void startWorkersIfLeader();
});

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  if (electionTimer) {
    clearTimeout(electionTimer);
    electionTimer = null;
  }
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }

  stopWorkers();
  stopPoolMetrics();

  // Stop passing readiness checks so load balancers drain us before we close.
  beginShutdown();
  rootLogger.info(
    { event: "shutdown_start", signal, inFlight: inFlightCount() },
    "graceful shutdown started",
  );

  // Stop accepting new connections; existing ones keep being served.
  server.close();

  // Wait for in-flight requests to finish, bounded by the configured grace period.
  let timedOut = false;
  let drainTimer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<void>((resolve) => {
    drainTimer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, config.GRACEFUL_SHUTDOWN_TIMEOUT_MS);
  });

  await Promise.race([whenDrained(), deadline]);
  clearTimeout(drainTimer!);

  if (timedOut && inFlightCount() > 0) {
    rootLogger.warn(
      { event: "shutdown_drain_timeout", inFlight: inFlightCount() },
      "drain timed out with requests still in flight; forcing close",
    );
  }

  try {
    await closeRateLimitStore();
    await closeSignatureReplayStore();
    await releaseWorkerLeaderLock();
    await pgClient.end({ timeout: 5 });
    const forced = timedOut && inFlightCount() > 0;
    rootLogger.info({ event: "shutdown_complete", signal, forced }, "graceful shutdown complete");
    process.exit(forced ? 1 : 0);
  } catch (err) {
    rootLogger.error({ event: "shutdown_error", err }, "error closing database pool");
    process.exit(1);
  }
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  rootLogger.error({ event: "unhandled_rejection", reason }, "unhandled promise rejection");
  captureServerException(reason instanceof Error ? reason : new Error(String(reason)));
});

process.on("uncaughtException", (err) => {
  rootLogger.error({ event: "uncaught_exception", err }, "uncaught exception — flushing and exiting");
  captureServerException(err);
  // Flush Sentry with a short timeout so the event is delivered before we exit,
  // then always terminate with code 1 so the platform can restart the service.
  // We do not await inside a sync handler, so we use .then/.catch to ensure
  // exit is always called even if flush rejects.
  void import("@sentry/node").then(({ flush }) =>
    flush(2000).finally(() => process.exit(1)),
  ).catch(() => process.exit(1));
});
