/**
 * Registry database — stores user accounts.
 * This is a single shared DB; per-user document data lives in separate files
 * managed by userDb.ts.
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { closeAllUserDbs } from './userDb';

const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, '../../data');
const SQLITE_BUSY_TIMEOUT_MS = Number(process.env.SQLITE_BUSY_TIMEOUT_MS ?? 5000);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const registryDb = new Database(path.join(DATA_DIR, 'registry.db'));
registryDb.pragma('journal_mode = WAL');
registryDb.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
registryDb.pragma('foreign_keys = ON');

registryDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT    PRIMARY KEY,
    email         TEXT    NOT NULL UNIQUE,
    properties    TEXT    NOT NULL DEFAULT '{}',
    password_hash TEXT,
    created_at    INTEGER NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'active'
  );
`);

// Migrations for existing databases.
const cols = (registryDb.pragma('table_info(users)') as { name: string }[]).map(c => c.name);
if (!cols.includes('status')) {
  registryDb.exec(`ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
}
if (!cols.includes('properties')) {
  registryDb.exec(`ALTER TABLE users ADD COLUMN properties TEXT NOT NULL DEFAULT '{}'`);
  // Migrate existing name values (from the previous schema) into the properties JSON.
  if (cols.includes('name')) {
    const rows = (registryDb.prepare(`SELECT id, name FROM users`).all()) as { id: string; name: string }[];
    const update = registryDb.prepare(`UPDATE users SET properties = ? WHERE id = ?`);
    for (const row of rows) {
      update.run(JSON.stringify({ name: row.name }), row.id);
    }
  }
}
if (!cols.includes('public_key')) {
  registryDb.exec(`ALTER TABLE users ADD COLUMN public_key TEXT`);
}
if (!cols.includes('wrapped_content_key')) {
  registryDb.exec(`ALTER TABLE users ADD COLUMN wrapped_content_key TEXT`);
}

// Migrate historical schemas where password_hash was required (NOT NULL).
// Legacy password auth has been removed; keep the column for compatibility,
// but make it optional so new ZK-only accounts can persist NULL.
{
  const tableInfo = registryDb.pragma('table_info(users)') as { name: string; notnull: number }[];
  const passwordHashCol = tableInfo.find(c => c.name === 'password_hash');
  if (passwordHashCol && passwordHashCol.notnull === 1) {
    registryDb.exec(`
      BEGIN TRANSACTION;
      CREATE TABLE users_new (
        id                 TEXT    PRIMARY KEY,
        email              TEXT    NOT NULL UNIQUE,
        properties         TEXT    NOT NULL DEFAULT '{}',
        password_hash      TEXT,
        created_at         INTEGER NOT NULL,
        status             TEXT    NOT NULL DEFAULT 'active',
        public_key         TEXT,
        wrapped_content_key TEXT
      );
      INSERT INTO users_new (id, email, properties, password_hash, created_at, status, public_key, wrapped_content_key)
      SELECT id, email, properties, password_hash, created_at, status, public_key, wrapped_content_key
      FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      COMMIT;
    `);
  }
}

export interface WorkspaceKeyRow {
  workspace_id: string;
  user_id: string;
  /** Base64-encoded sealed workspace content key. */
  wrapped_key: string;
  granted_at: number;
}

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

export interface AttachmentRow {
  attachment_id: string;
  workspace_id: string;
  uploader_user_id: string;
  owner_user_id: string;
  kind: AttachmentKind;
  status: 'pending' | 'confirmed' | 'deleted';
  storage: 'local' | 's3';
  storage_key: string;
  key_version: number;
  wrapped_key: string;
  expected_size: number;
  size_bytes: number | null;
  created_at: number;
}

/**
 * The version of a Space's key that new content is written under. Every Space is at version 1 until
 * key versions are built (docs/ATTACHMENT-ENCRYPTION.md 5.1, step 5), which gives this a table to read.
 */
export function currentKeyVersion(_workspaceId: string): number {
  return 1;
}

