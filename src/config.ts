import "dotenv/config";
import { z } from "zod/v4";
import { StrKey } from "@stellar/stellar-sdk";
// Inlined from @synapsvault/registry-client (local package — avoids runtime resolution issues)
type StellarDeploymentNetwork = "testnet" | "mainnet";

const NETWORK_PRESETS = {
  testnet: {
    x402Network: "stellar:testnet",
    networkPassphrase: "Test SDF Network ; September 2015",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    usdcSacContractId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  },
  mainnet: {
    x402Network: "stellar:pubnet",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    sorobanRpcUrl: "https://soroban.stellar.org",
    horizonUrl: "https://horizon.stellar.org",
    usdcSacContractId: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  },
} as const;

// Recognized STELLAR_NETWORK aliases. Any other nonempty value is rejected at
// boot so a misspelled value (e.g. "tsetnet") can't silently select testnet (#210).
const STELLAR_NETWORK_ALIASES: Record<string, StellarDeploymentNetwork> = {
  testnet: "testnet",
  mainnet: "mainnet",
  pubnet: "mainnet",
  public: "mainnet",
};

function resolveStellarNetwork(value: string | undefined): StellarDeploymentNetwork {
  // Missing/empty values keep the documented default (testnet).
  if (value === undefined) return "testnet";
  const v = value.trim().toLowerCase();
  if (v === "") return "testnet";
  const resolved = STELLAR_NETWORK_ALIASES[v];
  if (resolved) return resolved;
  throw new Error(
    `STELLAR_NETWORK="${value}" is not a recognized Stellar network. ` +
      `Use one of: testnet, mainnet, pubnet, public.`,
  );
}

