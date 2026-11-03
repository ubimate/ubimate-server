// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * Removing a member from a Space, end to end (docs/ATTACHMENT-ENCRYPTION.md 7, 11): the web client's own
 * modules (`fetchSpaceKey`, `rotateSpace`, `uploadEncrypted`, the attachment resolver) talk over real HTTP to
 * the real routes behind the real `requireAuth`, with real libsodium keys, sealed boxes and format 2 encryption.
 *
 * What it settles is the claim rotation exists for: a member who was removed, and who kept every key they ever
 * held and every stored byte they could get, cannot read what was written after. The "attacker" here is that
 * member with the server's storage in hand, so the server's refusals (403 for a non-member) are not what is
 * being relied on: the cryptography is.
 *
 * Content is attachments, because they are what members of one Space share through the server today; a
 * document's Yjs updates are stored in each account's own database until sharing exists (docs/GUESTS.md), and the
 * frames themselves are covered by packages/crypto spaceKey.test.ts.
 */
import express from 'express';
import { AddressInfo } from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _sodium,
  decryptBlob,
  decryptFrame,
  ed25519ToX25519Public,
  encryptFrameWithSpaceKey,
  generateSpaceKey,
  sealWithPublicKey,
  unwrapAttachmentKey,
  type SpaceKey,
} from '@ubimate/crypto';
import { KeyRotatedError, createBearerHttpClient, type UbimateClient } from '../../../web/src/api/client';
import { uploadEncrypted } from '../../../web/src/api/encryptedUpload';
import { createAttachmentResolver } from '../../../web/src/api/attachmentResolver';
import { checkSpaces, currentSpaceKey, fetchSpaceKey, rotateSpace } from '../../../web/src/api/spaceKeyRotation';

const WS = 'ws-rot';
const bytesOf = (n: number, seed = 1): Uint8Array<ArrayBuffer> => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251);
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

interface Actor {
  id: string;
  signing: { publicKey: Uint8Array; privateKey: Uint8Array };
  client: UbimateClient;
}

