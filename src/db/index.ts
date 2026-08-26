/**
 * SQLite connection and forward-only migrations.
 *
 * WAL mode, one file, no separate service to operate on a client's premises.
 * The store holds delivery state — the one thing that cannot be re-derived by
 * re-reading COSEC — so it is the only reason this system needs a disk at all.
 */
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export type Db = Database.Database;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Durability matters more than throughput here: a few thousand rows once a
  // night, against the risk of losing the record of what was already sent.
  db.pragma('synchronous = FULL');
  return db;
}

export function migrate(db: Db): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);

  const applied = new Set(
    db.prepare('SELECT name FROM schema_migration').all().map((r) => (r as { name: string }).name),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const ran: string[] = [];
  const record = db.prepare('INSERT INTO schema_migration (name, applied_at) VALUES (?, ?)');

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(file, Date.now());
    })();
    ran.push(file);
  }
  return ran;
}
