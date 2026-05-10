import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as Y from 'yjs';
import { initUserDb } from '../db/database';
import type { UserDbHandle } from '../db/database';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDb(): { handle: UserDbHandle; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovernote-test-'));
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

  it('invalidates yjs_sv_hash when appending a new update', () => {
    // Create doc and set a hash via compact
    handle.appendYjsUpdate('page-hash', new Uint8Array([1, 2, 3]));
    handle.compactYjsUpdates('page-hash', new Uint8Array([1, 2, 3]), 'abc123');
    const before = handle.db
      .prepare(`SELECT yjs_sv_hash FROM documents WHERE id = 'page-hash'`)
      .get() as { yjs_sv_hash: string | null };
    expect(before.yjs_sv_hash).toBe('abc123');

    // Appending a new update should null out the hash
    handle.appendYjsUpdate('page-hash', new Uint8Array([4, 5, 6]));
    const after = handle.db
      .prepare(`SELECT yjs_sv_hash FROM documents WHERE id = 'page-hash'`)
      .get() as { yjs_sv_hash: string | null };
    expect(after.yjs_sv_hash).toBeNull();
  });

  it('stores encrypted Yjs update bytes at rest in yjs_updates', () => {
    const ydoc = new Y.Doc();
    const text = ydoc.getText('default');
    text.insert(0, 'hello-yjs');
    const update = Y.encodeStateAsUpdate(ydoc);

    handle.appendYjsUpdate('page-at-rest', update);

    const row = handle.db
      .prepare('SELECT data FROM yjs_updates WHERE document_id = ? ORDER BY id DESC LIMIT 1')
      .get('page-at-rest') as { data: Buffer } | undefined;

    expect(row).toBeDefined();
    // At-rest bytes must not equal the raw Yjs update.
    expect(row?.data.equals(Buffer.from(update))).toBe(false);
    // Read path returns decrypted update bytes.
    const readBack = handle.getYjsUpdates('page-at-rest');
    expect(readBack).toHaveLength(1);
    expect(readBack[0]).toEqual(Buffer.from(update));
  });

  it('rejects plaintext yjs rows that are not encrypted', () => {
    const legacy = Buffer.from([1, 2, 3, 4, 5]);
    handle.db
      .prepare(
        `INSERT INTO documents (id, type, position, properties, created_at, updated_at)
         VALUES (?, 'page', '0', '{}', ?, ?)`,
      )
      .run('legacy-page', Date.now(), Date.now());
    handle.db
      .prepare('INSERT INTO yjs_updates (document_id, data, created_at) VALUES (?, ?, ?)')
      .run('legacy-page', legacy, Date.now());

    expect(() => handle.getYjsUpdates('legacy-page')).toThrow('Invalid encrypted Yjs row');
  });
});

// ---------------------------------------------------------------------------
// findWorkspaceId — parent-chain traversal
// ---------------------------------------------------------------------------

describe('findWorkspaceId', () => {
  let tmpDir: string;
  let handle: UserDbHandle;

  beforeEach(() => {
    ({ handle, tmpDir } = makeTmpDb());
    // Build a three-level tree: workspace → folder → page
    handle.db
      .prepare(
        `INSERT INTO documents (id, parent_id, type, position, properties, created_at, updated_at)
         VALUES
           ('ws-1',     NULL,     'workspace', 'a0', '{}', 1000, 1000),
           ('fold-1',   'ws-1',   'folder',    'a0', '{}', 1000, 1000),
           ('page-1',   'fold-1', 'page',      'a0', '{}', 1000, 1000),
           ('page-2',   'ws-1',   'page',      'b0', '{}', 1000, 1000),
           ('ws-2',     NULL,     'workspace', 'a0', '{}', 1000, 1000),
           ('page-3',   'ws-2',   'page',      'a0', '{}', 1000, 1000)`,
      )
      .run();
  });

  afterEach(() => {
    handle.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the workspace id for a page directly under the workspace', () => {
    expect(handle.findWorkspaceId('page-2')).toBe('ws-1');
  });

  it('returns the workspace id for a page nested under a folder', () => {
    expect(handle.findWorkspaceId('page-1')).toBe('ws-1');
  });

  it('returns the correct workspace when multiple workspaces exist', () => {
    expect(handle.findWorkspaceId('page-3')).toBe('ws-2');
  });

  it('returns the workspace id when called with the workspace id itself', () => {
    expect(handle.findWorkspaceId('ws-1')).toBe('ws-1');
  });

  it('returns null for a document that does not exist', () => {
    expect(handle.findWorkspaceId('nonexistent')).toBeNull();
  });

  it('returns null for a detached document with no workspace ancestor', () => {
    handle.db
      .prepare(
        `INSERT INTO documents (id, parent_id, type, position, properties, created_at, updated_at)
         VALUES ('detached', NULL, 'page', 'a0', '{}', 1000, 1000)`,
      )
      .run();
    expect(handle.findWorkspaceId('detached')).toBeNull();
  });
});