function cleanEnvValue(value: string): string {
  const trimmed = value.trim();
  const quoted = trimmed.match(/^(["'])(.*)\1$/s);
  return (quoted ? quoted[2]! : trimmed).trim();
}

/** Public URLs commonly entered without a scheme (e.g. "app.vercel.app"). */
const SCHEME_DEFAULTED_URLS = ["WEB_APP_URL", "BASE_URL", "SUPABASE_URL", "SOROBAN_RPC_URL"] as const;

const stellarSecret = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .min(1, `${name} is required`)
    .refine(StrKey.isValidEd25519SecretSeed, `${name} must be a Stellar secret key (starts with S, 56 chars)`);

const stellarAccount = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .min(1, `${name} is required`)
    .refine(StrKey.isValidEd25519PublicKey, `${name} must be a Stellar public key (starts with G, 56 chars)`);

const stellarContract = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .min(1, `${name} is required`)
    .refine(StrKey.isValidContract, `${name} must be a Soroban contract id (starts with C, 56 chars)`);

const httpUrl = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .refine((v) => /^https?:\/\//i.test(v) && URL.canParse(v), `${name} must be an http(s) URL`);

function applyNetworkEnvDefaults(rawEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Hosting dashboards (Railway, Vercel) make it easy to save a variable with
  // an empty value; treat those as unset so defaults apply and optional URL
  // fields (REDIS_URL, SENTRY_DSN) don't fail validation and crash the boot.
  // Values pasted with surrounding quotes or whitespace are cleaned up too.
  const env = Object.fromEntries(
    Object.entries(rawEnv)
      .map(([key, value]) => [key, value === undefined ? value : cleanEnvValue(value)] as const)
      .filter(([, value]) => value !== ""),
  ) as NodeJS.ProcessEnv;
  for (const key of SCHEME_DEFAULTED_URLS) {
    const value = env[key];
    if (value && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) env[key] = `https://${value}`;
  }
  const network = resolveStellarNetwork(env.STELLAR_NETWORK);
  const preset = NETWORK_PRESETS[network];

  // REGISTRY_CONTRACT_ID and VAULT_REGISTRY_CONTRACT_ID are aliases for the same
  // contract. When both are set they must agree, otherwise components reading
  // different names could be pointed at different registries (#213).
  const registryId = env.REGISTRY_CONTRACT_ID;
  const vaultRegistryId = env.VAULT_REGISTRY_CONTRACT_ID;
  if (registryId && vaultRegistryId && registryId !== vaultRegistryId) {
    throw new Error(
      `REGISTRY_CONTRACT_ID and VAULT_REGISTRY_CONTRACT_ID are both set but differ ` +
        `(${registryId} vs ${vaultRegistryId}). These are aliases for the same ` +
        `vault-registry contract; set only one or use the same value.`,
    );
  }

  return {
    ...env,
    STELLAR_NETWORK: network,
    NETWORK: env.NETWORK ?? preset.x402Network,
    SOROBAN_RPC_URL: env.SOROBAN_RPC_URL ?? preset.sorobanRpcUrl,
    USDC_CONTRACT_ID: env.USDC_CONTRACT_ID ?? preset.usdcSacContractId,
    // Accept Supabase's own name for the key (used by docker-compose and CI).
    SUPABASE_SERVICE_KEY: env.SUPABASE_SERVICE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY,
    // Both names refer to the same vault-registry contract; accept either.
    REGISTRY_CONTRACT_ID: env.REGISTRY_CONTRACT_ID ?? env.VAULT_REGISTRY_CONTRACT_ID,
    VAULT_REGISTRY_CONTRACT_ID: env.VAULT_REGISTRY_CONTRACT_ID ?? env.REGISTRY_CONTRACT_ID,
  };
}

interface NetworkValidationIssue {
  field: string;
  message: string;
}

function inferNetworkFromX402(network: string): StellarDeploymentNetwork | undefined {
  const normalized = network.trim();
  if (normalized === "stellar:testnet") return "testnet";
  if (normalized === "stellar:pubnet" || normalized === "stellar:mainnet") return "mainnet";
  return undefined;
}

function inferNetworkFromRpcUrl(rpcUrl: string): StellarDeploymentNetwork | undefined {
  try {
    const host = new URL(rpcUrl).hostname.toLowerCase();
    if (host.includes("testnet")) return "testnet";
    if (host === "soroban.stellar.org" || host === "mainnet.sorobanrpc.com") return "mainnet";
  } catch {
    // invalid URL — reported below
  }
  return undefined;
}

/**
 * Catches cross-network misconfiguration (e.g. mainnet x402 network with a
 * testnet RPC). Custom RPC hosts whose network can't be inferred are allowed.
 */
function validateNetworkConfig(input: {
  stellarNetwork: StellarDeploymentNetwork;
  x402Network: string;
  sorobanRpcUrl: string;
}): NetworkValidationIssue[] {
  const issues: NetworkValidationIssue[] = [];

  const x402Network = inferNetworkFromX402(input.x402Network);
  if (!x402Network) {
    issues.push({
      field: "NETWORK",
      message: `Unsupported x402 network "${input.x402Network}". Use stellar:testnet or stellar:pubnet.`,
    });
  } else if (x402Network !== input.stellarNetwork) {
    issues.push({
      field: "NETWORK",
      message: `NETWORK=${input.x402Network} does not match STELLAR_NETWORK=${input.stellarNetwork}.`,
    });
  }

  if (!URL.canParse(input.sorobanRpcUrl)) {
    issues.push({ field: "SOROBAN_RPC_URL", message: "SOROBAN_RPC_URL is not a valid URL." });
  } else {
    const rpcNetwork = inferNetworkFromRpcUrl(input.sorobanRpcUrl);
    if (rpcNetwork && rpcNetwork !== input.stellarNetwork) {
      issues.push({
        field: "SOROBAN_RPC_URL",
        message: `SOROBAN_RPC_URL points to ${rpcNetwork} but STELLAR_NETWORK=${input.stellarNetwork}.`,
      });
    }
  }

  return issues;
}

/** Parses "true"/"false"/"1"/"0" env flags (z.coerce.boolean treats "false" as true). */
const envFlag = (defaultValue: boolean) =>
  z
    .enum(["true", "false", "1", "0", "yes", "no", ""])
    .optional()
    .transform((v) => (v === undefined || v === "" ? defaultValue : v === "true" || v === "1" || v === "yes"));
import { rootLogger } from "./lib/logger.js";

/**
 * Boot-time checks for the shared replay-protection policy. Returns warnings
 * for configurations that silently weaken cross-replica replay guarantees.
 */
export function replayProtectionWarnings(input: {
  NODE_ENV: string;
  REQUIRE_REQUEST_SIGNATURE: boolean;
  REDIS_URL?: string;
  REPLAY_PROTECTION_FAILURE_MODE: "closed" | "open";
}): string[] {
  if (input.NODE_ENV !== "production" || !input.REQUIRE_REQUEST_SIGNATURE) return [];
  if (!input.REDIS_URL) {
    return [
      "REDIS_URL is not set — request-signature replay protection is per-process and " +
        "only holds for a single replica. Set REDIS_URL when running more than one instance.",
    ];
  }
  if (input.REPLAY_PROTECTION_FAILURE_MODE === "open") {
    return [
      "REPLAY_PROTECTION_FAILURE_MODE=open — during a Redis outage signed mutations fall " +
        "back to per-process replay checks, so a signature can be replayed against another " +
        "replica. Use \"closed\" unless availability matters more than replay safety.",
    ];
  }
  return [];
}

let envWithDefaults: NodeJS.ProcessEnv;
try {
  envWithDefaults = applyNetworkEnvDefaults(process.env);
} catch (err) {
  // Pre-schema validation errors (e.g. an unrecognized STELLAR_NETWORK alias
  // or conflicting registry contract aliases). Surface them with the same
  // `[config] <name>: ...` format as schema failures and stop the boot (#210, #213).
  const message = err instanceof Error ? err.message : String(err);
  rootLogger.error({ event: "config_invalid", error: message }, "invalid environment variables");
  console.error(`[config] ${message}`);
  process.exit(1);
}

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4021),
  TRUST_PROXY: z.coerce.number().int().nonnegative().optional(),
  BASE_URL: z.string().default("http://localhost:4021"),
  WEB_APP_URL: z.string().url().or(z.literal("")).default("http://localhost:5173"),
  ALLOWED_ORIGINS: z.string().optional(),

  // Stellar / x402 — STELLAR_NETWORK selects preset defaults; individual vars may override.
  STELLAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  NETWORK: z.string().min(1),
  FACILITATOR_URL: httpUrl("FACILITATOR_URL").default("https://www.x402.org/facilitator"),
  PAY_TO: stellarAccount("PAY_TO (platform wallet address)"),
  AGENT_SECRET_KEY: stellarSecret("AGENT_SECRET_KEY (platform agent secret)"),
  USDC_CONTRACT_ID: stellarContract("USDC_CONTRACT_ID"),

  // Soroban / vault-registry
  SOROBAN_RPC_URL: z.string().min(1, "SOROBAN_RPC_URL is required"),
  VAULT_REGISTRY_CONTRACT_ID: stellarContract("VAULT_REGISTRY_CONTRACT_ID / REGISTRY_CONTRACT_ID"),

  // OpenRouter
  OPENROUTER_API_KEY: z.string().min(1, "OPENROUTER_API_KEY is required"),
  OPENROUTER_MODEL: z.string().default("anthropic/claude-sonnet-4"),

  // Supabase
  DATABASE_URL: z
    .string({ error: "DATABASE_URL (Postgres connection string) is required" })
    .refine(
      (v) => /^postgres(ql)?:\/\//i.test(v) && URL.canParse(v),
      "DATABASE_URL must be a postgres:// or postgresql:// URL (URL-encode special characters in the password)",
    ),
  SUPABASE_URL: httpUrl("SUPABASE_URL"),
  SUPABASE_SERVICE_KEY: z.string().min(1, "SUPABASE_SERVICE_KEY is required"),
  SUPABASE_STORAGE_BUCKET: z.string().default("resources"),
  // When set, uploaded files are sent as application/octet-stream to this
  // scanner endpoint, which returns JSON { "verdict": "clean" | "infected" }.
  FILE_SCANNER_URL: z.string().url().optional(),
  FILE_SCANNER_API_KEY: z.string().optional(),
  FILE_SCANNER_TIMEOUT_MS: z.coerce.number().int().min(1).max(600000).default(30000),

  // Limits
  MAX_FILE_SIZE_MB: z.coerce.number().int().min(1).max(10240).default(50),
  // Max multipart uploads processed at once; excess requests get 503 (#90).
  MAX_CONCURRENT_UPLOADS: z.coerce.number().int().min(1).max(1000).default(4),
  // Explicit JSON body limit for express.json() (e.g. "1mb", "512kb").
  MAX_JSON_BODY_SIZE: z.string().default("1mb"),
  // Comma-separated allowlist of accepted upload content types (#87).
  ALLOWED_UPLOAD_MIME_TYPES: z
    .string()
    .default(
      "application/pdf,image/png,image/jpeg,image/gif,image/webp,text/plain,text/markdown,application/json,application/zip,video/mp4,audio/mpeg",
    ),
  // Dedicated directory for multer disk-staged upload temp files. Defaults to
  // a subdirectory of the OS temp dir so the crash-recovery sweep can tell
  // app-owned files apart from unrelated temp files.
  UPLOAD_TEMP_DIR: z.string().min(1).optional(),
  // A temp file is only swept once its mtime is older than this, so uploads
  // still in flight are never removed.
  UPLOAD_TEMP_MAX_AGE_MS: z.coerce.number().int().min(60_000).max(604_800_000).default(3_600_000),
  UPLOAD_TEMP_SWEEP_INTERVAL_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(300_000),

  // Soroban registry
  REGISTRY_CONTRACT_ID: stellarContract("REGISTRY_CONTRACT_ID / VAULT_REGISTRY_CONTRACT_ID"),
  REGISTRY_SECRET_KEY: stellarSecret("REGISTRY_SECRET_KEY (deployer / owner secret)"),

  // Metrics endpoint token — if set, requests to /metrics must supply it via
  // Bearer auth. If unset, the endpoint is disabled.
  METRICS_TOKEN: z.string().optional(),

  // Sentry error tracking — when DSN is set, unhandled errors are reported.
  SENTRY_DSN: z.string().url().optional().or(z.literal("")),

  // Verification
  VERIFICATION_PRICE: z.string().default("0.10"),
  // Hard deadline for the verification model call, in ms (#184).
  VERIFICATION_TIMEOUT_MS: z.coerce.number().int().min(1).max(600000).default(30000),
  // OpenRouter token pricing (USD per 1M tokens) used to estimate the cost of
  // each verification (#283). Defaults track anthropic/claude-sonnet-4 list
  // pricing; override per model if you change OPENROUTER_MODEL.
  VERIFICATION_PROMPT_COST_PER_1M: z.coerce.number().nonnegative().max(1_000_000).default(3),
  VERIFICATION_COMPLETION_COST_PER_1M: z.coerce.number().nonnegative().max(1_000_000).default(15),
  // Daily budget (USD) for paid verification spend across all publishers (#186).
  // Spend is reserved before the model call and settled afterwards; requests
  // that would push the day's reserved + consumed spend over this limit are
  // rejected with 429 before any provider cost is incurred. Set to 0 to
  // disable paid verification entirely.
  VERIFICATION_DAILY_SPEND_LIMIT_USD: z.coerce.number().nonnegative().max(1_000_000).default(50),

  // Rate limiting (verify-content + publish). Counts are positive integers;
  // windows are positive integer milliseconds up to 24h.
  RATE_LIMIT_REGISTER_IP_MAX: z.coerce.number().int().min(1).max(1_000_000).default(10),
  RATE_LIMIT_REGISTER_IP_WINDOW_MS: z.coerce.number().int().min(1).max(86_400_000).default(3_600_000),
  RATE_LIMIT_VERIFY_IP_MAX: z.coerce.number().int().min(1).max(1_000_000).default(10),
  RATE_LIMIT_VERIFY_IP_WINDOW_MS: z.coerce.number().int().min(1).max(86_400_000).default(60_000),
  RATE_LIMIT_VERIFY_WALLET_MAX: z.coerce.number().int().min(1).max(1_000_000).default(5),
  RATE_LIMIT_VERIFY_WALLET_WINDOW_MS: z.coerce.number().int().min(1).max(86_400_000).default(3_600_000),
  RATE_LIMIT_PUBLISH_IP_MAX: z.coerce.number().int().min(1).max(1_000_000).default(20),
  RATE_LIMIT_PUBLISH_IP_WINDOW_MS: z.coerce.number().int().min(1).max(86_400_000).default(60_000),
  RATE_LIMIT_PUBLISH_WALLET_MAX: z.coerce.number().int().min(1).max(1_000_000).default(10),
  RATE_LIMIT_PUBLISH_WALLET_WINDOW_MS: z.coerce.number().int().min(1).max(86_400_000).default(3_600_000),

  // Publisher rate limiting defaults (per publisher, requests per minute).
  PUBLISHER_RATE_LIMIT_RPM_DEFAULT: z.coerce.number().int().min(1).max(1_000_000).default(60),
  PUBLISHER_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1).max(86_400_000).default(60_000),
  PUBLISHER_RATE_LIMIT_MAX_RPM: z.coerce.number().int().min(1).max(1_000_000).default(10_000),

  // Webhook delivery
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1).max(300000).default(10_000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
  // Configurable retention policy for terminal outbox rows (#157). 0 keeps rows indefinitely.
  WEBHOOK_OUTBOX_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(7),
  WEBHOOK_OUTBOX_CLEANUP_BATCH_SIZE: z.coerce.number().int().min(1).max(10000).default(100),

  // Retry worker (#85): max items processed per tick and per-item timeout so a
  // slow RPC can't make a tick run into the next one.
  RETRY_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(10000).default(25),
  RETRY_WORKER_ITEM_TIMEOUT_MS: z.coerce.number().int().min(1).max(600000).default(30_000),

  // Optional Redis URL for a shared sliding-window rate-limit store (multi-instance).
  REDIS_URL: z.string().url().optional(),
  // Max time a signed mutation waits for the shared replay-cache Redis
  // connection to become ready (cold start / reconnect) before the replay
  // check gives up on Redis. Also the socket connect timeout.
  REPLAY_REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1).max(30_000).default(2_000),
  // What signed mutations do when REDIS_URL is set but Redis cannot answer
  // the replay check (outage, timeout, cold start past the bound):
  //   closed — reject with 503; cross-replica replay guarantee always holds,
  //            but signed mutations are unavailable during the outage.
  //   open   — fall back to the per-process cache; mutations stay available
  //            but a signature may be replayed once per other replica.
  // Defaults to "closed" in production, "open" elsewhere.
  REPLAY_PROTECTION_FAILURE_MODE: z
    .enum(["closed", "open"])
    .default(
      typeof process !== "undefined" && (process.env.NODE_ENV ?? "development") === "production"
        ? "closed"
        : "open",
    ),

  // Background workers (event listener + retry worker). When multiple replicas
  // run, only one should execute them: either set WORKERS_ENABLED=false on all
  // but one instance, or leave it true everywhere and let the Postgres advisory
  // lock (WORKER_LEADER_LOCK_ID) elect a single leader.
  WORKERS_ENABLED: envFlag(true),
  // Advisory lock key used to elect the single worker leader across replicas.
  WORKER_LEADER_LOCK_ID: z.coerce.number().int().default(4_021_001),

  // AES-256 key used to encrypt per-publisher signing secrets at rest (#42).
  // Required when REQUIRE_REQUEST_SIGNATURE is true.
  SIGNING_SECRET_KEY: z.string().min(16).optional(),
  // Comma-separated retired signing-secret keys kept for decryption only
  // during a key rotation. New ciphertext always uses SIGNING_SECRET_KEY;
  // run `npm run secrets:reencrypt` and then drop the old key from this list.
  SIGNING_SECRET_LEGACY_KEYS: z.string().optional(),

  // AES-256 key used to encrypt webhook secrets at rest (#47).
  // When unset, webhook secret writes are rejected if
  // WEBHOOK_SECRET_ENCRYPTION_REQUIRED is on; otherwise they are stored as
  // plain text (logged as a warning).
  WEBHOOK_ENCRYPTION_KEY: z.string().min(16).optional(),
  // Comma-separated retired webhook encryption keys (decrypt-only), see
  // SIGNING_SECRET_LEGACY_KEYS for the rotation procedure.
  WEBHOOK_ENCRYPTION_LEGACY_KEYS: z.string().optional(),
  // Refuse to store new webhook secrets unless WEBHOOK_ENCRYPTION_KEY is set.
  // Defaults to true in production; false elsewhere. Existing plaintext rows
  // keep working — see docs/secret-key-rotation.md#plaintext-rows.
  WEBHOOK_SECRET_ENCRYPTION_REQUIRED: envFlag(
    typeof process !== "undefined" && (process.env.NODE_ENV ?? "development") === "production",
  ),

  // Admin panel protection key (#49). Optional — when unset admin routes are
  // disabled (return 401) and a warning is logged at boot.
  ADMIN_API_KEY: z.string().min(1).optional(),

  // HMAC-SHA256 request signatures for publisher mutations.
  // Defaults to true in production; false elsewhere. Override with env var.
  REQUIRE_REQUEST_SIGNATURE: envFlag(
    typeof process !== "undefined" && (process.env.NODE_ENV ?? "development") === "production"
      ? true
      : false
  ),
  // Legacy register flow where the server signs with the platform registry key
  // on the creator's behalf (#80). Off by default; clients must send signedXdr.
  ALLOW_LEGACY_REGISTER: envFlag(false),
  // Max clock skew for X-Timestamp when signatures are required (default 5 minutes).
  SIGNATURE_MAX_SKEW_MS: z.coerce.number().int().min(1).max(3_600_000).default(300_000),

  // Per-request timeout — slow upstreams (RPC, facilitator) return 503 instead
  // of hanging the connection.
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).max(600000).default(30_000),
  // Max time to drain in-flight requests on SIGTERM/SIGINT before forcing exit.
  // 0 skips the drain and exits immediately.
  GRACEFUL_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).max(300000).default(10_000),
  // How long a publish Idempotency-Key is remembered so retries return the
  // original result instead of creating a duplicate (default 24h).
  IDEMPOTENCY_TTL_MS: z.coerce.number().int().min(1).max(604_800_000).default(86_400_000),
  // Bounded background sweep of expired idempotency rows (#173). Batch size
  // caps rows deleted per statement; the interval caps how often the sweep runs.
  IDEMPOTENCY_CLEANUP_BATCH_SIZE: z.coerce.number().int().min(1).max(10000).default(100),
  IDEMPOTENCY_CLEANUP_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  // Short-lived cache for catalog/preview reads to cut DB load. Kept low so
  // newly published/delisted resources surface quickly. 0 disables caching.
  CATALOG_CACHE_TTL_MS: z.coerce.number().int().min(0).max(3_600_000).default(10_000),
  // Max distinct filter/sort/pagination combinations cached for the catalog
  // (#316). Bounds key cardinality; oldest entries are evicted (FIFO).
  CATALOG_CACHE_MAX_KEYS: z.coerce.number().int().min(1).max(100000).default(200),

  // Readiness probe tuning (#216). Independent of REQUEST_TIMEOUT_MS so the
  // probe can be tuned without changing the application request deadline.
  // Default timeout is 2 s — fast enough to satisfy a load-balancer health
  // check without exhausting the per-request 30 s budget.
  READINESS_PROBE_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),
  // How long a probe result is reused before the next live check. Keeps
  // frequent readiness polls from hammering the database and RPC.
  READINESS_PROBE_CACHE_TTL_MS: z.coerce.number().int().min(100).max(60_000).default(3_000),

  // Postgres connection pool tuning.
  DB_POOL_MAX: z.coerce.number().int().min(1).max(1000).default(10),
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().min(0).max(600000).default(30_000),
  DB_POOL_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(0).max(600000).default(10_000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).max(600000).default(30_000),
});

