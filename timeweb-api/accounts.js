import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { LATEST_ACCOUNT_MIGRATION } from './migrations.js';
import { createPostgresPool } from './postgres.js';
const scryptAsync = promisify(crypto.scrypt);

export const SESSION_COOKIE_NAME = '__Host-montage_session';
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

export class AccountError extends Error {
  constructor(status, message, code = 'ACCOUNT_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class AccountConflictError extends AccountError {
  constructor(message = 'Эта запись уже существует') {
    super(409, message, 'ACCOUNT_CONFLICT');
  }
}

export class AccountRateLimitError extends AccountError {
  constructor(message, retryAfterSeconds) {
    super(429, message, 'ACCOUNT_RATE_LIMIT');
    this.retryAfterSeconds = Math.max(1, Math.ceil(Number(retryAfterSeconds) || 1));
  }
}

export class AccountQuotaError extends AccountError {
  constructor(limit) {
    super(429, `Достигнут лимит проектов аккаунта (${limit})`, 'PROJECT_QUOTA');
    this.limit = limit;
  }
}

export function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AccountError(400, 'Введите корректный email', 'INVALID_EMAIL');
  }
  return email;
}

export function normalizeDisplayName(value, email = '') {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (name) return name;
  return String(email).split('@', 1)[0].slice(0, 80) || 'Пользователь';
}

function validatePassword(value) {
  const password = String(value ?? '');
  if (password.length < 10) {
    throw new AccountError(400, 'Пароль должен содержать минимум 10 символов', 'WEAK_PASSWORD');
  }
  if (password.length > 256 || Buffer.byteLength(password, 'utf8') > 1024) {
    throw new AccountError(400, 'Пароль слишком длинный', 'INVALID_PASSWORD');
  }
  return password;
}

function passwordMaterial(password, pepper) {
  return `${password}\u0000${String(pepper ?? '')}`;
}

export async function hashPassword(value, pepper = '') {
  const password = validatePassword(value);
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(
    passwordMaterial(password, pepper),
    salt,
    SCRYPT_KEY_LENGTH,
    { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAX_MEMORY },
  );
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    Buffer.from(derived).toString('base64url'),
  ].join('$');
}

export async function verifyPassword(value, encoded, pepper = '') {
  const password = String(value ?? '');
  const [algorithm, nRaw, rRaw, pRaw, saltRaw, expectedRaw, extra] = String(encoded ?? '').split('$');
  if (algorithm !== 'scrypt' || !saltRaw || !expectedRaw || extra) return false;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isSafeInteger(N) || N < 16384 || N > 262144 || (N & (N - 1)) !== 0) return false;
  if (!Number.isSafeInteger(r) || r < 1 || r > 16) return false;
  if (!Number.isSafeInteger(p) || p < 1 || p > 4) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(saltRaw, 'base64url');
    expected = Buffer.from(expectedRaw, 'base64url');
  } catch {
    return false;
  }
  if (salt.length < 16 || expected.length !== SCRYPT_KEY_LENGTH) return false;
  const maxmem = Math.max(SCRYPT_MAX_MEMORY, 128 * N * r + 1024 * 1024);
  const actual = await scryptAsync(
    passwordMaterial(password, pepper),
    salt,
    expected.length,
    { N, r, p, maxmem },
  );
  return crypto.timingSafeEqual(expected, Buffer.from(actual));
}

export function createOpaqueSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token ?? '')).digest('hex');
}

export function hashAuditValue(value, secret) {
  if (!value) return null;
  return crypto.createHmac('sha256', String(secret || 'montage-audit'))
    .update(String(value))
    .digest('hex');
}

export function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    try {
      cookies.set(key, decodeURIComponent(rawValue));
    } catch {
      cookies.set(key, rawValue);
    }
  }
  return cookies;
}

export function serializeSessionCookie(token, expiresAt) {
  const expires = new Date(expiresAt);
  const maxAge = Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000));
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    `Expires=${expires.toUTCString()}`,
  ].join('; ');
}

