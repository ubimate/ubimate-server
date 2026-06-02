// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * Registry database — stores user accounts.
 * This is a single shared DB; per-user document data lives in separate files
 * managed by userDb.ts.
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

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
    INSERT INTO users (id, email, properties, created_at, status, public_key, wrapped_content_key)
    VALUES (@id, @email, @properties, @created_at, @status, @public_key, @wrapped_content_key)
  `),
  getUserByEmail: registryDb.prepare(`SELECT * FROM users WHERE email = ?`),
  getUserById: registryDb.prepare(`SELECT * FROM users WHERE id = ?`),
  updateUserCryptoKeys: registryDb.prepare(`
    UPDATE users SET public_key = @public_key, wrapped_content_key = @wrapped_content_key WHERE id = @id
  `),
  updateUserForCredentialReset: registryDb.prepare(`
    UPDATE users
    SET password_hash = @password_hash,
        public_key = NULL,
        wrapped_content_key = NULL
    WHERE id = @id
  `),
  deleteUser: registryDb.prepare(`DELETE FROM users WHERE id = ?`),
  listUsers: registryDb.prepare(`SELECT id, email, properties, status, created_at FROM users`),

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
  listWorkspaceKeysForUser: registryDb.prepare(`
    SELECT * FROM workspace_keys WHERE user_id = ?
  `),
  deleteWorkspaceKeyForUser: registryDb.prepare(`
    DELETE FROM workspace_keys WHERE workspace_id = ? AND user_id = ?
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
} as const;

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

/** Close the shared registry DB. Intended for tests that load the module in isolation. */
export function closeRegistryDb(): void {
  registryDb.close();
}
