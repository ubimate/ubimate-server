/**
 * The wire formats against implementations that are not ours (docs/ATTACHMENT-ENCRYPTION.md 4).
 *
 * A round trip through our own encryptor and decryptor proves they agree with each other, not with the spec: a
 * wrong associated-data string on both sides would pass every such test. So:
 *
 *  - known-answer vectors, made with PyNaCl (libsodium's C build) from the spec text, which our decryptors must open;
 *  - the forms built by hand here from the spec (with libsodium called directly and `Buffer` for base64url), which
 *    our decryptors must open, and our output parsed back by hand;
 *  - a seeded fuzz of sizes, ids and versions, with a byte tampered and one form handed to another's decryptor.
 */
import { describe, expect, it } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import {
  BLOB_OVERHEAD, FRAME_OVERHEAD, WRAPPED_KEY_BYTES,
  decryptBlob, decryptFrame, encryptBlob, encryptFrame, frameKeyVersion,
  unwrapAttachmentKey, unwrapPreviousKey, wrapAttachmentKey, wrapPreviousKey,
} from './index';

const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const text = (s: string) => Uint8Array.from(Buffer.from(s, 'utf8'));
const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const unb64u = (s: string) => Uint8Array.from(Buffer.from(s, 'base64url'));
const cat = (...parts: Uint8Array[]) => Uint8Array.from(Buffer.concat(parts));

// --- the known answers: made with PyNaCl from the spec, key = 1..32, A = 101..132, K_prev = 201..232 -------------------

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const A = Uint8Array.from({ length: 32 }, (_, i) => i + 101);
const K_PREV = Uint8Array.from({ length: 32 }, (_, i) => i + 201);
const PLAIN = text('hello, attachment');
const BLOB = hex('020708090a0b0c0d0e0f101112131415161718191a1b1c1d1e5eca6df5a6c40380100ca3ddbc6de56c0278008ce067b5f64564fa32093c27a542');
const FRAME = hex('02000000030e0f101112131415161718191a1b1c1d1e1f2021222324259ea476ea08fafd2f860c465880b30e37876ffa693fe78dcf975a57be9549492eb0');
const WRAP = 'FRYXGBkaGxwdHh8gISIjJCUmJygpKissPTC9Spl-H2LiQHBZisHsC38KbByvaMjjgA8eXoiXSuN50U93OSVcSZjNgBM4-OLH';
const CHAIN = 'HB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzWmJApxbX7VqIkWhje6HgWDwoy_w5zQt9NDo9cFdN1ej8tZzSFXITnidLKJi8e_W-';

describe('known answers', () => {
  it('opens a blob made elsewhere, for its id only', async () => {
    expect([...await decryptBlob(BLOB, A, 'att-1')]).toEqual([...PLAIN]);
    await expect(decryptBlob(BLOB, A, 'att-2')).rejects.toThrow();
    await expect(decryptBlob(BLOB, K_PREV, 'att-1')).rejects.toThrow();
  });

  it('opens a frame made elsewhere, and reads its version', async () => {
    expect(frameKeyVersion(FRAME)).toBe(3);
    expect([...await decryptFrame(FRAME, KEY)]).toEqual([...PLAIN]);
    await expect(decryptFrame(FRAME, A)).rejects.toThrow();
  });

  it('opens a wrapped attachment key made elsewhere, for its Space, attachment and version only', async () => {
    expect([...await unwrapAttachmentKey(WRAP, KEY, { workspaceId: 'ws-1', attachmentId: 'att-1', keyVersion: 3 })]).toEqual([...A]);
    for (const wrong of [{ workspaceId: 'ws-2' }, { attachmentId: 'att-2' }, { keyVersion: 4 }]) {
      await expect(unwrapAttachmentKey(WRAP, KEY, { workspaceId: 'ws-1', attachmentId: 'att-1', keyVersion: 3, ...wrong })).rejects.toThrow();
    }
  });

  it('opens a chain entry made elsewhere, for its Space and version only', async () => {
    expect([...await unwrapPreviousKey(CHAIN, KEY, 'ws-1', 4)]).toEqual([...K_PREV]);
    await expect(unwrapPreviousKey(CHAIN, KEY, 'ws-2', 4)).rejects.toThrow();
    await expect(unwrapPreviousKey(CHAIN, KEY, 'ws-1', 3)).rejects.toThrow();
  });
});

// --- the forms, built by hand from the spec ----------------------------------------------------------------------------

async function aead(message: Uint8Array, ad: Uint8Array | string, nonce: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  await _sodium.ready;
  return _sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(message, ad, null, nonce, key);
}
async function unaead(boxed: Uint8Array, ad: Uint8Array | string, nonce: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  await _sodium.ready;
  return _sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, boxed, ad, nonce, key);
}

