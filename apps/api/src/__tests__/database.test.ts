import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initUserDb } from '../db/database';
import type { UserDbHandle } from '../db/database';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDb(): { handle: UserDbHandle; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notefinity-test-'));
  const handle = initUserDb(path.join(tmpDir, 'test.db'));
  return { handle, tmpDir };
}

// ---------------------------------------------------------------------------
// Schema / migration tests
// ---------------------------------------------------------------------------

describe('initUserDb', () => {
  let tmpDir: string;
  let handle: UserDbHandle;

  beforeEach(() => {
    ({ handle, tmpDir } = makeTmpDb());
  });

  afterEach(() => {
    handle.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('opens without error and runs all migrations', () => {
    // If we get here initUserDb succeeded
    expect(handle.db.open).toBe(true);
  });

  it('migration v5 — accepts block-registry type in CHECK constraint', () => {
    expect(() => {
      handle.db
        .prepare(
          `INSERT INTO documents (id, type, position, properties, created_at, updated_at)
           VALUES ('reg-1', 'block-registry', '0', '{}', 1000, 1000)`,
        )
        .run();
    }).not.toThrow();
  });

  it('still accepts all existing document types', () => {
    const types = ['page', 'folder', 'db-folder', 'workspace', 'image', 'file'];
    types.forEach((type, i) => {
      expect(() => {
        handle.db
          .prepare(
            `INSERT INTO documents (id, type, position, properties, created_at, updated_at)
             VALUES (?, ?, 'a0', '{}', 1000, 1000)`,
          )
          .run(`doc-${i}`, type);
      }).not.toThrow();
    });
  });

  it('rejects unknown document types', () => {
    expect(() => {
      handle.db
        .prepare(
          `INSERT INTO documents (id, type, position, properties, created_at, updated_at)
           VALUES ('bad-1', 'unknown-type', 'a0', '{}', 1000, 1000)`,
        )
        .run();
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// listDocuments — must exclude block-registry rows
// ---------------------------------------------------------------------------

describe('listDocuments', () => {
  let tmpDir: string;
  let handle: UserDbHandle;

  beforeEach(() => {
    ({ handle, tmpDir } = makeTmpDb());
    // Seed a page, a workspace, and a block-registry doc
    handle.db
      .prepare(
        `INSERT INTO documents (id, type, position, properties, created_at, updated_at)
         VALUES
           ('ws-1',  'workspace',      'a0', '{}', 1000, 1000),
           ('pg-1',  'page',           'b0', '{}', 1000, 1000),
           ('reg-1', 'block-registry', '0',  '{}', 1000, 1000)`,
      )
      .run();
  });

  afterEach(() => {
    handle.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns page and workspace documents', () => {
    const rows = handle.stmts.listDocuments.all() as Array<{ id: string }>;
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('ws-1');
    expect(ids).toContain('pg-1');
  });

  it('excludes block-registry documents from the list', () => {
    const rows = handle.stmts.listDocuments.all() as Array<{ id: string }>;
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain('reg-1');
  });
});

// ---------------------------------------------------------------------------
// appendYjsUpdate — routing to correct ensureDocument variant
// ---------------------------------------------------------------------------

describe('appendYjsUpdate', () => {
  let tmpDir: string;
  let handle: UserDbHandle;

  beforeEach(() => {
    ({ handle, tmpDir } = makeTmpDb());
  });

  afterEach(() => {
    handle.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a page row for a normal document id', () => {
    handle.appendYjsUpdate('page-abc', new Uint8Array([1, 2, 3]));
    const row = handle.db
      .prepare(`SELECT type FROM documents WHERE id = 'page-abc'`)
      .get() as { type: string } | undefined;
    expect(row?.type).toBe('page');
  });

  it('creates a block-registry row for a block-registry: prefixed id', () => {
    handle.appendYjsUpdate('block-registry:ws-1', new Uint8Array([1, 2, 3]));
    const row = handle.db
      .prepare(`SELECT type FROM documents WHERE id = 'block-registry:ws-1'`)
      .get() as { type: string } | undefined;
    expect(row?.type).toBe('block-registry');
  });

  it('stores the yjs update bytes', () => {
    const data = new Uint8Array([10, 20, 30]);
    handle.appendYjsUpdate('page-xyz', data);
    const updates = handle.getYjsUpdates('page-xyz');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual(Buffer.from(data));
  });

  it('does not overwrite an existing document row (INSERT OR IGNORE)', () => {
    // First call creates the row as 'page'
    handle.appendYjsUpdate('page-abc', new Uint8Array([1]));
    // Manually change the type to 'folder' to simulate a pre-existing row
    handle.db.prepare(`UPDATE documents SET type = 'folder' WHERE id = 'page-abc'`).run();
    // Second call should not overwrite the type back to 'page'
    handle.appendYjsUpdate('page-abc', new Uint8Array([2]));
    const row = handle.db
      .prepare(`SELECT type FROM documents WHERE id = 'page-abc'`)
      .get() as { type: string };
    expect(row.type).toBe('folder');
  });
});
