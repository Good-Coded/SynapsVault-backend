/**
 * Upload temp-file sweep
 *
 * Multer stages uploads on disk and request cleanup removes them when the
 * response finishes, but a process crash bypasses that cleanup and leaves
 * orphaned files behind. This worker periodically removes only stale files
 * inside the dedicated upload temp directory (see uploadGuards.ts); files
 * still being written have fresh mtimes and are never touched, and nothing
 * outside the directory is ever removed.
 *
 * Runs only on the elected worker leader, like the other background sweeps.
 */
import { config } from "../config.js";
import { getLogger } from "../lib/logger.js";
import { sweepStaleUploadTempFiles } from "../middleware/uploadGuards.js";
import { recordWorkerPass } from "../lib/workerStatus.js";

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export function startUploadTempSweepWorker(intervalMs = config.UPLOAD_TEMP_SWEEP_INTERVAL_MS): void {
  if (intervalHandle) return; // starting twice must not create two timers

  getLogger().info(
    { event: "upload_temp_sweep_worker_start", intervalMs },
    "starting upload temp sweep worker",
  );
  void tick();
  intervalHandle = setInterval(() => void tick(), intervalMs);
}

export function stopUploadTempSweepWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const result = await sweepStaleUploadTempFiles();
    if (result.removed > 0 || result.errors > 0) {
      getLogger().info(
        { event: "upload_temp_sweep", ...result },
        "swept stale upload temp files",
      );
    }
    recordWorkerPass("uploadTempSweep");
  } catch (err) {
    getLogger().error(
      { err, event: "upload_temp_sweep_tick_error" },
      "upload temp sweep tick failed",
    );
  } finally {
    inFlight = false;
  }
}
