// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initUserDb } from '../db/database';
import type { UserDbHandle } from '../db/database';
import type { InsertDocumentInput } from '@ubimate/core';

function makeTmpDb(): { handle: UserDbHandle; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-port-'));
  const handle = initUserDb(path.join(tmpDir, 'test.db'));
  return { handle, tmpDir };
}

function doc(id: string, overrides: Partial<InsertDocumentInput> = {}): InsertDocumentInput {
  const now = Date.now();
  return {
    id,
    parent_id: null,
    type: 'page',
    position: 'a0',
    properties: '{}',
    created_at: now,
    updated_at: now,
    last_struct_ts: now,
    status: 0,
    status_timestamp: null,
    last_properties_ts: now,
    ...overrides,
  };
}

describe('SqliteStoragePort', () => {
  let handle: UserDbHandle;
  let tmpDir: string;

  beforeEach(() => {
    ({ handle, tmpDir } = makeTmpDb());
  });

  afterEach(() => {
    handle.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inserts, gets and lists documents (block-registry excluded from list)', async () => {
    const { storage } = handle;
    await storage.insertDocument(doc('ws', { type: 'workspace', position: 'a0' }));
    await storage.insertDocument(doc('p1', { parent_id: 'ws', position: 'a1' }));

    const got = await storage.getDocument('p1');
    expect(got?.id).toBe('p1');
    expect(got?.parent_id).toBe('ws');
    expect(await storage.getDocument('missing')).toBeNull();

    const list = await storage.listDocuments();
    expect(list.map((d) => d.id).sort()).toEqual(['p1', 'ws']);
  });

  it('reports sibling positions for placement', async () => {
    const { storage } = handle;
    await storage.insertDocument(doc('a', { position: 'a0' }));
    await storage.insertDocument(doc('b', { position: 'a1' }));

    expect(await storage.lastSiblingPosition(null)).toBe('a1');
    const before = await storage.siblingPositionBefore({
      parent_id: null,
      before_pos: 'a1',
      exclude_id: 'b',
    });
    expect(before).toBe('a0');
  });

  it('round-trips opaque Yjs blobs and compacts them', async () => {
    const { storage } = handle;
    await storage.insertDocument(doc('d1'));

    await storage.appendYjsUpdate('d1', new Uint8Array([1, 2, 3]));
    await storage.appendYjsUpdate('d1', new Uint8Array([4, 5]));
    expect(await storage.countYjsUpdates('d1')).toBe(2);

    const updates = await storage.getYjsUpdates('d1');
    expect(updates.map((u) => Array.from(u))).toEqual([[1, 2, 3], [4, 5]]);

    await storage.compactYjsUpdates('d1', new Uint8Array([9, 9, 9]), 'hash-1');
    expect(await storage.countYjsUpdates('d1')).toBe(1);
    const compacted = await storage.getYjsUpdates('d1');
    expect(Array.from(compacted[0])).toEqual([9, 9, 9]);
    expect((await storage.getDocument('d1'))?.yjs_sv_hash).toBe('hash-1');
  });

  it('updates properties and status', async () => {
    const { storage } = handle;
    await storage.insertDocument(doc('d1'));

    await storage.updateDocumentProperties({
      id: 'd1',
      properties: '{"_enc":"abc"}',
      updated_at: Date.now(),
      last_properties_ts: Date.now(),
    });
    expect((await storage.getDocument('d1'))?.properties).toBe('{"_enc":"abc"}');

    await storage.updateDocumentStatus({
      id: 'd1',
      status: 2,
      status_timestamp: Date.now(),
      updated_at: Date.now(),
    });
    expect((await storage.getDocument('d1'))?.status).toBe(2);
  });

  it('tombstones a subtree and drops its Yjs blobs on delete', async () => {
    const { storage } = handle;
    await storage.insertDocument(doc('parent'));
    await storage.insertDocument(doc('child', { parent_id: 'parent' }));
    await storage.appendYjsUpdate('child', new Uint8Array([1]));

    await storage.deleteDocument('parent', Date.now(), Date.now());

    expect((await storage.getDocument('parent'))?.status).toBe(4);
    expect((await storage.getDocument('child'))?.status).toBe(4);
    expect(await storage.countYjsUpdates('child')).toBe(0);
  });
});
