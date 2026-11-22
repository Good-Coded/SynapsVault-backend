/**
 * Idempotency expiry sweep (#173)
 *
 * `get(key)` only removes an idempotency record when a client retries that
 * exact key, so abandoned reservations and forgotten completed responses
 * would otherwise stay in `idempotency_records` forever. This worker deletes
 * them in bounded batches using the database's own clock, leaving every row
 * that is still live (an active reservation or an unexpired result) intact.
 *
 * The deleter is injected at the composition root (src/index.ts) so the
 * batching logic can be tested without a database and the worker does not own
 * a second Postgres connection pool.
 */
import { config } from "../config.js";
import { getLogger } from "../lib/logger.js";
import { recordWorkerPass } from "../lib/workerStatus.js";

/** Deletes one bounded batch of expired rows; resolves to the number deleted. */
export type DeleteExpiredRows = (batchSize: number) => Promise<number>;

export interface IdempotencyCleanupOptions {
  intervalMs?: number;
  batchSize?: number;
  maxBatchesPerTick?: number;
}

type ResolvedOptions = Required<IdempotencyCleanupOptions>;

// A large backlog is drained over several ticks rather than in one long run.
const MAX_BATCHES_PER_TICK = 20;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let deleter: DeleteExpiredRows | null = null;
let activeOptions: ResolvedOptions | null = null;

/**
 * Deletes expired rows in batches, stopping early at the first partial batch.
 * The work per call is capped at `maxBatchesPerTick * batchSize` rows.
 */
export async function sweepExpiredIdempotency(
  deleteBatch: DeleteExpiredRows,
  options: Pick<IdempotencyCleanupOptions, "batchSize" | "maxBatchesPerTick"> = {},
): Promise<number> {
  const batchSize = options.batchSize ?? config.IDEMPOTENCY_CLEANUP_BATCH_SIZE;
  const maxBatchesPerTick = options.maxBatchesPerTick ?? MAX_BATCHES_PER_TICK;
  let deletedTotal = 0;

  for (let batch = 0; batch < maxBatchesPerTick; batch += 1) {
    const deleted = await deleteBatch(batchSize);
    deletedTotal += deleted;
    // A short batch means the backlog for this tick is drained.
    if (deleted < batchSize) break;
  }

  return deletedTotal;
}

export function startIdempotencyCleanupWorker(
  deleteExpired: DeleteExpiredRows,
  options: IdempotencyCleanupOptions = {},
): void {
  if (intervalHandle) return; // starting twice must not create two timers

  deleter = deleteExpired;
  activeOptions = {
    intervalMs: options.intervalMs ?? config.IDEMPOTENCY_CLEANUP_INTERVAL_MS,
    batchSize: options.batchSize ?? config.IDEMPOTENCY_CLEANUP_BATCH_SIZE,
    maxBatchesPerTick: options.maxBatchesPerTick ?? MAX_BATCHES_PER_TICK,
  };

  getLogger().info(
    { event: "idempotency_cleanup_worker_start", ...activeOptions },
    "starting idempotency cleanup worker",
  );
  void tick();
  intervalHandle = setInterval(() => void tick(), activeOptions.intervalMs);
}

export function stopIdempotencyCleanupWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  deleter = null;
  activeOptions = null;
}

async function tick(): Promise<void> {
  if (inFlight || !deleter || !activeOptions) return;
  inFlight = true;
  try {
    const { batchSize, maxBatchesPerTick } = activeOptions;
    const deleted = await sweepExpiredIdempotency(deleter, { batchSize, maxBatchesPerTick });
    if (deleted > 0) {
      getLogger().info(
        { event: "idempotency_cleanup", deleted },
        "expired idempotency rows swept",
      );
    }
    recordWorkerPass("idempotencyCleanup");
  } catch (err) {
    getLogger().error(
      { err, event: "idempotency_cleanup_tick_error" },
      "idempotency cleanup tick failed",
    );
  } finally {
    inFlight = false;
  }
}