/** Every environment variable the schema validates (kept in sync with .env.example). */
export const CONFIG_KEYS = Object.keys(envSchema.shape) as (keyof typeof envSchema.shape)[];

// In production the localhost defaults would leak into accessUrl values and the
// CORS allowlist, so both URLs must be set explicitly.
if (envWithDefaults.NODE_ENV === "production") {
  const missing = (["BASE_URL", "WEB_APP_URL"] as const).filter((k) => !envWithDefaults[k]?.trim());
  if (missing.length > 0) {
    for (const key of missing) {
      console.error(`[config] ${key}: required when NODE_ENV=production (no localhost default is applied)`);
    }
    process.exit(1);
  }
}

const parsed = envSchema.safeParse(envWithDefaults);

if (!parsed.success) {
  rootLogger.error(
    { event: "config_invalid", issues: parsed.error.format() },
    "invalid environment variables",
  );
  // Plain-text summary so the offending variables are obvious in host logs.
  for (const issue of parsed.error.issues) {
    console.error(`[config] ${issue.path.join(".") || "(env)"}: ${issue.message}`);
  }
  process.exit(1);
}

const stellarNetwork = resolveStellarNetwork(parsed.data.STELLAR_NETWORK);
const networkIssues = validateNetworkConfig({
  stellarNetwork,
  x402Network: parsed.data.NETWORK,
  sorobanRpcUrl: parsed.data.SOROBAN_RPC_URL,
});

