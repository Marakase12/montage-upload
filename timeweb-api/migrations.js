import crypto from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresPool } from './postgres.js';

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.join(CURRENT_DIR, 'migrations');
const MIGRATION_NAME = /^\d{3}_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK_ID = 1_946_130_927;

export const LATEST_ACCOUNT_MIGRATION = '002_account_rate_limits';

export async function loadMigrations(directory = DEFAULT_MIGRATIONS_DIR) {
  const names = (await readdir(directory))
    .filter((name) => MIGRATION_NAME.test(name))
    .sort((left, right) => left.localeCompare(right));
  const migrations = [];
  for (const name of names) {
    const sql = (await readFile(path.join(directory, name), 'utf8')).replace(/\r\n/g, '\n');
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/im.test(sql)) {
      throw new Error(`Migration ${name} must not contain transaction control statements`);
    }
    migrations.push({
      version: name.slice(0, -4),
      checksum: crypto.createHash('sha256').update(sql).digest('hex'),
      sql,
    });
  }
  if (!migrations.length) throw new Error('No database migrations were found');
  if (migrations.at(-1).version !== LATEST_ACCOUNT_MIGRATION) {
    throw new Error(`Latest database migration must be ${LATEST_ACCOUNT_MIGRATION}`);
  }
  return migrations;
}

export async function applyMigrations(client, migrations) {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS account_schema_migrations (
        version varchar(120) PRIMARY KEY,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const appliedResult = await client.query(
      'SELECT version, checksum FROM account_schema_migrations ORDER BY version',
    );
    const applied = new Map(appliedResult.rows.map((row) => [row.version, row.checksum]));

    for (const migration of migrations) {
      const existingChecksum = applied.get(migration.version);
      if (existingChecksum) {
        if (existingChecksum !== migration.checksum) {
          throw new Error(`Checksum mismatch for applied migration ${migration.version}`);
        }
        continue;
      }
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO account_schema_migrations (version, checksum) VALUES ($1, $2)',
        [migration.version, migration.checksum],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function runMigrations(options = {}) {
  const env = options.env ?? process.env;
  const pool = options.pool ?? createPostgresPool(env, { maxConnections: 2, logger: options.logger });
  if (!pool) return { configured: false, applied: false };
  const ownsPool = !options.pool;
  let client;
  try {
    client = await pool.connect();
    const migrations = options.migrations ?? await loadMigrations(options.directory);
    await applyMigrations(client, migrations);
    return { configured: true, applied: true, latestVersion: migrations.at(-1).version };
  } finally {
    client?.release();
    if (ownsPool) await pool.end();
  }
}

async function main() {
  const result = await runMigrations();
  if (!result.configured) {
    console.log('Database migrations skipped: DATABASE_URL is not configured');
    return;
  }
  console.log(`Database migrations ready at ${result.latestVersion}`);
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`Database migration failed (${String(error?.code ?? error?.name ?? 'ERROR')})`);
    process.exitCode = 1;
  });
}