export interface UserRow {
  id: string;
  email: string;
  /** Raw JSON string — use parseUserProperties() to deserialise. */
  properties: string;
  password_hash: string | null;
  created_at: number;
  status: string;
  /** Base64-encoded Ed25519 public key — null for pre-ZK accounts. */
  public_key: string | null;
  /** Base64-encoded sealed content key — null for pre-ZK accounts. */
  wrapped_content_key: string | null;
  /** 1 when this is a throwaway demo account, 0 otherwise. */
  is_demo: number;
  /** Unix ms expiry for demo accounts; null for real accounts. */
  demo_expires_at: number | null;
  /** Random 64-char hex token used to re-enter a free-trial demo session. Null until activated. */
  freetrial_token: string | null;
  /** Canonical account type — e.g. 'regular', 'demo', 'trial', 'perso26', 'perso26_launch'. */
  user_type: string;
  /**
   * Mutable contact address for billing and notifications; has no cryptographic role. Set to `email`
   * at registration. NULL for demo and trial accounts, whose `email` is not a real address.
   */
  contact_email: string | null;
  /**
   * ID of the user's protected "home" workspace. Created at registration and
   * never deletable; quick-capture notes default here. NULL for legacy accounts
   * until backfilled by resolvePrimaryWorkspaceId() on next login.
   */
  primary_workspace_id: string | null;
}

/**
 * Derive a canonical user-type string from a UserRow.
 * Add new tiers here as the product grows — all tracking call sites
 * pick up the change automatically.
 */
export function getUserType(row: Pick<UserRow, 'user_type'>): string {
  return row.user_type;
}

/** Safely parse the properties JSON column. Returns an empty object on malformed data. */
export function parseUserProperties(row: UserRow): Record<string, unknown> {
  try {
    return JSON.parse(row.properties) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Invitations table
// ---------------------------------------------------------------------------

registryDb.exec(`
  CREATE TABLE IF NOT EXISTS invitations (
    id          TEXT    PRIMARY KEY,
    token       TEXT    NOT NULL UNIQUE,
    email       TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    accepted_at INTEGER
  );
`);
registryDb.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token);
`);

// ---------------------------------------------------------------------------
// workspace_keys table — per-workspace, per-user sealed content keys
// ---------------------------------------------------------------------------

registryDb.exec(`
  CREATE TABLE IF NOT EXISTS workspace_keys (
    workspace_id  TEXT    NOT NULL,
    user_id       TEXT    NOT NULL,
    wrapped_key   TEXT    NOT NULL,
    granted_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (workspace_id, user_id)
  );
`);
registryDb.exec(`
  CREATE INDEX IF NOT EXISTS idx_workspace_keys_user ON workspace_keys(user_id);
`);

// ---------------------------------------------------------------------------
// workspace_key_state — what the server records about a Space beyond its members' keys
// (docs/ATTACHMENT-ENCRYPTION.md 5.1)
// ---------------------------------------------------------------------------

// One row per Space put on the server, written when its first key is. `owner_user_id` is the creator
// (docs/DISK-QUOTAS.md §4.5): the account that wrote the first key row, never changed afterwards. The version
// and `rotation_pending` are for key rotation (step 5): a Space with no row, and so one made before this
// table, has no known owner and is at version 1.
registryDb.exec(`
  CREATE TABLE IF NOT EXISTS workspace_key_state (
    workspace_id     TEXT    PRIMARY KEY,
    current_version  INTEGER NOT NULL DEFAULT 1,
    rotation_pending INTEGER NOT NULL DEFAULT 0,
    owner_user_id    TEXT    NOT NULL
  );
`);

// ---------------------------------------------------------------------------
// Storage usage and the attachment ledger (docs/DISK-QUOTAS.md §3)
// ---------------------------------------------------------------------------

// One row per account and kind. `used_bytes` moves by the size of each upload and delete, and is set
// absolutely only by the reconcile job (lib/quota.ts). Bytes promised to uploads in flight are held
// in memory there, not here: a crash must not leave a reservation behind.
registryDb.exec(`
  CREATE TABLE IF NOT EXISTS usage (
    user_id        TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind           TEXT    NOT NULL CHECK (kind IN ('attachments', 'sync')),
    used_bytes     INTEGER NOT NULL DEFAULT 0,
    updated_at     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, kind)
  );
