/**
 * Configuration is validated once at boot and the process exits non-zero on
 * anything missing or nonsensical. A job that starts with bad config and fails
 * silently at 00:30 is strictly worse than one that refuses to start.
 */
import { z } from 'zod';

const int = (def?: number) =>
  def === undefined
    ? z.coerce.number().int()
    : z.coerce.number().int().default(def);

const ConfigSchema = z.object({
  // ---- COSEC (source) ----------------------------------------------------
  COSEC_BASE_URL: z.string().url(),
  COSEC_USERNAME: z.string().min(1),
  COSEC_PASSWORD: z.string().min(1),
  COSEC_TIMEOUT_MS: int(30_000),
  /** COSEC report template to pull. UAT uses 133. */
  COSEC_TEMPLATE_ID: z.string().min(1).default('133'),

  // ---- COSEC field mapping ------------------------------------------------
  // Production may use a different template with different column names and a
  // different date format. All of it is configuration: adapting is an .env
  // change plus `npm run doctor`, not a code change. See src/cosec-fields.ts.

  /** JSON property wrapping the row array. */
  COSEC_RESPONSE_KEY: z.string().min(1).default('template-data'),
  /**
   * Column carrying ZingHR's employee code. NEEDS CLIENT CONFIRMATION — the
   * one mapping that would silently send correct-looking data for the wrong
   * people. UAT `userid` holds values like `10001` and `SCIPL2`.
   */
  COSEC_FIELD_EMP: z.string().min(1).default('userid'),
  /** Column carrying the swipe timestamp. */
  COSEC_FIELD_DATETIME: z.string().min(1).default('eventdatetime'),
  /**
   * Column carrying a stable per-swipe identity — the dedupe key. On UAT this
   * is `indexno`, verified stable across independent overlapping fetches.
   */
  COSEC_FIELD_UNIQUE: z.string().min(1).default('indexno'),
  /** Optional: reader/controller identity, kept locally for diagnosis. */
  COSEC_FIELD_TERMINAL: z.string().default('mastercontrollerid'),
  /** Optional: when COSEC recorded the swipe. Drives the arrival-lag report. */
  COSEC_FIELD_RECEIVED: z.string().default('idatetime'),
  /**
   * Timestamp layout in COSEC's output. Stated explicitly because MM/DD and
   * DD/MM are indistinguishable for the first twelve days of a month — a
   * mismatch shifts attendance by months with no error anywhere.
   */
  COSEC_DATETIME_FORMAT: z.string().min(1).default('MM/DD/YYYY HH:mm:ss'),
  /** Treat a response whose row count equals this as possibly truncated. */
  COSEC_PAGE_SIZE: int(1000),

  // ---- ZingHR (target) ---------------------------------------------------
  ZINGHR_AUTH_URL: z.string().url(),
  ZINGHR_SYNC_URL: z.string().url(),
  /** Unique code identifying the integration API in App Registration. Case
   *  differs between the UAT (`sswp`) and PROD (`SSWP`) examples in the docs,
   *  so it is configuration rather than a constant. */
  ZINGHR_API_PERMISSION: z.string().min(1).default('SSWP'),
  ZINGHR_USERNAME: z.string().min(1),
  ZINGHR_PASSWORD: z.string().min(1),

  // Separate phases so an unreachable server is distinguishable from an
  // unknown outcome. With one combined timeout every failure has to be
  // pessimistically treated as ambiguous — see retry.ts and §7 of the doc.
  ZINGHR_CONNECT_TIMEOUT_MS: int(5_000),
  ZINGHR_HEADERS_TIMEOUT_MS: int(30_000),
  ZINGHR_BODY_TIMEOUT_MS: int(30_000),

  // ---- Scheduling --------------------------------------------------------
  SCHEDULE: z.string().default('30 0 * * *'),
  TIMEZONE: z.string().default('Asia/Kolkata'),
  /**
   * Days re-READ from COSEC each run. Sends only rows not already staged.
   * UAT data shows 22.9% of swipes arrive >24h after the event, p95 = 5.0
   * days and max = 6.44 days, so this must comfortably exceed a week.
   */
  SWEEP_DAYS: int(10),
  /** Bounds catch-up so a long outage drains over nights instead of one run. */
  MAX_DAYS_PER_RUN: int(5),

  // ---- Publishing --------------------------------------------------------
  /**
   * Bounded three ways: the server's documented 5000 cap, the 2-minute token
   * window each POST must start inside, and bisection cost — a rejected batch
   * carries no element index, so smaller batches make the culprit cheaper to find.
   */
  BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(500),
  /**
   * Hard constraint, not a tuning knob. Issuing a ZingHR token invalidates the
   * previous one, so concurrent batches would void each other's credentials.
   */
  CONCURRENCY: z.literal(1).or(z.coerce.number().int().max(1)).default(1),

  // ---- Retry -------------------------------------------------------------
  MAX_ATTEMPTS: int(5),
  /** Ambiguous sends retry once per run, then defer to tomorrow. */
  AMBIGUOUS_RETRIES: int(1),
  AMBIGUOUS_ALERT_AT: int(5),
  QUARANTINE_DAYS: int(7),
  STALL_DAYS: int(3),
  /** Grace on top of 24h before "no successful run" escalates. */
  STALE_ALERT_GRACE_HOURS: int(2),
  BACKOFF_BASE_MS: int(1_000),
  BACKOFF_CAP_MS: int(60_000),

  // ---- Operations --------------------------------------------------------
  DB_PATH: z.string().default('./sync.db'),
  LOCK_PATH: z.string().default('./sync.lock'),
  AUDIT_DIR: z.string().default('./audit'),
  AUDIT_RETENTION_DAYS: int(90),
  HEARTBEAT_URL: z.string().url().optional(),
  REPORT_EMAIL_TO: z.string().optional(),
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  DRY_RUN: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  ENVIRONMENT: z.enum(['uat', 'production']),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
