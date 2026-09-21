import pg from 'pg';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const { Pool } = pg;
const KNOWN_NODE_ENV = new Set(['development', 'test', 'production']);
const MIN_PRODUCTION_SECRET_LENGTH = 32;

function requiredProductionSecret(env, name) {
  const value = String(env[name] ?? '');
  if (value.length < MIN_PRODUCTION_SECRET_LENGTH) {
    throw new Error(`${name} must contain at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production`);
  }
  return value;
}

export function validateAccountEnvironment(env = process.env) {
  const databaseUrl = String(env.DATABASE_URL ?? '').trim();
  const accountStore = String(env.ACCOUNT_STORE ?? '').trim().toLowerCase();
  const nodeEnv = String(env.NODE_ENV ?? '').trim().toLowerCase();

  if (accountStore === 'memory' && !['development', 'test'].includes(nodeEnv)) {
    throw new Error('ACCOUNT_STORE=memory is allowed only with NODE_ENV=development or NODE_ENV=test');
  }

  if (!databaseUrl) return { databaseUrl: '', nodeEnv, accountStore };
  if (!KNOWN_NODE_ENV.has(nodeEnv)) {
    throw new Error('NODE_ENV must be explicitly set to development, test, or production when DATABASE_URL is configured');
  }

  if (nodeEnv === 'production') {
    const tokenSecret = requiredProductionSecret(env, 'TOKEN_SECRET');
    const passwordPepper = requiredProductionSecret(env, 'AUTH_PASSWORD_PEPPER');
    const auditSecret = requiredProductionSecret(env, 'SESSION_AUDIT_SECRET');
    if (new Set([tokenSecret, passwordPepper, auditSecret]).size !== 3) {
      throw new Error('TOKEN_SECRET, AUTH_PASSWORD_PEPPER, and SESSION_AUDIT_SECRET must be different secrets');
    }
  }

  return { databaseUrl, nodeEnv, accountStore };
}

export function postgresSsl(env = process.env) {
  const sslMode = String(env.DATABASE_SSL ?? '').trim().toLowerCase();
  if (sslMode === 'disable') return false;
  if (sslMode === 'require') {
    const rejectUnauthorized = String(env.DATABASE_SSL_REJECT_UNAUTHORIZED ?? 'true') !== 'false';
    const caPath = String(env.DATABASE_SSL_CA_PATH ?? '').trim();
    const ca = caPath ? readFileSync(path.resolve(caPath), 'utf8').trim() : undefined;
    return {
      rejectUnauthorized,
      ...(ca ? { ca } : {}),
    };
  }
  return undefined;
}

export function createPostgresPool(env = process.env, options = {}) {
  const { databaseUrl } = validateAccountEnvironment(env);
  if (!databaseUrl) return null;
  const ssl = postgresSsl(env);
  const pool = new Pool({
    connectionString: databaseUrl,
    ...(ssl === undefined ? {} : { ssl }),
    max: Number(options.maxConnections ?? env.DATABASE_POOL_SIZE) || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  const logger = options.logger ?? console;
  pool.on('error', (error) => {
    const code = String(error?.code ?? error?.name ?? 'UNKNOWN').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    logger.error(`PostgreSQL pool error (${code || 'UNKNOWN'})`);
  });
  return pool;
}
