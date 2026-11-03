// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * Key rotation on the server (docs/ATTACHMENT-ENCRYPTION.md 5.1, 6, 7).
 *
 * POST   /api/workspaces/:id/rotate      — the owner moves a Space to a new key version, removing members
 * GET    /api/workspaces/:id/keychain    — the chain that walks older keys down
 * DELETE /api/workspaces/:id/members/me  — a member leaves; rotation becomes pending
 * GET    /api/workspaces/:id/members     — who holds a key, with the public keys a rotation seals for
 *
 * The server holds no keys, so a "sealed key" here is any string: what is checked is who may rotate, that
 * the rotation names exactly the remaining members, and that versions move forward by one.
 */

import express from 'express';
import { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = randomUUID();
const MEMBER = randomUUID();
const LEAVER = randomUUID();
const OUTSIDER = randomUUID();
const WS = randomUUID();
/** A chain entry is 72 bytes: 96 characters of base64url. */
const PREV = 'p'.repeat(96);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('key rotation', () => {
  let tmpDir: string;
  let server: ReturnType<typeof express.application.listen> | null = null;
  let baseUrl = '';
  const tokens: Record<string, string> = {};

  const call = async (method: string, url: string, who: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}/api/workspaces/${url}`, {
      method,
      headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Json | null };
  };
  const rotate = (who: string, body: Json) => call('POST', `${WS}/rotate`, who, body);
  /** A rotation from version `from` that removes `remove` and seals a key for everyone else in `stay`. */
  const rotation = (from: number, remove: string[], stay: string[]) => ({
    fromVersion: from,
    remove,
    wrappedPrevious: PREV,
    keys: stay.map((userId) => ({ userId, wrappedKey: `v${from + 1}-for-${userId}` })),
  });
  const keyOf = (who: string) => call('GET', `${WS}/key`, who);

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-rot-test-'));
    process.env.DATA_DIR = tmpDir;
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.NODE_ENV = 'test';
    vi.resetModules();

    const jwt = await import('jsonwebtoken');
    const { registryStmts } = await import('../db/registry');
    const now = Date.now();
    for (const id of [OWNER, MEMBER, LEAVER, OUTSIDER]) {
      tokens[id] = jwt.sign({ sub: id, email: `${id}@example.com` }, 'test-jwt-secret', { expiresIn: '1h' });
      registryStmts.createUser.run({
        id, email: `${id}@example.com`, properties: '{}', created_at: now, status: 'active',
        public_key: `pk-${id}`, wrapped_content_key: null, user_type: 'free',
      });
    }
    // The owner puts the Space's first key, then gives the others theirs, as the app does.
    for (const id of [OWNER, MEMBER, LEAVER]) {
      registryStmts.insertWorkspaceKey.run({ workspace_id: WS, user_id: id, wrapped_key: `v1-for-${id}`, granted_at: now });
    }
    registryStmts.recordSpaceOwner.run({ workspace_id: WS, owner_user_id: OWNER });

    const { workspacesRouter } = await import('../routes/workspaces');
    const app = express();
    app.use(express.json());
    app.use('/api/workspaces', workspacesRouter);
    server = app.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      const { closeRegistryDb } = await import('../db/registry');
      closeRegistryDb();
      server = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.JWT_SECRET;
    delete process.env.NODE_ENV;
    vi.resetModules();
  });

  /** Everything a refused rotation must leave exactly as it was. */
  const snapshot = async () => {
    const { registryStmts } = await import('../db/registry');
    return JSON.stringify({
      state: registryStmts.getKeyState.get(WS),
      members: registryStmts.listWorkspaceMembers.all(WS),
      keys: [OWNER, MEMBER, LEAVER].map((u) => registryStmts.getWorkspaceKeyForUser.get(WS, u)),
      chain: registryStmts.listKeyChain.all(WS),
    });
  };

  describe('POST /rotate', () => {
    it('moves the Space to the next version: the remaining members get new keys, the removed one loses theirs, the chain grows', async () => {
      const res = await rotate(OWNER, rotation(1, [LEAVER], [OWNER, MEMBER]));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ current_version: 2 });

      for (const who of [OWNER, MEMBER]) {
        const key = await keyOf(who);
        expect(key.status).toBe(200);
        expect(key.body).toMatchObject({ wrapped_key: `v2-for-${who}`, key_version: 2, current_version: 2 });
      }
      expect((await keyOf(LEAVER)).status).toBe(403);

      const chain = await call('GET', `${WS}/keychain`, MEMBER);
      expect(chain.body).toEqual({ workspace_id: WS, current_version: 2, chain: [{ key_version: 2, wrapped_previous: PREV }] });
    });

    it('can rotate with nobody removed (the owner securing the Space after someone left)', async () => {
      const res = await rotate(OWNER, rotation(1, [], [OWNER, MEMBER, LEAVER]));
      expect(res.status).toBe(200);
      expect((await keyOf(LEAVER)).body).toMatchObject({ key_version: 2, wrapped_key: `v2-for-${LEAVER}` });
    });

    it('chains: a second rotation adds its own entry above the first, and every member reads both', async () => {
      await rotate(OWNER, rotation(1, [LEAVER], [OWNER, MEMBER]));
      const second = await rotate(OWNER, { ...rotation(2, [], [OWNER, MEMBER]), wrappedPrevious: 'q'.repeat(96) });
      expect(second.body).toEqual({ current_version: 3 });

      const chain = (await call('GET', `${WS}/keychain`, MEMBER)).body!;
      expect(chain.current_version).toBe(3);
      expect(chain.chain).toEqual([
        { key_version: 3, wrapped_previous: 'q'.repeat(96) },
        { key_version: 2, wrapped_previous: PREV },
      ]);
    });

    it('is the owner’s alone: a member, an outsider and a Space the server does not know are all refused, and nothing moves', async () => {
      const before = await snapshot();
      expect((await rotate(MEMBER, rotation(1, [LEAVER], [OWNER, MEMBER]))).status).toBe(403);
      expect((await rotate(OUTSIDER, rotation(1, [LEAVER], [OWNER, MEMBER]))).status).toBe(403);
      expect((await call('POST', `${randomUUID()}/rotate`, OWNER, rotation(1, [], [OWNER]))).status).toBe(403);
      expect(await snapshot()).toBe(before);
    });

    it('answers 409 key_rotated, naming the current version, when fromVersion is stale, and changes nothing', async () => {
      await rotate(OWNER, rotation(1, [], [OWNER, MEMBER, LEAVER]));
      const before = await snapshot();
      const stale = await rotate(OWNER, rotation(1, [LEAVER], [OWNER, MEMBER]));
      expect(stale.status).toBe(409);
      expect(stale.body).toEqual({ error: 'key_rotated', currentVersion: 2 });
      // A version from the future is just as wrong.
      expect((await rotate(OWNER, rotation(5, [], [OWNER, MEMBER, LEAVER]))).status).toBe(409);
      expect(await snapshot()).toBe(before);
    });

    it('refuses keys that leave a remaining member out, name someone who is not one, or name a removed member', async () => {
      const before = await snapshot();
      const refused = [
        rotation(1, [LEAVER], [OWNER]), // MEMBER left out
        rotation(1, [LEAVER], [OWNER, MEMBER, OUTSIDER]), // OUTSIDER was never a member
        rotation(1, [LEAVER], [OWNER, MEMBER, LEAVER]), // LEAVER is being removed
        rotation(1, [], [OWNER, MEMBER]), // LEAVER left out without being removed
        rotation(1, [LEAVER], [OWNER, MEMBER, MEMBER]), // a member named twice
      ];
      expect(refused).toHaveLength(5);
      for (const body of refused) {
        const res = await rotate(OWNER, body);
        expect([res.status, res.body?.error]).toEqual([400, expect.any(String)]);
      }
      expect(await snapshot()).toBe(before);
    });

    it('does not let the owner remove itself, or remove someone who is not a member', async () => {
      const before = await snapshot();
      expect((await rotate(OWNER, rotation(1, [OWNER], [MEMBER, LEAVER]))).status).toBe(400);
      expect((await rotate(OWNER, rotation(1, [OUTSIDER], [OWNER, MEMBER, LEAVER]))).status).toBe(400);
      expect(await snapshot()).toBe(before);
    });

    it('refuses a malformed body', async () => {
      const before = await snapshot();
      const good = rotation(1, [LEAVER], [OWNER, MEMBER]);
      const bad: Json[] = [
        { ...good, fromVersion: '1' },
        { ...good, fromVersion: 0 },
        { ...good, remove: 'x' },
        { ...good, wrappedPrevious: 'short' },
        { ...good, wrappedPrevious: 'p'.repeat(97) },
        { ...good, keys: 'x' },
        { ...good, keys: [{ userId: OWNER }, { userId: MEMBER, wrappedKey: 'k' }] },
        { ...good, keys: [{ userId: OWNER, wrappedKey: '' }, { userId: MEMBER, wrappedKey: 'k' }] },
        { ...good, keys: [{ userId: OWNER, wrappedKey: 'k'.repeat(2000) }, { userId: MEMBER, wrappedKey: 'k' }] },
      ];
      expect(bad).toHaveLength(9);
      for (const body of bad) expect((await rotate(OWNER, body)).status).toBe(400);
      expect(await snapshot()).toBe(before);
    });

    it('lets only one of two rotations from the same version succeed', async () => {
      const [a, b] = await Promise.all([
        rotate(OWNER, rotation(1, [LEAVER], [OWNER, MEMBER])),
        rotate(OWNER, rotation(1, [MEMBER], [OWNER, LEAVER])),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const { registryStmts } = await import('../db/registry');
      expect((registryStmts.getKeyState.get(WS) as { current_version: number }).current_version).toBe(2);
      expect(registryStmts.listKeyChain.all(WS)).toHaveLength(1);
    });
  });

  describe('keys written after a rotation', () => {
    it('are at the Space’s current version: a member invited later gets the new key as version 2', async () => {
      await rotate(OWNER, rotation(1, [LEAVER], [OWNER, MEMBER]));
      const put = await call('PUT', `${WS}/key/${OUTSIDER}`, OWNER, { wrapped_key: 'v2-for-outsider' });
      expect(put.status).toBe(204);
      expect((await keyOf(OUTSIDER)).body).toMatchObject({ wrapped_key: 'v2-for-outsider', key_version: 2, current_version: 2 });
    });

    it('make currentKeyVersion, which the attachment routes check uploads against, follow the Space', async () => {
      const { currentKeyVersion } = await import('../db/registry');
      expect(currentKeyVersion(WS)).toBe(1);
      expect(currentKeyVersion(randomUUID())).toBe(1);
      await rotate(OWNER, rotation(1, [], [OWNER, MEMBER, LEAVER]));
      expect(currentKeyVersion(WS)).toBe(2);
    });
  });

  describe('GET /members', () => {
    it('lists whoever holds a key, with their public key and who owns the Space, to any member', async () => {
      for (const who of [OWNER, MEMBER, LEAVER]) {
        const res = await call('GET', `${WS}/members`, who);
        expect(res.status).toBe(200);
        const members = res.body!.members as { user_id: string; public_key: string | null; is_owner: boolean }[];
        expect(members).toHaveLength(3);
        expect(members.map((m) => m.user_id).sort()).toEqual([OWNER, MEMBER, LEAVER].sort());
        for (const m of members) expect(m).toEqual({ user_id: m.user_id, public_key: `pk-${m.user_id}`, is_owner: m.user_id === OWNER });
      }
    });

    it('is refused to a non-member, and no longer lists a member who was removed or left', async () => {
      expect((await call('GET', `${WS}/members`, OUTSIDER)).status).toBe(403);
      await rotate(OWNER, rotation(1, [LEAVER], [OWNER, MEMBER]));
      const after = (await call('GET', `${WS}/members`, MEMBER)).body!.members as { user_id: string }[];
      expect(after.map((m) => m.user_id).sort()).toEqual([OWNER, MEMBER].sort());
      await call('DELETE', `${WS}/members/me`, MEMBER);
      expect(((await call('GET', `${WS}/members`, OWNER)).body!.members as unknown[])).toHaveLength(1);
    });
  });

  describe('GET /keychain', () => {
    it('is empty at version 1, and only for members', async () => {
      const own = await call('GET', `${WS}/keychain`, OWNER);
      expect(own.body).toEqual({ workspace_id: WS, current_version: 1, chain: [] });
      expect((await call('GET', `${WS}/keychain`, OUTSIDER)).status).toBe(403);
    });

    it('is refused to a member who was removed', async () => {
      expect((await call('GET', `${WS}/keychain`, LEAVER)).status).toBe(200);
      await rotate(OWNER, rotation(1, [LEAVER], [OWNER, MEMBER]));
      expect((await call('GET', `${WS}/keychain`, LEAVER)).status).toBe(403);
    });
  });

  describe('DELETE /members/me (leaving)', () => {
    it('removes the member’s key and marks the Space rotation_pending, which only the owner is told, until a rotation clears it', async () => {
      expect((await keyOf(OWNER)).body).toMatchObject({ rotation_pending: false });
      const left = await call('DELETE', `${WS}/members/me`, LEAVER);
      expect(left.status).toBe(204);

      expect((await keyOf(LEAVER)).status).toBe(403);
      expect((await keyOf(OWNER)).body).toMatchObject({ rotation_pending: true, current_version: 1 });

      await rotate(OWNER, rotation(1, [], [OWNER, MEMBER]));
      expect((await keyOf(OWNER)).body).toMatchObject({ rotation_pending: false, current_version: 2 });
    });

    it('is refused for the owner, and for someone who is not a member, and changes nothing', async () => {
      const before = await snapshot();
      expect((await call('DELETE', `${WS}/members/me`, OWNER)).status).toBe(400);
      expect((await call('DELETE', `${WS}/members/me`, OUTSIDER)).status).toBe(403);
      expect(await snapshot()).toBe(before);
    });
  });

  describe('the key-rotated and rotation-pending events', () => {
    const listen = async (userId: string) => {
      const { addDocumentEventClient } = await import('../lib/documentEvents');
      const written: string[] = [];
      addDocumentEventClient(userId, { write: (chunk: string) => written.push(chunk) } as never);
      return written;
    };

    it('reach each remaining member, with the Space and the new version, and not the removed one or an outsider', async () => {
      const heard: Record<string, string[]> = {};
      for (const id of [OWNER, MEMBER, LEAVER, OUTSIDER]) heard[id] = await listen(id);
      await rotate(OWNER, rotation(1, [LEAVER], [OWNER, MEMBER]));
      const want = `event: key-rotated\ndata: ${JSON.stringify({ workspaceId: WS, version: 2 })}\n\n`;
      expect(heard[OWNER]).toEqual([want]);
      expect(heard[MEMBER]).toEqual([want]);
      expect(heard[LEAVER]).toEqual([]);
      expect(heard[OUTSIDER]).toEqual([]);
    });

    it('are not sent for a refused rotation', async () => {
      const heard = await listen(MEMBER);
      await rotate(OWNER, rotation(9, [LEAVER], [OWNER, MEMBER]));
      await rotate(MEMBER, rotation(1, [LEAVER], [OWNER, MEMBER]));
      expect(heard).toEqual([]);
    });

    it('tell only the owner, with rotation-pending, when a member leaves', async () => {
      const owner = await listen(OWNER);
      const member = await listen(MEMBER);
      await call('DELETE', `${WS}/members/me`, LEAVER);
      expect(owner).toEqual([`event: rotation-pending\ndata: ${JSON.stringify({ workspaceId: WS })}\n\n`]);
      expect(member).toEqual([]);
    });
  });
});
