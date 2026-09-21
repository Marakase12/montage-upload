import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMigrations, loadMigrations } from '../migrations.js';

class FakeMigrationClient {
  constructor(applied = new Map()) {
    this.applied = applied;
    this.executed = [];
  }

  async query(sql, values = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('SELECT version, checksum FROM account_schema_migrations')) {
      return { rows: [...this.applied].map(([version, checksum]) => ({ version, checksum })) };
    }
    if (normalized.startsWith('INSERT INTO account_schema_migrations')) {
      this.applied.set(values[0], values[1]);
      return { rows: [] };
    }
    if (!['BEGIN', 'COMMIT', 'ROLLBACK'].includes(normalized)
      && !normalized.startsWith('SELECT pg_advisory_xact_lock')
      && !normalized.includes('CREATE TABLE IF NOT EXISTS account_schema_migrations')) {
      this.executed.push(String(sql));
    }
    return { rows: [] };
  }
}

test('versioned migrations не содержат nested transaction и применяются идемпотентно', async () => {
  const migrations = await loadMigrations();
  assert.deepEqual(migrations.map((item) => item.version), [
    '001_accounts',
    '002_account_rate_limits',
  ]);
  for (const migration of migrations) {
    assert.doesNotMatch(migration.sql, /^\s*(BEGIN|COMMIT|ROLLBACK)\b/im);
  }

  const client = new FakeMigrationClient();
  await applyMigrations(client, migrations);
  assert.equal(client.executed.length, 2);
  await applyMigrations(client, migrations);
  assert.equal(client.executed.length, 2);
});

test('migration runner fail-closed при изменении уже применённого файла', async () => {
  const migrations = await loadMigrations();
  const client = new FakeMigrationClient(new Map([[migrations[0].version, '0'.repeat(64)]]));
  await assert.rejects(
    applyMigrations(client, migrations),
    /Checksum mismatch/,
  );
});
