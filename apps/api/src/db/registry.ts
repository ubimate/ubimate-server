/**
 * Registry database — stores user accounts.
 * This is a single shared DB; per-user document data lives in separate files
 * managed by userDb.ts.
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const registryDb = new Database(path.join(DATA_DIR, 'registry.db'));
registryDb.pragma('journal_mode = WAL');
registryDb.pragma('foreign_keys = ON');

registryDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT    PRIMARY KEY,
    email         TEXT    NOT NULL UNIQUE,
    properties    TEXT    NOT NULL DEFAULT '{}',
    password_hash TEXT    NOT NULL,
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

export interface UserRow {
  id: string;
  email: string;
  /** Raw JSON string — use parseUserProperties() to deserialise. */
  properties: string;
  password_hash: string;
  created_at: number;
  status: string;
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

export interface InvitationRow {
  id: string;
  token: string;
  email: string;
  created_at: number;
  accepted_at: number | null;
}

export const registryStmts = {
  createUser: registryDb.prepare(`
    INSERT INTO users (id, email, properties, password_hash, created_at, status)
    VALUES (@id, @email, @properties, @password_hash, @created_at, @status)
  `),
  getUserByEmail: registryDb.prepare(`SELECT * FROM users WHERE email = ?`),
  getUserById: registryDb.prepare(`SELECT * FROM users WHERE id = ?`),
  listUsers: registryDb.prepare(`SELECT id, email, properties, status, created_at FROM users`),

  // Invitations
  insertInvitation: registryDb.prepare(`
    INSERT INTO invitations (id, token, email, created_at)
    VALUES (@id, @token, @email, @created_at)
  `),
  getInvitationByToken: registryDb.prepare(`SELECT * FROM invitations WHERE token = ?`),
  getInvitationById: registryDb.prepare(`SELECT * FROM invitations WHERE id = ?`),
  listInvitations: registryDb.prepare(`SELECT * FROM invitations ORDER BY created_at DESC`),
  markInvitationAccepted: registryDb.prepare(`UPDATE invitations SET accepted_at = ? WHERE id = ?`),
  deleteInvitation: registryDb.prepare(`DELETE FROM invitations WHERE id = ?`),
  getPendingInvitationByEmail: registryDb.prepare(`SELECT * FROM invitations WHERE email = ? AND accepted_at IS NULL`),
} as const;