`);

// One row per attachment (docs/ATTACHMENT-ENCRYPTION.md 5.2). The id is made by the client. `pending`
// from presign until confirm, which charges `owner_user_id` (the uploader until sharing exists);
// `deleted` only for an object in a bucket that the cleanup job has yet to remove. The server never
// sees a name or MIME type, only the coarse `kind`. `wrapped_key` is the attachment's key under the
// Space key at `key_version`, opaque here.
registryDb.exec(`
  CREATE TABLE IF NOT EXISTS attachments (
    attachment_id    TEXT    PRIMARY KEY,
    workspace_id     TEXT    NOT NULL,
    uploader_user_id TEXT    NOT NULL,
    owner_user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind             TEXT    NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'file')),
    status           TEXT    NOT NULL CHECK (status IN ('pending', 'confirmed', 'deleted')),
    storage          TEXT    NOT NULL CHECK (storage IN ('local', 's3')),
    storage_key      TEXT    NOT NULL,
    key_version      INTEGER NOT NULL,
    wrapped_key      TEXT    NOT NULL,
    expected_size    INTEGER NOT NULL,
    size_bytes       INTEGER,
    created_at       INTEGER NOT NULL
  );
`);
registryDb.exec(`
  CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments(owner_user_id);
`);
registryDb.exec(`
  CREATE INDEX IF NOT EXISTS idx_attachments_uploader ON attachments(uploader_user_id);
`);

// ---------------------------------------------------------------------------
// Credential reset tokens
// ---------------------------------------------------------------------------

registryDb.exec(`
  CREATE TABLE IF NOT EXISTS credential_reset_tokens (
    id          TEXT    PRIMARY KEY,
    user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT    NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    consumed_at INTEGER
  );
`);
registryDb.exec(`
  CREATE INDEX IF NOT EXISTS idx_reset_tokens_user_id ON credential_reset_tokens(user_id);
`);

// Migrations — add demo columns if they do not already exist.
{
  const userCols = (registryDb.pragma('table_info(users)') as { name: string }[]).map((c) => c.name);
  if (!userCols.includes('is_demo')) {
    registryDb.exec(`ALTER TABLE users ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0`);
  }
  if (!userCols.includes('demo_expires_at')) {
    registryDb.exec(`ALTER TABLE users ADD COLUMN demo_expires_at INTEGER`);
  }
  if (!userCols.includes('freetrial_token')) {
    registryDb.exec(`ALTER TABLE users ADD COLUMN freetrial_token TEXT`);
    registryDb.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_freetrial_token ON users(freetrial_token) WHERE freetrial_token IS NOT NULL`);
  }
  if (!userCols.includes('user_type')) {
    registryDb.exec(`ALTER TABLE users ADD COLUMN user_type TEXT NOT NULL DEFAULT 'regular'`);
    // Backfill from the legacy is_demo + freetrial_token flags.
    registryDb.exec(`UPDATE users SET user_type = 'trial' WHERE is_demo = 1 AND freetrial_token IS NOT NULL`);
    registryDb.exec(`UPDATE users SET user_type = 'demo'  WHERE is_demo = 1 AND freetrial_token IS NULL`);
    registryDb.exec(`CREATE INDEX IF NOT EXISTS idx_users_user_type ON users(user_type)`);
  }
}

// Migration — add contact_email column if it does not already exist.
{
  const userCols = (registryDb.pragma('table_info(users)') as { name: string }[]).map((c) => c.name);
  if (!userCols.includes('contact_email')) {
    registryDb.exec(`ALTER TABLE users ADD COLUMN contact_email TEXT`);
  }
  // Registration fills it in since 2026-10-18; accounts made before then start from their login
  // email too. Not a demo's: its email (demo-<id>@demo.local) is no one's address.
  registryDb.exec(`UPDATE users SET contact_email = email WHERE contact_email IS NULL AND is_demo = 0`);
}

// Migration — add primary_workspace_id column if it does not already exist.
// This is the user's protected "home" workspace (see User.primary_workspace_id).
{
  const userCols = (registryDb.pragma('table_info(users)') as { name: string }[]).map((c) => c.name);
  if (!userCols.includes('primary_workspace_id')) {
    registryDb.exec(`ALTER TABLE users ADD COLUMN primary_workspace_id TEXT`);
  }
}