if (networkIssues.length > 0) {
  rootLogger.error(
    { event: "config_network_mismatch", issues: networkIssues },
    "inconsistent Stellar network configuration",
  );
  for (const issue of networkIssues) {
    console.error(`[config] ${issue.field}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;

// ── Boot-time security warnings (#44) ────────────────────────────────────────
if (parsed.data.NODE_ENV === "production" && !parsed.data.REQUIRE_REQUEST_SIGNATURE) {
  rootLogger.warn(
    { event: "config_signature_disabled" },
    "[security] REQUIRE_REQUEST_SIGNATURE is off in production — publisher mutation " +
    "endpoints accept a bare API key without a signed request. Set " +
    "REQUIRE_REQUEST_SIGNATURE=true and SIGNING_SECRET_KEY to enforce HMAC-signed " +
    "requests (#44).",
  );
  console.warn(
    "[config] WARNING: REQUIRE_REQUEST_SIGNATURE=false in production. " +
    "Publisher mutations are not protected by HMAC signatures. " +
    "Set REQUIRE_REQUEST_SIGNATURE=true and SIGNING_SECRET_KEY to fix this (#44).",
  );
}

if (parsed.data.REQUIRE_REQUEST_SIGNATURE && !parsed.data.SIGNING_SECRET_KEY) {
  rootLogger.error(
    { event: "config_signing_key_missing" },
    "SIGNING_SECRET_KEY is required when REQUIRE_REQUEST_SIGNATURE=true (#42).",
  );
  console.error(
    "[config] SIGNING_SECRET_KEY: required when REQUIRE_REQUEST_SIGNATURE=true (#42)",
  );
  process.exit(1);
}

// ── Replay-protection policy validation ──────────────────────────────────────
for (const warning of replayProtectionWarnings(parsed.data)) {
  rootLogger.warn({ event: "config_replay_protection", warning }, `[security] ${warning}`);
  console.warn(`[config] WARNING: ${warning}`);
}

// ── Boot-time security warnings (#49) ────────────────────────────────────────
if (!parsed.data.ADMIN_API_KEY) {
  rootLogger.warn(
    { event: "config_admin_key_missing" },
    "[security] ADMIN_API_KEY is not set — admin routes (/admin/stats, /admin/audit, " +
    "/admin/delist) are disabled and will return 401. Set ADMIN_API_KEY to a strong " +
    "random secret to enable them (#49).",
  );
  console.warn(
    "[config] WARNING: ADMIN_API_KEY is not set. Admin routes are disabled. " +
    "Set ADMIN_API_KEY to enable them (#49).",
  );
}

// ── Boot-time security warnings (#47) ────────────────────────────────────────
if (!parsed.data.WEBHOOK_ENCRYPTION_KEY && parsed.data.WEBHOOK_SECRET_ENCRYPTION_REQUIRED) {
  rootLogger.error(
    { event: "config_webhook_encryption_required_key_missing" },
    "[security] WEBHOOK_SECRET_ENCRYPTION_REQUIRED is on but WEBHOOK_ENCRYPTION_KEY is not " +
    "set — requests that store a webhook secret will be rejected with 503. Webhooks " +
    "without a secret and existing rows are unaffected.",
  );
  console.error(
    "[config] WEBHOOK_ENCRYPTION_KEY: not set while WEBHOOK_SECRET_ENCRYPTION_REQUIRED=true; " +
    "webhook secret writes will be rejected.",
  );
} else if (!parsed.data.WEBHOOK_ENCRYPTION_KEY) {
  rootLogger.warn(
    { event: "config_webhook_encryption_key_missing" },
    "[security] WEBHOOK_ENCRYPTION_KEY is not set — webhook secrets will be stored " +
    "as plain text in the database. Set WEBHOOK_ENCRYPTION_KEY to a strong random " +
    "secret to encrypt them at rest (#47).",
  );
  console.warn(
    "[config] WARNING: WEBHOOK_ENCRYPTION_KEY is not set. " +
    "Webhook secrets are stored in plain text. Set WEBHOOK_ENCRYPTION_KEY to fix this (#47).",
  );
}