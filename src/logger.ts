/**
 * Structured logging with credential redaction configured from the outset --
 * retrofitting it happens after the first leak, which is too late.
 */
import pino from 'pino';
import type { Config } from './config.ts';

export function makeLogger(cfg: Config) {
  return pino({
    level: cfg.LOG_LEVEL,
    base: { env: cfg.ENVIRONMENT },
    redact: {
      paths: [
        'password', '*.password', 'authorization', '*.authorization',
        'token', '*.token', 'COSEC_PASSWORD', 'ZINGHR_PASSWORD',
        'headers.authorization', '*.headers.authorization',
      ],
      censor: '[redacted]',
    },
  });
}

export type Log = (event: string, detail: Record<string, unknown>) => void;