// Migrations — add ZK #5 columns if they do not already exist.
{
  const cols = (registryDb.pragma('table_info(invitations)') as { name: string }[]).map((c) => c.name);
  if (!cols.includes('expires_at')) {
    registryDb.exec(`ALTER TABLE invitations ADD COLUMN expires_at INTEGER`);
  }
  if (!cols.includes('sender_public_key')) {
    registryDb.exec(`ALTER TABLE invitations ADD COLUMN sender_public_key TEXT`);
  }
  if (!cols.includes('sender_signature')) {
    registryDb.exec(`ALTER TABLE invitations ADD COLUMN sender_signature TEXT`);
  }
}

export interface InvitationRow {
  id: string;
  token: string;
  email: string;
  created_at: number;
  accepted_at: number | null;
  expires_at: number | null;
  sender_public_key: string | null;
  sender_signature: string | null;
}

export const registryStmts = {
  createUser: registryDb.prepare(`
    INSERT INTO users (id, email, contact_email, properties, created_at, status, public_key, wrapped_content_key, user_type)
    VALUES (@id, @email, @email, @properties, @created_at, @status, @public_key, @wrapped_content_key, @user_type)
  `),
  createDemoUser: registryDb.prepare(`
    INSERT INTO users (id, email, properties, created_at, status, is_demo, demo_expires_at, user_type)
    VALUES (@id, @email, @properties, @created_at, 'active', 1, @demo_expires_at, 'demo')
  `),
  countDemoUsers: registryDb.prepare(`SELECT COUNT(*) as count FROM users WHERE is_demo = 1`),
  listExpiredDemoUsers: registryDb.prepare(`
    SELECT id FROM users WHERE is_demo = 1 AND demo_expires_at < ?
  `),
  setFreeTrialToken: registryDb.prepare(`
    UPDATE users SET freetrial_token = @token, demo_expires_at = @expires_at, user_type = 'trial' WHERE id = @id
  `),
  getUserByFreeTrialToken: registryDb.prepare(`
    SELECT * FROM users WHERE freetrial_token = ?
  `),
  deleteAllWorkspaceKeysForUser: registryDb.prepare(`
    DELETE FROM workspace_keys WHERE user_id = ?
  `),
  getUserByEmail: registryDb.prepare(`SELECT * FROM users WHERE email = ?`),
  getUserById: registryDb.prepare(`SELECT * FROM users WHERE id = ?`),
  updateUserCryptoKeys: registryDb.prepare(`
    UPDATE users SET public_key = @public_key, wrapped_content_key = @wrapped_content_key WHERE id = @id
  `),
  updateUserType: registryDb.prepare(`
    UPDATE users SET user_type = @user_type WHERE id = @id
  `),
  setPrimaryWorkspaceId: registryDb.prepare(`
    UPDATE users SET primary_workspace_id = @primary_workspace_id WHERE id = @id
  `),
  updateUserForCredentialReset: registryDb.prepare(`
    UPDATE users
    SET password_hash = @password_hash,
        public_key = NULL,
        wrapped_content_key = NULL
    WHERE id = @id
  `),
  deleteUser: registryDb.prepare(`DELETE FROM users WHERE id = ?`),
  updateUserProperties: registryDb.prepare(`UPDATE users SET properties = @properties WHERE id = @id`),
  listUsers: registryDb.prepare(`SELECT id, email, properties, status, created_at, is_demo, demo_expires_at, freetrial_token, user_type FROM users`),

  // Workspace keys
  insertWorkspaceKey: registryDb.prepare(`
    INSERT INTO workspace_keys (workspace_id, user_id, wrapped_key, granted_at)
    VALUES (@workspace_id, @user_id, @wrapped_key, @granted_at)
  `),
  upsertWorkspaceKey: registryDb.prepare(`
    INSERT INTO workspace_keys (workspace_id, user_id, wrapped_key, granted_at)
    VALUES (@workspace_id, @user_id, @wrapped_key, @granted_at)
    ON CONFLICT(workspace_id, user_id) DO UPDATE SET wrapped_key = excluded.wrapped_key
  `),
  getWorkspaceKeyForUser: registryDb.prepare(`
    SELECT * FROM workspace_keys WHERE workspace_id = ? AND user_id = ?
  `),
  countWorkspaceKeys: registryDb.prepare(`
    SELECT COUNT(*) as count FROM workspace_keys WHERE workspace_id = ?
  `),
  listWorkspaceKeysForUser: registryDb.prepare(`
    SELECT * FROM workspace_keys WHERE user_id = ? ORDER BY granted_at ASC
  `),
  deleteWorkspaceKeyForUser: registryDb.prepare(`
    DELETE FROM workspace_keys WHERE workspace_id = ? AND user_id = ?
  `),

  // Space ownership. The first account to be given a Space's key owns it; later calls change nothing.
  recordSpaceOwner: registryDb.prepare(`
    INSERT OR IGNORE INTO workspace_key_state (workspace_id, owner_user_id) VALUES (@workspace_id, @owner_user_id)
  `),
  getSpaceOwner: registryDb.prepare(`SELECT owner_user_id FROM workspace_key_state WHERE workspace_id = ?`),

  // Storage usage and the attachment ledger
  listUsage: registryDb.prepare(`SELECT user_id, kind, used_bytes, updated_at FROM usage`),
  getUsageRow: registryDb.prepare(`SELECT used_bytes FROM usage WHERE user_id = ? AND kind = ?`),
  setUsedBytes: registryDb.prepare(`
    INSERT INTO usage (user_id, kind, used_bytes, updated_at)
    VALUES (@user_id, @kind, @used_bytes, @updated_at)
    ON CONFLICT(user_id, kind) DO UPDATE SET used_bytes = excluded.used_bytes, updated_at = excluded.updated_at
  `),
  addUsedBytes: registryDb.prepare(`
    INSERT INTO usage (user_id, kind, used_bytes, updated_at)
    VALUES (@user_id, @kind, MAX(0, @delta), @updated_at)
    ON CONFLICT(user_id, kind) DO UPDATE SET used_bytes = MAX(0, used_bytes + @delta), updated_at = excluded.updated_at
  `),
  getAttachment: registryDb.prepare(`SELECT * FROM attachments WHERE attachment_id = ?`),
  // The uploader's own confirmed attachments: what a client compares with the media documents it holds.
  listAttachmentsByUploader: registryDb.prepare(`
    SELECT attachment_id, workspace_id, size_bytes FROM attachments
    WHERE uploader_user_id = ? AND status = 'confirmed'
  `),
  insertPendingAttachment: registryDb.prepare(`
    INSERT INTO attachments (attachment_id, workspace_id, uploader_user_id, owner_user_id, kind, status, storage,
                             storage_key, key_version, wrapped_key, expected_size, size_bytes, created_at)
    VALUES (@attachment_id, @workspace_id, @uploader_user_id, @owner_user_id, @kind, 'pending', @storage,
            @storage_key, @key_version, @wrapped_key, @expected_size, NULL, @created_at)
  `),
  // A retried presign for the same id: the same row, fresh size, kind, wrapping and place. A row that was
  // `deleted` and not yet cleaned up (a size mismatch on a bucket, where the API cannot delete) is pending again.
  refreshPendingAttachment: registryDb.prepare(`
    UPDATE attachments SET kind = @kind, key_version = @key_version, wrapped_key = @wrapped_key,
                           expected_size = @expected_size, size_bytes = NULL, created_at = @created_at, status = 'pending',
                           storage = @storage, storage_key = @storage_key, owner_user_id = @owner_user_id
    WHERE attachment_id = @attachment_id AND status IN ('pending', 'deleted')
  `),
  confirmAttachment: registryDb.prepare(`
    UPDATE attachments SET status = 'confirmed', size_bytes = @size_bytes
    WHERE attachment_id = @attachment_id AND status = 'pending'
  `),
  markAttachmentDeleted: registryDb.prepare(`UPDATE attachments SET status = 'deleted' WHERE attachment_id = ?`),
  deleteAttachment: registryDb.prepare(`DELETE FROM attachments WHERE attachment_id = ?`),
  listStalePendingAttachments: registryDb.prepare(`
    SELECT * FROM attachments WHERE status = 'pending' AND created_at < ?
  `),
  listDeletedAttachments: registryDb.prepare(`SELECT * FROM attachments WHERE status = 'deleted'`),
  sumAttachmentsForOwner: registryDb.prepare(`
    SELECT COALESCE(SUM(size_bytes), 0) AS total FROM attachments WHERE owner_user_id = ? AND status = 'confirmed'
  `),

  // Invitations
  insertInvitation: registryDb.prepare(`
    INSERT INTO invitations (id, token, email, created_at, expires_at, sender_public_key, sender_signature)
    VALUES (@id, @token, @email, @created_at, @expires_at, @sender_public_key, @sender_signature)
  `),
  getInvitationByToken: registryDb.prepare(`SELECT * FROM invitations WHERE token = ?`),
  getInvitationById: registryDb.prepare(`SELECT * FROM invitations WHERE id = ?`),
  listInvitations: registryDb.prepare(`SELECT * FROM invitations ORDER BY created_at DESC`),
  markInvitationAccepted: registryDb.prepare(`UPDATE invitations SET accepted_at = ? WHERE id = ?`),
  deleteInvitation: registryDb.prepare(`DELETE FROM invitations WHERE id = ?`),
  getPendingInvitationByEmail: registryDb.prepare(`SELECT * FROM invitations WHERE email = ? AND accepted_at IS NULL`),

  // Credential reset tokens
  insertCredentialResetToken: registryDb.prepare(`
    INSERT INTO credential_reset_tokens (id, user_id, token_hash, created_at, expires_at, consumed_at)
    VALUES (@id, @user_id, @token_hash, @created_at, @expires_at, NULL)
  `),
  getCredentialResetTokenByHash: registryDb.prepare(`
    SELECT * FROM credential_reset_tokens WHERE token_hash = ?
  `),
  getLatestCredentialResetTokenForUser: registryDb.prepare(`
    SELECT * FROM credential_reset_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 1
  `),
  consumeCredentialResetToken: registryDb.prepare(`
    UPDATE credential_reset_tokens SET consumed_at = ? WHERE id = ?
  `),
  deleteCredentialResetTokensForUser: registryDb.prepare(`
    DELETE FROM credential_reset_tokens WHERE user_id = ?
  `),

  // Health probe — see pingRegistryDb().
  ping: registryDb.prepare(`SELECT 1 AS ok`),
} as const;

