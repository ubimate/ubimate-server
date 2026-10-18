// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Accounts made before registration filled in `contact_email` start from their login email when the
 * registry opens: a registry.db as it was then, with the column present and empty.
 */
describe('registry migration — contact_email', () => {
  let tmpDir: string;
  let closeRegistryDb: (() => void) | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-registry-test-'));
    process.env.DATA_DIR = tmpDir;
    const old = new Database(path.join(tmpDir, 'registry.db'));
    old.exec(`
      CREATE TABLE users (
        id            TEXT    PRIMARY KEY,
        email         TEXT    NOT NULL UNIQUE,
        properties    TEXT    NOT NULL DEFAULT '{}',
        password_hash TEXT,
        created_at    INTEGER NOT NULL,
        status        TEXT    NOT NULL DEFAULT 'active',
        is_demo       INTEGER NOT NULL DEFAULT 0,
        contact_email TEXT
      );
      INSERT INTO users (id, email, created_at, is_demo, contact_email) VALUES
        ('u-empty', 'alice@example.com',      1, 0, NULL),
        ('u-set',   'bob@example.com',        1, 0, 'bob@elsewhere.org'),
        ('u-demo',  'demo-u-demo@demo.local', 1, 1, NULL);
    `);
    old.close();
    vi.resetModules();
  });

  afterEach(() => {
    closeRegistryDb?.();
    closeRegistryDb = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    vi.resetModules();
  });

  const contactOf = async () => {
    const registry = await import('../db/registry');
    closeRegistryDb = registry.closeRegistryDb;
    return (id: string) => (registry.registryStmts.getUserById.get(id) as { contact_email: string | null }).contact_email;
  };

  it('fills an empty contact address with the login email', async () => {
    expect((await contactOf())('u-empty')).toBe('alice@example.com');
  });

  it('keeps a contact address already set', async () => {
    expect((await contactOf())('u-set')).toBe('bob@elsewhere.org');
  });

  it('leaves a demo account without one: its login email is not an address', async () => {
    expect((await contactOf())('u-demo')).toBeNull();
  });
});
