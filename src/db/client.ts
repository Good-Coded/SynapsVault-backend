import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";
import { rootLogger } from "../lib/logger.js";
import { dbPoolTotal } from "../lib/metrics.js";
import * as schema from "./schema.js";

// ── #214: Locality via URL.hostname ─────────────────────────────────────────
// Use the parsed hostname to decide whether the connection is local so that a
// remote host, username or database name that contains "localhost" or
// "127.0.0.1" as a substring can never accidentally disable TLS.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function isLoopbackUrl(urlString: string): boolean {
  try {
    const { hostname } = new URL(urlString);
    return LOOPBACK_HOSTS.has(hostname.toLowerCase());
  } catch {
    return false;
  }
}

// ── #215: Supported DATABASE_URL query options ───────────────────────────────
// Supported options and their precedence rules:
//
//   sslmode — explicitly handled; "disable" / "allow" / "prefer" permit no-TLS
//             on loopback only (for local dev convenience). "require" keeps
//             rejectUnauthorized:true. "verify-ca" / "verify-full" also keep
//             rejectUnauthorized:true. Any value that would disable certificate
//             verification on a non-loopback host is rejected at startup.
//
// All other query parameters (application_name, options, etc.) are silently
// stripped because postgres.js does not forward URL query params and they
// must be set via the config object. Document additional params here as needed.
type SslMode =
  | "disable"
  | "allow"
  | "prefer"
  | "require"
  | "verify-ca"
  | "verify-full";

function parseSslMode(urlString: string): SslMode | null {
  try {
    const { searchParams } = new URL(urlString);
    const raw = searchParams.get("sslmode");
    if (!raw) return null;
    return raw as SslMode;
  } catch {
    return null;
  }
}

/** Strip the query string to get a clean URL for postgres.js. */
function stripQueryString(urlString: string): string {
  try {
    const u = new URL(urlString);
    u.search = "";
    return u.toString();
  } catch {
    return urlString;
  }
}

const rawUrl = config.DATABASE_URL;
const dbUrl = stripQueryString(rawUrl);
const isLocal = isLoopbackUrl(rawUrl);
const explicitSslMode = parseSslMode(rawUrl);

// Reject unsafe sslmode overrides on remote hosts (#215).
const INSECURE_MODES: SslMode[] = ["disable", "allow", "prefer"];
if (!isLocal && explicitSslMode && INSECURE_MODES.includes(explicitSslMode)) {
  const msg =
    `DATABASE_URL sslmode="${explicitSslMode}" disables certificate verification ` +
    `for a non-loopback host. Use sslmode=require, verify-ca, or verify-full.`;
  rootLogger.error({ event: "db_config_insecure_sslmode", sslmode: explicitSslMode }, msg);
  console.error(`[config] ${msg}`);
  process.exit(1);
}

// Determine the effective SSL setting.
// - Local connections: no TLS unless the caller explicitly requests it via
//   sslmode=require / verify-ca / verify-full.
// - Remote connections: TLS with certificate verification by default; a
//   private CA can be supplied via DATABASE_CA_CERT.
const caCert = process.env.DATABASE_CA_CERT?.replace(/\\n/g, "\n");

function resolvessl():
  | false
  | { rejectUnauthorized: boolean; ca?: string } {
  if (isLocal && (!explicitSslMode || INSECURE_MODES.includes(explicitSslMode as SslMode))) {
    return false;
  }
  // require / verify-ca / verify-full (or remote with no sslmode):
  return { rejectUnauthorized: true, ...(caCert ? { ca: caCert } : {}) };
}

// Log sanitized URL for debugging (hide password).
const sanitizedUrl = dbUrl.replace(/:([^:@]+)@/, ":***@");
rootLogger.info({ url: sanitizedUrl, ssl: resolvessl() !== false, isLocal }, "DB connecting");

const client = postgres(dbUrl, {
  ssl: resolvessl(),
  max: config.DB_POOL_MAX,
  // postgres.js takes these two in seconds; config is in milliseconds.
  idle_timeout: Math.ceil(config.DB_POOL_IDLE_TIMEOUT_MS / 1000),
  connect_timeout: Math.ceil(config.DB_POOL_CONNECT_TIMEOUT_MS / 1000),
  connection: {
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
  },
  transform: { undefined: null },
});

client`SELECT current_database() as db, current_schema() as schema`.then((rows) => {
  rootLogger.info({ db: rows[0]?.db, schema: rows[0]?.schema }, "DB connected OK");
}).catch((err: unknown) => {
  const e = err as Record<string, unknown>;
  rootLogger.error({
    message: String(e?.message ?? ""),
    code: String(e?.code ?? ""),
    detail: String(e?.detail ?? ""),
    hint: String(e?.hint ?? ""),
    url: sanitizedUrl,
  }, "DB connection FAILED");
});

export const db = drizzle(client, { schema });
export const pgClient = client;

let poolLogInterval: ReturnType<typeof setInterval> | undefined;

export function startPoolMetrics(intervalMs = 30_000): void {
  if (poolLogInterval) return;
  poolLogInterval = setInterval(() => {
    dbPoolTotal.set(config.DB_POOL_MAX);
    rootLogger.debug({ event: "db_pool_stats", max: config.DB_POOL_MAX }, "DB pool stats");
  }, intervalMs);
  poolLogInterval.unref?.();
}

export function stopPoolMetrics(): void {
  if (poolLogInterval) {
    clearInterval(poolLogInterval);
    poolLogInterval = undefined;
  }
}