/**
 * Cheapest possible proof that the registry DB is still usable. Throws if the
 * file has become unreadable or stays locked past busy_timeout. Used by the
 * readiness probe (see routes/health.ts).
 */
export function pingRegistryDb(): void {
  registryStmts.ping.get();
}

export interface CredentialResetTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

export function withRegistryTransaction<T>(fn: () => T): T {
  return registryDb.transaction(fn)();
}

/**
 * Return the user's protected "home" workspace id, backfilling it for legacy
 * accounts that predate the column. The home workspace is the one created at
 * registration; for legacy users we adopt the oldest granted workspace key
 * (the registration workspace for the vast majority of accounts) and persist
 * it so the value is stable across logins and enforceable by the delete guard.
 * Returns null only when the user holds no workspace keys at all.
 */
export function resolvePrimaryWorkspaceId(userId: string): string | null {
  const user = registryStmts.getUserById.get(userId) as UserRow | undefined;
  if (!user) return null;
  if (user.primary_workspace_id) return user.primary_workspace_id;

  const keys = registryStmts.listWorkspaceKeysForUser.all(userId) as WorkspaceKeyRow[];
  if (keys.length === 0) return null;
  const oldest = keys.reduce((a, b) => (a.granted_at <= b.granted_at ? a : b));
  registryStmts.setPrimaryWorkspaceId.run({ id: userId, primary_workspace_id: oldest.workspace_id });
  return oldest.workspace_id;
}

/** Close the shared registry DB. Intended for tests that load the module in isolation. */
export function closeRegistryDb(): void {
  closeAllUserDbs();
  registryDb.close();
}
