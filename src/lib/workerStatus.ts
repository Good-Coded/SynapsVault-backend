/**
 * Worker status registry (#217).
 *
 * Tracks whether this instance is the elected worker leader and when each
 * named worker last completed a pass successfully. The data is intentionally
 * kept in memory — it reflects the state of this process only and resets on
 * restart, which is the correct behaviour for a liveness/progress signal.
 *
 * Workers call recordWorkerPass() after each successful tick.
 * index.ts calls setWorkerLeader() when the advisory lock is acquired or
 * released.
 */

export type WorkerName =
  | "retryPending"
  | "paymentReconciliation"
  | "eventListener"
  | "webhookOutbox"
  | "idempotencyCleanup"
  | "uploadTempSweep";

export interface WorkerInfo {
  /** ISO-8601 timestamp of the last completed pass, or null if never run. */
  lastSuccessAt: string | null;
}

let isLeader = false;
const workerLastSuccess = new Map<WorkerName, string>();

/** Called by index.ts when this instance acquires the advisory lock. */
export function setWorkerLeader(leader: boolean): void {
  isLeader = leader;
  if (!leader) {
    // Standby instances have no pass history to report.
    workerLastSuccess.clear();
  }
}

/** Called by each worker after a successful tick/pass. */
export function recordWorkerPass(name: WorkerName): void {
  workerLastSuccess.set(name, new Date().toISOString());
}

/** Returns the current leader flag and per-worker last-success timestamps. */
export function getWorkerStatus(): {
  isLeader: boolean;
  workers: Record<WorkerName, WorkerInfo>;
} {
  const ALL_WORKERS: WorkerName[] = [
    "retryPending",
    "paymentReconciliation",
    "eventListener",
    "webhookOutbox",
    "idempotencyCleanup",
    "uploadTempSweep",
  ];

  const workers = Object.fromEntries(
    ALL_WORKERS.map((name) => [
      name,
      { lastSuccessAt: workerLastSuccess.get(name) ?? null },
    ]),
  ) as Record<WorkerName, WorkerInfo>;

  return { isLeader, workers };
}
