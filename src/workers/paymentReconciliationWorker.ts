import { and, asc, eq, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { payments } from "../db/schema.js";
import { applySettlement } from "../lib/paymentSettlement.js";
import { getLogger } from "../lib/logger.js";
import { recordWorkerPass } from "../lib/workerStatus.js";

const INTERVAL_MS = 60_000;
const MIN_AGE_MS = 2 * 60_000;
// Pending rows with no settlement evidence after this long never settled
// (the response finish callback would have recorded it) and are failed.
const EXPIRY_MS = 30 * 60_000;
const BATCH_SIZE = 100;

let handle: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

/**
 * Bounded pass over stale pending payments (#191). Transitions use a
 * `status = 'pending'` guard, so reruns and concurrent workers never settle
 * a payment twice.
 */
export async function reconcilePendingPayments(now = Date.now()): Promise<number> {
  const rows = await db
    .select()
    .from(payments)
    .where(and(eq(payments.status, "pending"), lt(payments.paidAt, new Date(now - MIN_AGE_MS))))
    .orderBy(asc(payments.paidAt))
    .limit(BATCH_SIZE);

  let resolved = 0;
  for (const row of rows) {
    if (row.settlementTxHash) {
      // Authoritative evidence of settlement exists.
      const r = await applySettlement(row.id, {
        status: "settled",
        txHash: row.settlementTxHash,
        network: row.settlementNetwork,
        failureReason: null,
      });
      if (r) resolved++;
    } else if (row.paidAt.getTime() < now - EXPIRY_MS) {
      const r = await applySettlement(row.id, {
        status: "failed",
        txHash: null,
        network: null,
        failureReason: "settlement_unconfirmed",
      });
      if (r) resolved++;
    }
  }
  return resolved;
}

export function startPaymentReconciliationWorker(): void {
  if (handle) return;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const n = await reconcilePendingPayments();
      if (n > 0) getLogger().info({ event: "payments_reconciled", count: n }, "reconciled pending payments");
      recordWorkerPass("paymentReconciliation");
    } catch (err) {
      getLogger().error({ event: "payment_reconcile_failed", err }, "payment reconciliation failed");
    } finally {
      inFlight = false;
    }
  };
  handle = setInterval(() => void tick(), INTERVAL_MS);
  handle.unref?.();
  void tick();
}

export function stopPaymentReconciliationWorker(): void {
  if (handle) clearInterval(handle);
  handle = null;
}
