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
   * Column carrying ZingHR's employee code. Confirmed 2026-08-27: COSEC's
   * `userid` IS the ZingHR employee code. 129 distinct values in UAT, max
   * length 12, inside ZingHR's 20-char limit.
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
   * Bounded by the server's documented 5000 cap. The token window is NOT a
   * constraint — measured at 1200s, not the 2 minutes the docs imply. Rejections
   * carry element indices, so a bad record is identified without bisection and
   * batch size no longer drives failure-attribution cost either.
   *
   * At a production ~20k swipes/day this means ~20 POSTs per run. Raising it
   * toward the cap is safe; the reason to keep some headroom is that a
   * batch-scoped rejection carrying no index still falls back to bisection.
   */
  BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(1000),
  /**
   * A deliberate choice, not a constraint. Issuing a token does NOT invalidate
   * the previous one (verified on UAT), so concurrency would be safe — but at
   * ~150 swipes/day a single batch usually covers a week, and parallelism would
   * add moving parts for no gain.
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
  /**
   * How long delivered swipes stay queryable. At ~20k swipes/day the ledger
   * grows ~6 MB/day, so this sets the steady-state size: 180 days is ~1 GB.
   *
   * It is an audit window, not a technical limit — payroll disputes are the
   * reason to keep them at all, so it should comfortably span a few pay cycles.
   */
  RETENTION_DAYS: int(180),
  RUN_LOG_RETENTION_DAYS: int(365),
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

const Validated = ConfigSchema.superRefine((c, ctx) => {
  // The sweep re-reads the last SWEEP_DAYS by attendance date. Pruning a
  // delivered swipe still inside that window would let the sweep re-stage and
  // re-send it as a duplicate, so retention must clear the window with room
  // to spare. Caught at boot rather than discovered as duplicates in payroll.
  const floor = c.SWEEP_DAYS * 3 + 7;
  if (c.RETENTION_DAYS < floor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['RETENTION_DAYS'],
      message:
        `must be at least ${floor} with SWEEP_DAYS=${c.SWEEP_DAYS} — pruning inside ` +
        `the sweep window would re-stage delivered swipes and duplicate them in payroll`,
    });
  }
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Validated.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