describe('removing a member from a Space, end to end', () => {
  let tmpDir: string;
  let server: ReturnType<typeof express.application.listen> | null = null;
  let baseUrl = '';
  let registry: typeof import('../db/registry');
  let owner: Actor;
  let member: Actor;
  let leaver: Actor;
  /** The key the leaver held while a member, kept for ever: everything rotation has to withstand. */
  let leaverK1: SpaceKey;

  const file = (data: Uint8Array<ArrayBuffer>) => new File([data], 'secret-name.png', { type: 'image/png' });

  async function makeActor(id: string): Promise<Actor> {
    await _sodium.ready;
    const kp = _sodium.crypto_sign_keypair();
    registry.registryStmts.createUser.run({
      id, email: `${id}@example.com`, properties: '{}', created_at: Date.now(), status: 'active',
      public_key: _sodium.to_base64(kp.publicKey), wrapped_content_key: null, user_type: 'free',
    });
    const jwt = (await import('jsonwebtoken')).default;
    const token = jwt.sign({ sub: id, email: `${id}@example.com` }, 'rot-test-secret', { expiresIn: '1h' });
    return { id, signing: { publicKey: kp.publicKey, privateKey: kp.privateKey }, client: createBearerHttpClient(baseUrl, token) };
  }

  /** The Space is created by its owner, who seals its first key for each member, as the app does. */
  async function createSpace(members: Actor[]): Promise<void> {
    const k1 = await generateSpaceKey(WS);
    for (const a of members) {
      const sealed = await sealWithPublicKey(k1, await ed25519ToX25519Public(a.signing.publicKey));
      registry.registryStmts.insertWorkspaceKey.run({ workspace_id: WS, user_id: a.id, wrapped_key: sealed, granted_at: 1 });
    }
    registry.registryStmts.recordSpaceOwner.run({ workspace_id: WS, owner_user_id: members[0].id });
  }

  const keyOf = (a: Actor) => fetchSpaceKey(a.client, WS, a.signing);
  const upload = (a: Actor, key: SpaceKey, id: string, data: Uint8Array<ArrayBuffer>, refresh = false) =>
    uploadEncrypted(a.client, file(data), key, WS, id, refresh ? () => currentSpaceKey(a.client, key, a.signing) : undefined);
  const read = (a: Actor, key: SpaceKey, id: string) =>
    createAttachmentResolver({
      resolve: (ids) => a.client.resolveAttachments(ids),
      download: (url) => a.client.downloadRaw(url),
      getSpaceKeys: () => [key],
    }).read(id);
  /** What anyone with the server's storage gets for an attachment: the stored blob and its wrapped key. */
  async function stored(id: string) {
    const [answer] = Object.values(await owner.client.resolveAttachments([id])) as { url: string; wrappedKey: string; keyVersion: number; workspaceId: string }[];
    return { blob: await owner.client.downloadRaw(answer.url), wrappedKey: answer.wrappedKey, keyVersion: answer.keyVersion };
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-rot-e2e-'));
    process.env.DATA_DIR = tmpDir;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'rot-test-secret';
    vi.resetModules();
    registry = await import('../db/registry');
    const { workspacesRouter } = await import('../routes/workspaces');
    const { attachmentsRouter } = await import('../routes/attachments');
    const { usageRouter } = await import('../routes/usage');
    const { authRouter } = await import('../routes/auth');
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    app.use('/api/workspaces', workspacesRouter);
    app.use('/api/attachments', attachmentsRouter);
    app.use('/api/usage', usageRouter);
    server = app.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    owner = await makeActor('user-owner');
    member = await makeActor('user-member');
    leaver = await makeActor('user-leaver');
    await createSpace([owner, member, leaver]);
    leaverK1 = await keyOf(leaver);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => { server?.closeAllConnections(); server?.close(() => resolve()); });
      server = null;
    }
    registry.closeRegistryDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const k of ['DATA_DIR', 'NODE_ENV', 'JWT_SECRET']) delete process.env[k];
    vi.resetModules();
  });

  it('control: before anyone is removed, every member reads what another member wrote', async () => {
    const [ko, km, kl] = [await keyOf(owner), await keyOf(member), await keyOf(leaver)];
    expect([ko.keyVersion, km.keyVersion, kl.keyVersion]).toEqual([1, 1, 1]);
    const data = bytesOf(5000);
    await upload(owner, ko, 'att-1', data);
    expect(same(await read(member, km, 'att-1'), data)).toBe(true);
    expect(same(await read(leaver, kl, 'att-1'), data)).toBe(true);
  });

  it('a removed member, holding every key and every stored byte, cannot read what was written after', async () => {
    const ko = await keyOf(owner);
    const kl = leaverK1; // everything the leaver ever holds: K_1
    const before = bytesOf(4000, 3);
    await upload(owner, ko, 'att-before', before);
    const keptBefore = await stored('att-before'); // and the bytes they could fetch while a member

    // The owner removes the leaver.
    const ko2 = await rotateSpace(owner.client, ko, [leaver.id]);
    expect(ko2.keyVersion).toBe(2);

    const after = bytesOf(4000, 9);
    await upload(owner, ko2, 'att-after', after);
    const storedAfter = await stored('att-after');
    expect(storedAfter.keyVersion).toBe(2);

    // An attacker with the server's storage and K_1 tries everything: the attachment's key at either label, the
    // chain's own entry for version 2 (K_1 under K_2, which opens nothing without K_2), and the blob directly.
    const meta = (keyVersion: number) => ({ workspaceId: WS, attachmentId: 'att-after', keyVersion });
    await expect(unwrapAttachmentKey(storedAfter.wrappedKey, kl, meta(2))).rejects.toThrow();
    await expect(unwrapAttachmentKey(storedAfter.wrappedKey, kl, meta(1))).rejects.toThrow(); // relabelled as the old version
    const chain = (await owner.client.getKeychain(WS)).chain;
    expect(chain.map((e) => e.key_version)).toEqual([2]);
    await expect(kl.keyFor(2)).rejects.toThrow(); // K_1 cannot give a newer key
    // The blob without its key is only ciphertext.
    await expect(decryptBlob(storedAfter.blob, kl, 'att-after')).rejects.toThrow();
    // …and what they kept from before is still theirs, offline, which rotation never claimed to change.
    expect(keptBefore.keyVersion).toBe(1);
    const keptKey = await unwrapAttachmentKey(keptBefore.wrappedKey, kl, { workspaceId: WS, attachmentId: 'att-before', keyVersion: 1 });
    expect(same(await decryptBlob(keptBefore.blob, keptKey, 'att-before'), before)).toBe(true);

    // The server's own refusals, as well: not relied on above, but they should hold.
    await expect(fetchSpaceKey(leaver.client, WS, leaver.signing)).rejects.toThrow();
    await expect(leaver.client.getKeychain(WS)).rejects.toThrow();
    await expect(read(leaver, kl, 'att-after')).rejects.toThrow();
  });

  it('the remaining members read old and new content: the new key, and the old ones through the real chain', async () => {
    const [ko, km] = [await keyOf(owner), await keyOf(member)];
    const [a1, a2] = [bytesOf(3000, 5), bytesOf(3000, 6)];
    await upload(owner, ko, 'att-1', a1);
    const ko2 = await rotateSpace(owner.client, ko, [leaver.id]);
    await upload(owner, ko2, 'att-2', a2);

    // The member's key was fetched before the rotation. They fetch again, as `key-rotated` makes them do.
    const km2 = await currentSpaceKey(member.client, km, member.signing);
    expect(km2.keyVersion).toBe(2);
    expect(same(await read(member, km2, 'att-2'), a2)).toBe(true);
    expect(same(await read(member, km2, 'att-1'), a1)).toBe(true); // written at version 1: through the chain
    expect(same(await read(owner, ko2, 'att-1'), a1)).toBe(true);
  });

  it('chains through several rotations: a member reads what was written under every version', async () => {
    let key = await keyOf(owner);
    const written: [string, Uint8Array<ArrayBuffer>][] = [];
    for (let v = 1; v <= 4; v++) {
      const data = bytesOf(1500, v + 20);
      await upload(owner, key, `att-v${v}`, data);
      written.push([`att-v${v}`, data]);
      if (v < 4) key = await rotateSpace(owner.client, key, []);
    }
    expect(key.keyVersion).toBe(4);
    const km = await keyOf(member);
    expect(km.keyVersion).toBe(4);
    for (const [id, data] of written) expect(same(await read(member, km, id), data), id).toBe(true);
    expect(written).toHaveLength(4);
  });

  describe('an upload by a member who has not heard of the rotation', () => {
    it('is refused with the version the Space is at, and nothing is stored', async () => {
      const km = await keyOf(member); // stale after the next line
      await rotateSpace(owner.client, await keyOf(owner), [leaver.id]);

      const err = await upload(member, km, 'att-stale', bytesOf(1000)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(KeyRotatedError);
      expect((err as KeyRotatedError).currentVersion).toBe(2);
      expect(registry.registryStmts.getAttachment.get('att-stale')).toBeUndefined();
    });

    it('goes through once the key is fetched again, with only its key wrapped again: the stored wrapped key is at version 2', async () => {
      const km = await keyOf(member);
      await rotateSpace(owner.client, await keyOf(owner), [leaver.id]);
      const data = bytesOf(2000, 4);

      const { url } = await upload(member, km, 'att-retry', data, true);
      expect(url).toBe('attachment:att-retry');
      const row = registry.registryStmts.getAttachment.get('att-retry') as { key_version: number; status: string };
      expect([row.key_version, row.status]).toEqual([2, 'confirmed']);
      expect(same(await read(owner, await keyOf(owner), 'att-retry'), data)).toBe(true);
      // And the removed member cannot read it.
      await expect(unwrapAttachmentKey((await stored('att-retry')).wrappedKey, leaverK1, { workspaceId: WS, attachmentId: 'att-retry', keyVersion: 2 })).rejects.toThrow();
    });

    it('is refused again, not looped on, when the key fetched is still behind (a client that cannot get the new key)', async () => {
      const km = await keyOf(member);
      await rotateSpace(owner.client, await keyOf(owner), []);
      const err = await uploadEncrypted(member.client, file(bytesOf(500)), km, WS, 'att-behind', async () => km).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(KeyRotatedError);
      expect(registry.registryStmts.getAttachment.get('att-behind')).toBeUndefined();
    });
  });

  describe('rotation by the owner', () => {
    it('is refused to a member, and leaves the Space where it was', async () => {
      const km = await keyOf(member);
      await expect(rotateSpace(member.client, km, [leaver.id])).rejects.toThrow();
      expect((await keyOf(leaver)).keyVersion).toBe(1);
      expect((await owner.client.getWorkspaceMembers(WS)).members).toHaveLength(3);
    });

    it('answers a second rotation from the same version with KeyRotatedError and the version the Space is at', async () => {
      const ko = await keyOf(owner);
      await rotateSpace(owner.client, ko, [leaver.id]);
      const err = await rotateSpace(owner.client, ko, [member.id]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(KeyRotatedError);
      expect((err as KeyRotatedError).currentVersion).toBe(2);
      // The member the second rotation meant to remove is still a member.
      expect((await keyOf(member)).keyVersion).toBe(2);
    });

    it('seals the new key for each remaining member with their own public key: each opens only their copy', async () => {
      await rotateSpace(owner.client, await keyOf(owner), [leaver.id]);
      const [ko, km] = [await keyOf(owner), await keyOf(member)];
      expect(same(ko, km)).toBe(true); // the same key, sealed separately for each
      const sealedFor = (a: Actor) => (registry.registryStmts.getWorkspaceKeyForUser.get(WS, a.id) as { wrapped_key: string }).wrapped_key;
      expect(sealedFor(owner)).not.toBe(sealedFor(member));
    });
  });

  describe('checking every Space held, in one request (/api/auth/me)', () => {
    it('gives the member the new key, which opens what was written before and after', async () => {
      const km = await keyOf(member);
      const ko = await keyOf(owner);
      const before = bytesOf(1200, 2);
      await upload(owner, ko, 'att-a', before);
      await rotateSpace(owner.client, ko, [leaver.id]);

      const answer = (await checkSpaces(member.client, [km], member.signing)).get(WS)!;
      expect(answer.key.keyVersion).toBe(2);
      expect(answer.rotationPending).toBe(false);
      expect(same(await read(member, answer.key, 'att-a'), before)).toBe(true);
    });

    it('gives back the key held when the Space has not moved', async () => {
      const km = await keyOf(member);
      expect((await checkSpaces(member.client, [km], member.signing)).get(WS)!.key).toBe(km);
    });

    it('tells the owner a member left, and not the others', async () => {
      const [ko, km] = [await keyOf(owner), await keyOf(member)];
      await leaver.client.leaveWorkspace(WS);
      expect((await checkSpaces(owner.client, [ko], owner.signing)).get(WS)!.rotationPending).toBe(true);
      expect((await checkSpaces(member.client, [km], member.signing)).get(WS)!.rotationPending).toBe(false);
    });

    it('says nothing of a Space the account is no longer in, or one the server has not heard of', async () => {
      await rotateSpace(owner.client, await keyOf(owner), [leaver.id]);
      const unknown = await generateSpaceKey('ws-not-on-the-server');
      const answer = await checkSpaces(leaver.client, [leaverK1, unknown], leaver.signing);
      expect(answer.size).toBe(0);
    });
  });

  describe('a member who leaves', () => {
    it('is marked for the owner, whose client rotates without removing anyone; the one who left cannot read what follows', async () => {
      const [ko, kl] = [await keyOf(owner), leaverK1];
      await leaver.client.leaveWorkspace(WS);
      expect((await owner.client.getWorkspaceKey(WS)).rotation_pending).toBe(true);

      const ko2 = await rotateSpace(owner.client, ko, []);
      expect((await owner.client.getWorkspaceKey(WS)).rotation_pending).toBe(false);

      const data = bytesOf(2500, 8);
      await upload(owner, ko2, 'att-after-leave', data);
      const s = await stored('att-after-leave');
      await expect(unwrapAttachmentKey(s.wrappedKey, kl, { workspaceId: WS, attachmentId: 'att-after-leave', keyVersion: 2 })).rejects.toThrow();
    });

    it('the owner cannot leave, and a stranger cannot', async () => {
      await expect(owner.client.leaveWorkspace(WS)).rejects.toThrow();
      const stranger = await makeActor('user-stranger');
      await expect(stranger.client.leaveWorkspace(WS)).rejects.toThrow();
    });
  });

  it('content frames follow the same rule: a frame sealed at version 2 is not opened by K_1 however the header is edited', async () => {
    const ko = await keyOf(owner);
    const kl = leaverK1;
    const ko2 = await rotateSpace(owner.client, ko, [leaver.id]);
    const frame = await encryptFrameWithSpaceKey(new TextEncoder().encode('written after removal'), ko2);
    await expect(decryptFrame(frame, kl)).rejects.toThrow();
    const relabelled = new Uint8Array(frame);
    new DataView(relabelled.buffer).setUint32(1, 1, false);
    await expect(decryptFrame(relabelled, kl)).rejects.toThrow();
  });
});