/** §4.1: 0x02 || nonce (24) || AEAD(plaintext, A, nonce, AD = "ubimate:blob:2:" + attachmentId) */
const specBlob = async (pt: Uint8Array, a: Uint8Array, id: string, nonce: Uint8Array) => cat(Uint8Array.of(2), nonce, await aead(pt, `ubimate:blob:2:${id}`, nonce, a));
/** §4.3: 0x02 || keyVersion (uint32 BE) || nonce (24) || AEAD(plaintext, K_v, nonce, AD = bytes 0..4) */
const specFrame = async (pt: Uint8Array, k: Uint8Array, v: number, nonce: Uint8Array) => {
  const header = Uint8Array.of(2, (v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  return cat(header, nonce, await aead(pt, header, nonce, k));
};
/** §4.2: base64( nonce (24) || AEAD(A, K_v, nonce, AD = "ubimate:attkey:2:" + workspaceId + ":" + attachmentId + ":" + v) ) */
const specWrap = async (a: Uint8Array, k: Uint8Array, ws: string, id: string, v: number, nonce: Uint8Array) =>
  b64u(cat(nonce, await aead(a, `ubimate:attkey:2:${ws}:${id}:${v}`, nonce, k)));
/** §4.4: base64( nonce (24) || AEAD(K_{v-1}, K_v, nonce, AD = "ubimate:keychain:" + workspaceId + ":" + v) ) */
const specChain = async (prev: Uint8Array, k: Uint8Array, ws: string, v: number, nonce: Uint8Array) =>
  b64u(cat(nonce, await aead(prev, `ubimate:keychain:${ws}:${v}`, nonce, k)));

// A small seeded generator, so a failure names its inputs and replays.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-';
function inputs(r: () => number) {
  const bytes = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
  const id = (min: number) => Array.from({ length: min + Math.floor(r() * 40) }, () => ID_CHARS[Math.floor(r() * ID_CHARS.length)]).join('');
  const edge = [1, 2, 255, 256, 65535, 65536, 16777215, 16777216, 0x7fffffff, 0x80000000, 0xffffffff];
  return {
    plaintext: bytes(Math.floor(r() * 2000)),
    a: bytes(32), k: bytes(32), kPrev: bytes(32), nonce: bytes(24),
    attachmentId: id(1), workspaceId: id(1),
    version: r() < 0.4 ? edge[Math.floor(r() * edge.length)] : 1 + Math.floor(r() * 5000),
  };
}

describe('the forms built by hand from the spec', () => {
  it('are opened by our decryptors', async () => {
    const r = rng(20261031);
    for (let i = 0; i < 60; i++) {
      const x = inputs(r);
      const ctx = `case ${i} v=${x.version} id=${x.attachmentId}`;
      expect([...await decryptBlob(await specBlob(x.plaintext, x.a, x.attachmentId, x.nonce), x.a, x.attachmentId)], ctx).toEqual([...x.plaintext]);
      const frame = await specFrame(x.plaintext, x.k, x.version, x.nonce);
      expect(frameKeyVersion(frame), ctx).toBe(x.version);
      expect([...await decryptFrame(frame, x.k)], ctx).toEqual([...x.plaintext]);
      const wrapped = await specWrap(x.a, x.k, x.workspaceId, x.attachmentId, x.version, x.nonce);
      expect([...await unwrapAttachmentKey(wrapped, x.k, { workspaceId: x.workspaceId, attachmentId: x.attachmentId, keyVersion: x.version })], ctx).toEqual([...x.a]);
      if (x.version >= 2) {
        const entry = await specChain(x.kPrev, x.k, x.workspaceId, x.version, x.nonce);
        expect([...await unwrapPreviousKey(entry, x.k, x.workspaceId, x.version)], ctx).toEqual([...x.kPrev]);
      }
    }
  });

  it('are what our encryptors write, taken apart by hand', async () => {
    const r = rng(77);
    for (let i = 0; i < 60; i++) {
      const x = inputs(r);
      const ctx = `case ${i} v=${x.version}`;

      const blob = await encryptBlob(x.plaintext, x.a, x.attachmentId);
      expect(blob[0], ctx).toBe(2);
      expect(blob.length, ctx).toBe(x.plaintext.length + BLOB_OVERHEAD);
      expect([...await unaead(blob.slice(25), `ubimate:blob:2:${x.attachmentId}`, blob.slice(1, 25), x.a)], ctx).toEqual([...x.plaintext]);

      const frame = await encryptFrame(x.plaintext, x.k, x.version);
      expect([...frame.slice(0, 5)], ctx).toEqual([2, (x.version >>> 24) & 255, (x.version >>> 16) & 255, (x.version >>> 8) & 255, x.version & 255]);
      expect(frame.length, ctx).toBe(x.plaintext.length + FRAME_OVERHEAD);
      expect([...await unaead(frame.slice(29), frame.slice(0, 5), frame.slice(5, 29), x.k)], ctx).toEqual([...x.plaintext]);

      const wrapped = unb64u(await wrapAttachmentKey(x.a, x.k, { workspaceId: x.workspaceId, attachmentId: x.attachmentId, keyVersion: x.version }));
      expect(wrapped.length, ctx).toBe(WRAPPED_KEY_BYTES);
      expect([...await unaead(wrapped.slice(24), `ubimate:attkey:2:${x.workspaceId}:${x.attachmentId}:${x.version}`, wrapped.slice(0, 24), x.k)], ctx).toEqual([...x.a]);

      if (x.version >= 2) {
        const entry = unb64u(await wrapPreviousKey(x.kPrev, x.k, x.workspaceId, x.version));
        expect(entry.length, ctx).toBe(WRAPPED_KEY_BYTES);
        expect([...await unaead(entry.slice(24), `ubimate:keychain:${x.workspaceId}:${x.version}`, entry.slice(0, 24), x.k)], ctx).toEqual([...x.kPrev]);
      }
    }
  });
});

describe('fuzz', () => {
  it('every form round-trips, and any one tampered byte is refused', async () => {
    const r = rng(424242);
    for (let i = 0; i < 40; i++) {
      const x = inputs(r);
      const ctx = `case ${i} v=${x.version} len=${x.plaintext.length}`;
      const forms: { name: string; bytes: Uint8Array; open: (b: Uint8Array) => Promise<unknown> }[] = [
        { name: 'blob', bytes: await encryptBlob(x.plaintext, x.a, x.attachmentId), open: (b) => decryptBlob(b, x.a, x.attachmentId) },
        { name: 'frame', bytes: await encryptFrame(x.plaintext, x.k, x.version), open: (b) => decryptFrame(b, x.k) },
        { name: 'wrap', bytes: unb64u(await wrapAttachmentKey(x.a, x.k, { workspaceId: x.workspaceId, attachmentId: x.attachmentId, keyVersion: x.version })),
          open: (b) => unwrapAttachmentKey(b64u(b), x.k, { workspaceId: x.workspaceId, attachmentId: x.attachmentId, keyVersion: x.version }) },
      ];
      for (const f of forms) {
        await expect(f.open(f.bytes), `${ctx} ${f.name}`).resolves.toBeDefined();
        const at = Math.floor(r() * f.bytes.length);
        const bad = f.bytes.slice();
        bad[at] ^= 1 << Math.floor(r() * 8);
        await expect(f.open(bad), `${ctx} ${f.name} byte ${at}`).rejects.toThrow();
        // And truncated or extended.
        await expect(f.open(f.bytes.slice(0, -1)), `${ctx} ${f.name} short`).rejects.toThrow();
        await expect(f.open(cat(f.bytes, Uint8Array.of(0))), `${ctx} ${f.name} long`).rejects.toThrow();
      }
    }
  });

  it('no form opens as another: the associated data tells them apart even under the same key', async () => {
    const r = rng(9001);
    for (let i = 0; i < 30; i++) {
      const x = inputs(r);
      const ctx = `case ${i} v=${Math.max(2, x.version)}`;
      const v = Math.max(2, x.version);
      const key = x.k;
      const blob = await encryptBlob(x.plaintext, key, x.attachmentId);
      const frame = await encryptFrame(x.plaintext, key, v);
      const wrap = await wrapAttachmentKey(x.a, key, { workspaceId: x.workspaceId, attachmentId: x.attachmentId, keyVersion: v });
      const chain = await wrapPreviousKey(x.kPrev, key, x.workspaceId, v);

      // A blob handed to the frame decryptor (the format byte is the same), and a frame to the blob's.
      await expect(decryptFrame(blob, key), ctx).rejects.toThrow();
      await expect(decryptBlob(frame, key, x.attachmentId), ctx).rejects.toThrow();
      // A wrapped key as a chain entry, and a chain entry as a wrapped key, under the same Space key.
      await expect(unwrapPreviousKey(wrap, key, x.workspaceId, v), ctx).rejects.toThrow();
      await expect(unwrapAttachmentKey(chain, key, { workspaceId: x.workspaceId, attachmentId: x.attachmentId, keyVersion: v }), ctx).rejects.toThrow();
    }
  });

  it('the overheads are what the spec and the server say', () => {
    expect(BLOB_OVERHEAD).toBe(1 + 24 + 16);
    expect(FRAME_OVERHEAD).toBe(1 + 4 + 24 + 16);
    expect(WRAPPED_KEY_BYTES).toBe(24 + 32 + 16);
    expect(b64u(new Uint8Array(WRAPPED_KEY_BYTES)).length).toBe(96);
  });
});
