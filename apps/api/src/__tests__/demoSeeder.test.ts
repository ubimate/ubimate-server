// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * Unit tests for seedDemoWorkspace().
 *
 * Covers:
 * - Correct number of documents inserted
 * - Workspace document at root (parent_id = null)
 * - Expected document types are present
 * - Welcome page has a Yjs state update stored
 * - yjs_sv_hash is set on the welcome page
 * - All documents have non-empty positions
 * - All documents have unique IDs
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { initUserDb } from '../db/database';
import { seedDemoWorkspace } from '../db/demoSeeder';

describe('seedDemoWorkspace', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: ReturnType<typeof initUserDb> | null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-seeder-test-'));
    dbPath = path.join(tmpDir, 'demo.db');
    db = null;
  });

  afterEach(() => {
    db?.db.close();
    db = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function openDb() {
    db = initUserDb(dbPath);
    return db;
  }

  it('inserts exactly 9 documents', () => {
    const db = openDb();
    const workspaceId = randomUUID();
    seedDemoWorkspace(db, workspaceId);

    const { n } = db.db.prepare('SELECT COUNT(*) as n FROM documents').get() as { n: number };
    // workspace + welcome + notes-folder + meeting-notes + ideas
    //   + tasks-folder + task1 + task2 + task3 = 9
    expect(n).toBe(9);
  });

  it('inserts the workspace document at the root (parent_id IS NULL)', () => {
    const db = openDb();
    const workspaceId = randomUUID();
    seedDemoWorkspace(db, workspaceId);

    const row = db.db.prepare(
      "SELECT * FROM documents WHERE type = 'workspace'",
    ).get() as { id: string; parent_id: string | null };
    expect(row).toBeTruthy();
    expect(row.id).toBe(workspaceId);
    expect(row.parent_id).toBeNull();
  });

  it('contains one of each expected document type', () => {
    const db = openDb();
    seedDemoWorkspace(db, randomUUID());

    const rows = db.db.prepare(
      'SELECT type FROM documents',
    ).all() as { type: string }[];
    const types = rows.map((r) => r.type);

    expect(types.filter((t) => t === 'workspace')).toHaveLength(1);
    expect(types.filter((t) => t === 'page')).toHaveLength(3); // welcome + meeting-notes + ideas
    expect(types.filter((t) => t === 'folder')).toHaveLength(1);
    expect(types.filter((t) => t === 'db-folder')).toHaveLength(1);
    expect(types.filter((t) => t === 'db-page')).toHaveLength(3);
  });

  it('all documents have non-empty position strings', () => {
    const db = openDb();
    seedDemoWorkspace(db, randomUUID());

    const rows = db.db.prepare(
      'SELECT position FROM documents',
    ).all() as { position: string }[];
    for (const { position } of rows) {
      expect(typeof position).toBe('string');
      expect(position.length).toBeGreaterThan(0);
    }
  });

  it('all document IDs are unique', () => {
    const db = openDb();
    seedDemoWorkspace(db, randomUUID());

    const rows = db.db.prepare(
      'SELECT id FROM documents',
    ).all() as { id: string }[];
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('stores a Yjs update for the welcome page', () => {
    const db = openDb();
    const workspaceId = randomUUID();
    seedDemoWorkspace(db, workspaceId);

    // Find the welcome page
    const welcome = db.db.prepare(
      "SELECT id FROM documents WHERE type = 'page' ORDER BY position LIMIT 1",
    ).get() as { id: string };
    expect(welcome).toBeTruthy();

    const updates = db.db.prepare(
      'SELECT data FROM yjs_updates WHERE document_id = ?',
    ).all(welcome.id) as { data: Buffer }[];
    expect(updates.length).toBeGreaterThan(0);

    // The update should be a valid Yjs state update
    const update = updates[0].data;
    const ydoc = new Y.Doc();
    expect(() => Y.applyUpdate(ydoc, update)).not.toThrow();

    // The fragment should contain at least one element
    const fragment = ydoc.getXmlFragment('default');
    expect(fragment.length).toBeGreaterThan(0);
  });

  it('stamps a non-empty yjs_sv_hash on the welcome page', () => {
    const db = openDb();
    const workspaceId = randomUUID();
    seedDemoWorkspace(db, workspaceId);

    const welcome = db.db.prepare(
      "SELECT id, yjs_sv_hash FROM documents WHERE type = 'page' ORDER BY position LIMIT 1",
    ).get() as { id: string; yjs_sv_hash: string | null };
    expect(welcome.yjs_sv_hash).toBeTruthy();
    expect((welcome.yjs_sv_hash as string).length).toBeGreaterThan(0);
  });

  it('the welcome Yjs content contains the expected heading text', () => {
    const db = openDb();
    seedDemoWorkspace(db, randomUUID());

    const welcome = db.db.prepare(
      "SELECT id FROM documents WHERE type = 'page' ORDER BY position LIMIT 1",
    ).get() as { id: string };

    const updates = db.db.prepare(
      'SELECT data FROM yjs_updates WHERE document_id = ?',
    ).all(welcome.id) as { data: Buffer }[];

    const ydoc = new Y.Doc();
    for (const { data } of updates) {
      Y.applyUpdate(ydoc, data);
    }
    const fragment = ydoc.getXmlFragment('default');
    const heading = fragment.get(0) as Y.XmlElement;
    expect(heading.nodeName).toBe('heading');
    expect(heading.toString()).toContain('Welcome to Ubimate');
  });
});