export function serializeExpiredSessionCookie() {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ].join('; ');
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt,
  };
}

export class AccountService {
  constructor(options) {
    if (!options?.store) throw new TypeError('AccountService requires a store');
    this.store = options.store;
    this.passwordPepper = String(options.passwordPepper ?? '');
    this.sessionLifetimeSeconds = Math.min(
      365 * 24 * 60 * 60,
      Math.max(3600, Number(options.sessionLifetimeSeconds) || 30 * 24 * 60 * 60),
    );
    this.now = options.now ?? (() => new Date());
    this.dummyHash = null;
  }

  async issueSession(user, metadata = {}) {
    const token = createOpaqueSessionToken();
    const tokenHash = hashSessionToken(token);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.sessionLifetimeSeconds * 1000);
    await this.store.createSession({
      tokenHash,
      userId: user.id,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      userAgent: String(metadata.userAgent ?? '').slice(0, 300) || null,
      ipHash: metadata.ipHash || null,
    });
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async register(input, metadata = {}) {
    const email = normalizeEmail(input?.email);
    const displayName = normalizeDisplayName(input?.displayName ?? input?.name, email);
    const passwordHash = await hashPassword(input?.password, this.passwordPepper);
    const user = {
      id: crypto.randomUUID(),
      email,
      displayName,
      passwordHash,
      createdAt: this.now().toISOString(),
    };
    await this.store.createUser(user);
    const session = await this.issueSession(user, metadata);
    return { user: publicUser(user), ...session };
  }

  async login(input, metadata = {}) {
    const email = normalizeEmail(input?.email);
    const user = await this.store.findUserByEmail(email);
    if (!this.dummyHash) this.dummyHash = hashPassword('montage-dummy-password', this.passwordPepper);
    const valid = await verifyPassword(
      input?.password,
      user?.passwordHash ?? await this.dummyHash,
      this.passwordPepper,
    );
    if (!user || !valid) {
      throw new AccountError(401, 'Неверный email или пароль', 'INVALID_CREDENTIALS');
    }
    const session = await this.issueSession(user, metadata);
    return { user: publicUser(user), ...session };
  }

  async authenticate(token) {
    if (!token) return null;
    const authenticated = await this.store.findActiveSession(
      hashSessionToken(token),
      this.now().toISOString(),
    );
    if (!authenticated) return null;
    return {
      session: authenticated.session,
      user: publicUser(authenticated.user),
    };
  }

  async logout(token) {
    if (!token) return;
    await this.store.revokeSession(hashSessionToken(token), this.now().toISOString());
  }
}

function copy(value) {
  return value == null ? value : structuredClone(value);
}

export class MemoryAccountStore {
  constructor(options = {}) {
    this.users = new Map();
    this.usersByEmail = new Map();
    this.sessions = new Map();
    this.projects = new Map();
    this.projectsByJobId = new Map();
    this.rateLimits = new Map();
    this.maxRateLimitEntries = Math.max(100, Number(options.maxRateLimitEntries) || 10_000);
  }

  async createUser(user) {
    if (this.usersByEmail.has(user.email)) throw new AccountConflictError('Аккаунт с таким email уже существует');
    this.users.set(user.id, copy(user));
    this.usersByEmail.set(user.email, user.id);
    return copy(user);
  }

  async findUserByEmail(email) {
    const id = this.usersByEmail.get(email);
    return copy(id ? this.users.get(id) : null);
  }

  async createSession(session) {
    this.sessions.set(session.tokenHash, { ...copy(session), revokedAt: null });
  }

  async findActiveSession(tokenHash, nowIso) {
    const session = this.sessions.get(tokenHash);
    if (!session || session.revokedAt || Date.parse(session.expiresAt) <= Date.parse(nowIso)) return null;
    const user = this.users.get(session.userId);
    if (!user) return null;
    return { session: copy(session), user: copy(user) };
  }

  async revokeSession(tokenHash, revokedAt) {
    const session = this.sessions.get(tokenHash);
    if (session && !session.revokedAt) session.revokedAt = revokedAt;
  }

  async createProject(project, options = {}) {
    if (this.projectsByJobId.has(project.jobId)) throw new AccountConflictError('Этот проект уже принадлежит аккаунту');
    const quota = Math.max(1, Number(options.quota) || Number.MAX_SAFE_INTEGER);
    const currentCount = [...this.projects.values()].filter((item) => item.userId === project.userId).length;
    if (currentCount >= quota) throw new AccountQuotaError(quota);
    this.projects.set(project.id, copy(project));
    this.projectsByJobId.set(project.jobId, project.id);
    return copy(project);
  }

  async claimProject(project, options = {}) {
    const existingId = this.projectsByJobId.get(project.jobId);
    if (existingId) {
      const existing = this.projects.get(existingId);
      if (existing.userId !== project.userId) throw new AccountConflictError('Этот проект уже принадлежит другому аккаунту');
      return { ...copy(existing), claimCreated: false };
    }
    return { ...await this.createProject(project, options), claimCreated: true };
  }

  async listProjects(userId) {
    return [...this.projects.values()]
      .filter((project) => project.userId === userId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(copy);
  }

  async findProjectForUser(projectId, userId) {
    const project = this.projects.get(projectId);
    return copy(project?.userId === userId ? project : null);
  }

  async findProjectByJobIdForUser(jobId, userId) {
    const projectId = this.projectsByJobId.get(jobId);
    const project = projectId ? this.projects.get(projectId) : null;
    return copy(project?.userId === userId ? project : null);
  }

  async findProjectByJobId(jobId) {
    const projectId = this.projectsByJobId.get(jobId);
    return copy(projectId ? this.projects.get(projectId) : null);
  }

  async consumeRateLimit(input) {
    const now = new Date(input.now ?? Date.now());
    const nowMs = now.getTime();
    const windowSeconds = Math.max(1, Number(input.windowSeconds) || 1);
    const retentionSeconds = Math.max(windowSeconds, Number(input.retentionSeconds) || 7 * 24 * 60 * 60);
    const windowMs = windowSeconds * 1000;
    const windowStartMs = Math.floor(nowMs / windowMs) * windowMs;
    for (const [key, entry] of this.rateLimits) {
      if (nowMs - entry.updatedAtMs > retentionSeconds * 1000) this.rateLimits.delete(key);
    }
    const key = `${input.scope}:${input.subjectHash}`;
    if (!this.rateLimits.has(key) && this.rateLimits.size >= this.maxRateLimitEntries) {
      const oldest = [...this.rateLimits.entries()]
        .sort((left, right) => left[1].updatedAtMs - right[1].updatedAtMs)
        .slice(0, this.rateLimits.size - this.maxRateLimitEntries + 1);
      for (const [oldestKey] of oldest) this.rateLimits.delete(oldestKey);
    }
    const existing = this.rateLimits.get(key);
    const limit = Math.max(1, Number(input.limit) || 1);
    const count = existing?.windowStartMs === windowStartMs
      ? Math.min(existing.count + 1, limit + 1)
      : 1;
    this.rateLimits.set(key, { count, windowStartMs, updatedAtMs: nowMs });
    return {
      allowed: count <= limit,
      count,
      limit,
      retryAfterSeconds: Math.max(1, Math.ceil((windowStartMs + windowMs - nowMs) / 1000)),
    };
  }

  async readiness() {
    return { ready: true, backend: 'memory', schemaVersion: 'memory' };
  }
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    createdAt: iso(row.created_at),
  };
}

function mapProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    jobId: row.job_id,
    title: row.title,
    source: row.source,
    processing: row.processing ?? {},
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export class PostgresAccountStore {
  constructor(options = {}) {
    this.pool = options.pool ?? createPostgresPool(options.env ?? process.env, {
      maxConnections: options.maxConnections,
      logger: options.logger,
    });
    if (!this.pool) throw new TypeError('PostgresAccountStore requires DATABASE_URL or an injected pool');
  }

  async createUser(user) {
    try {
      const result = await this.pool.query(
        `INSERT INTO users (id, email, display_name, password_hash, created_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [user.id, user.email, user.displayName, user.passwordHash, user.createdAt],
      );
      return mapUser(result.rows[0]);
    } catch (error) {
      if (error?.code === '23505') throw new AccountConflictError('Аккаунт с таким email уже существует');
      throw error;
    }
  }

  async findUserByEmail(email) {
    const result = await this.pool.query(
      `SELECT * FROM users WHERE email = $1 AND status = 'ACTIVE' LIMIT 1`,
      [email],
    );
    return mapUser(result.rows[0]);
  }

  async createSession(session) {
    await this.pool.query(
      `INSERT INTO sessions
         (token_hash, user_id, expires_at, created_at, user_agent, ip_hash)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [session.tokenHash, session.userId, session.expiresAt, session.createdAt, session.userAgent, session.ipHash],
    );
  }

  async findActiveSession(tokenHash, nowIso) {
    const result = await this.pool.query(
      `SELECT
         s.token_hash, s.user_id, s.expires_at, s.created_at AS session_created_at,
         s.revoked_at, s.user_agent, s.ip_hash,
         u.id, u.email, u.display_name, u.password_hash, u.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > $2
         AND u.status = 'ACTIVE'
       LIMIT 1`,
      [tokenHash, nowIso],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      session: {
        tokenHash: row.token_hash,
        userId: row.user_id,
        expiresAt: iso(row.expires_at),
        createdAt: iso(row.session_created_at),
        revokedAt: iso(row.revoked_at),
        userAgent: row.user_agent,
        ipHash: row.ip_hash,
      },
      user: mapUser(row),
    };
  }

  async revokeSession(tokenHash, revokedAt) {
    await this.pool.query(
      `UPDATE sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE token_hash = $1`,
      [tokenHash, revokedAt],
    );
  }

  async createProject(project, options = {}) {
    const quota = Math.max(1, Number(options.quota) || Number.MAX_SAFE_INTEGER);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [project.userId]);
      const countResult = await client.query(
        'SELECT count(*)::integer AS count FROM projects WHERE user_id = $1',
        [project.userId],
      );
      if (Number(countResult.rows[0]?.count) >= quota) throw new AccountQuotaError(quota);
      const result = await client.query(
        `INSERT INTO projects
           (id, user_id, job_id, title, source, processing, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $7)
         RETURNING *`,
        [
          project.id,
          project.userId,
          project.jobId,
          project.title,
          project.source,
          JSON.stringify(project.processing ?? {}),
          project.createdAt,
        ],
      );
      await client.query('COMMIT');
      return mapProject(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      if (error?.code === '23505') throw new AccountConflictError('Этот проект уже принадлежит аккаунту');
      throw error;
    } finally {
      client.release();
    }
  }

  async claimProject(project, options = {}) {
    const quota = Math.max(1, Number(options.quota) || Number.MAX_SAFE_INTEGER);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [project.userId]);
      const known = await client.query('SELECT * FROM projects WHERE job_id = $1 FOR UPDATE', [project.jobId]);
      if (known.rows[0]) {
        if (known.rows[0].user_id !== project.userId) {
          throw new AccountConflictError('Этот проект уже принадлежит другому аккаунту');
        }
        await client.query('COMMIT');
        return { ...mapProject(known.rows[0]), claimCreated: false };
      }
      const countResult = await client.query(
        'SELECT count(*)::integer AS count FROM projects WHERE user_id = $1',
        [project.userId],
      );
      if (Number(countResult.rows[0]?.count) >= quota) throw new AccountQuotaError(quota);
      const inserted = await client.query(
        `INSERT INTO projects
           (id, user_id, job_id, title, source, processing, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $7)
         ON CONFLICT (job_id) DO NOTHING
         RETURNING *`,
        [
          project.id,
          project.userId,
          project.jobId,
          project.title,
          project.source,
          JSON.stringify(project.processing ?? {}),
          project.createdAt,
        ],
      );
      let row = inserted.rows[0];
      const claimCreated = Boolean(row);
      if (!row) {
        const existing = await client.query('SELECT * FROM projects WHERE job_id = $1 FOR UPDATE', [project.jobId]);
        row = existing.rows[0];
        if (!row || row.user_id !== project.userId) {
          throw new AccountConflictError('Этот проект уже принадлежит другому аккаунту');
        }
      }
      await client.query('COMMIT');
      return { ...mapProject(row), claimCreated };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listProjects(userId) {
    const result = await this.pool.query(
      `SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows.map(mapProject);
  }

  async findProjectForUser(projectId, userId) {
    const result = await this.pool.query(
      `SELECT * FROM projects WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [projectId, userId],
    );
    return mapProject(result.rows[0]);
  }

  async findProjectByJobIdForUser(jobId, userId) {
    const result = await this.pool.query(
      `SELECT * FROM projects WHERE job_id = $1 AND user_id = $2 LIMIT 1`,
      [jobId, userId],
    );
    return mapProject(result.rows[0]);
  }

  async findProjectByJobId(jobId) {
    const result = await this.pool.query(
      `SELECT * FROM projects WHERE job_id = $1 LIMIT 1`,
      [jobId],
    );
    return mapProject(result.rows[0]);
  }

  async consumeRateLimit(input) {
    const now = new Date(input.now ?? Date.now());
    const windowSeconds = Math.max(1, Number(input.windowSeconds) || 1);
    const retentionSeconds = Math.max(windowSeconds, Number(input.retentionSeconds) || 7 * 24 * 60 * 60);
    const windowMs = windowSeconds * 1000;
    const limit = Math.max(1, Number(input.limit) || 1);
    const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
    const pruneBefore = new Date(now.getTime() - retentionSeconds * 1000);
    await this.pool.query(
      `DELETE FROM account_rate_limits
       WHERE ctid IN (
         SELECT ctid FROM account_rate_limits
         WHERE updated_at < $1
         ORDER BY updated_at
         LIMIT 100
       )`,
      [pruneBefore.toISOString()],
    );
    const result = await this.pool.query(
      `INSERT INTO account_rate_limits
         (scope, subject_hash, window_start, hit_count, updated_at)
       VALUES ($1, $2, $3, 1, $4)
       ON CONFLICT (scope, subject_hash) DO UPDATE SET
         window_start = EXCLUDED.window_start,
         hit_count = CASE
           WHEN account_rate_limits.window_start = EXCLUDED.window_start
             THEN LEAST(account_rate_limits.hit_count + 1, $5)
           ELSE 1
         END,
         updated_at = EXCLUDED.updated_at
       RETURNING hit_count`,
      [input.scope, input.subjectHash, windowStart.toISOString(), now.toISOString(), limit + 1],
    );
    const count = Number(result.rows[0]?.hit_count) || 1;
    return {
      allowed: count <= limit,
      count,
      limit,
      retryAfterSeconds: Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000)),
    };
  }

  async readiness() {
    const result = await this.pool.query(
      `SELECT
         to_regclass('public.users') IS NOT NULL AS users_ready,
         to_regclass('public.sessions') IS NOT NULL AS sessions_ready,
         to_regclass('public.projects') IS NOT NULL AS projects_ready,
         to_regclass('public.account_rate_limits') IS NOT NULL AS rate_limits_ready,
         EXISTS (
           SELECT 1 FROM account_schema_migrations WHERE version = $1
         ) AS migration_ready`,
      [LATEST_ACCOUNT_MIGRATION],
    );
    const row = result.rows[0] ?? {};
    const ready = row.users_ready === true
      && row.sessions_ready === true
      && row.projects_ready === true
      && row.rate_limits_ready === true
      && row.migration_ready === true;
    return { ready, backend: 'postgres', schemaVersion: ready ? LATEST_ACCOUNT_MIGRATION : null };
  }

  async close() {
    await this.pool.end();
  }
}

export function createPostgresAccountStore(env = process.env) {
  const pool = createPostgresPool(env);
  return pool ? new PostgresAccountStore({ pool }) : null;
}
