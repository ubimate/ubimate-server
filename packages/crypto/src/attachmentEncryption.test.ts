import { describe, expect, it } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import {
  BLOB_OVERHEAD,
  decryptBlob,
  encryptBlob,
  generateAttachmentKey,
  unwrapAttachmentKey,
  WRAPPED_KEY_BYTES,
  wrapAttachmentKey,
} from './attachmentEncryption';
import { generateContentKey } from './contentEncryption';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const ctx = { workspaceId: 'ws-1', attachmentId: 'att-1', keyVersion: 3 };

describe('blob (format 2)', () => {
  it('round-trips, including an empty file and a large one', async () => {
    const a = await generateAttachmentKey();
    for (const plaintext of [new Uint8Array(0), bytes('hello'), Uint8Array.from({ length: 5_000_000 }, (_, i) => i % 251)]) {
      const blob = await encryptBlob(plaintext, a, 'att-1');
      expect(blob.length).toBe(plaintext.length + BLOB_OVERHEAD);
      const back = await decryptBlob(blob, a, 'att-1');
      expect(back.length).toBe(plaintext.length);
      expect(Buffer.compare(back, plaintext)).toBe(0);
    }
  });

  it('starts with 0x02 and a 24-byte nonce; the overhead is 41 bytes', async () => {
    const blob = await encryptBlob(bytes('abc'), await generateAttachmentKey(), 'att-1');
    expect(blob[0]).toBe(0x02);
    expect(BLOB_OVERHEAD).toBe(41);
    expect(blob.length).toBe(1 + 24 + 3 + 16);
  });

  it('does not decrypt under a different attachment id', async () => {
    const a = await generateAttachmentKey();
    const blob = await encryptBlob(bytes('hello'), a, 'att-1');
    await expect(decryptBlob(blob, a, 'att-2')).rejects.toThrow();
  });

  it('refuses the wrong key, a changed byte, a truncation and an unknown format', async () => {
    const a = await generateAttachmentKey();
    const blob = await encryptBlob(bytes('hello world'), a, 'att-1');
    await expect(decryptBlob(blob, await generateAttachmentKey(), 'att-1')).rejects.toThrow();
    for (let i = 0; i < blob.length; i++) {
      const t = blob.slice();
      t[i] ^= 1;
      await expect(decryptBlob(t, a, 'att-1'), `byte ${i}`).rejects.toThrow();
    }
    await expect(decryptBlob(blob.slice(0, -1), a, 'att-1')).rejects.toThrow();
    await expect(decryptBlob(blob.slice(0, BLOB_OVERHEAD - 1), a, 'att-1')).rejects.toThrow('Ciphertext too short');
    for (const format of [0x00, 0x01, 0x03]) {
      const t = blob.slice();
      t[0] = format;
      await expect(decryptBlob(t, a, 'att-1')).rejects.toThrow(/Unsupported blob format.*update your client/);
    }
  });

  it('refuses an id that would make the associated data ambiguous', async () => {
    const a = await generateAttachmentKey();
    await expect(encryptBlob(bytes('x'), a, 'a:b')).rejects.toThrow("without ':'");
    await expect(encryptBlob(bytes('x'), a, '')).rejects.toThrow();
  });

  it('uses a fresh nonce each time and hides the plaintext', async () => {
    const a = await generateAttachmentKey();
    const blobs = await Promise.all(Array.from({ length: 30 }, () => encryptBlob(bytes('same bytes'), a, 'att-1')));
    expect(new Set(blobs.map((b) => _sodium.to_hex(b.slice(1, 25)))).size).toBe(30);
    expect(_sodium.to_hex(blobs[0])).not.toContain(_sodium.to_hex(bytes('same bytes')));
  });
});

describe('wrapped attachment key', () => {
  it('round-trips, and is 72 bytes before base64', async () => {
    const a = await generateAttachmentKey();
    const k = await generateContentKey();
    const wrapped = await wrapAttachmentKey(a, k, ctx);
    expect(_sodium.from_base64(wrapped).length).toBe(WRAPPED_KEY_BYTES);
    expect(WRAPPED_KEY_BYTES).toBe(72);
    expect(await unwrapAttachmentKey(wrapped, k, ctx)).toEqual(a);
  });

  it('is not accepted for another attachment, another Space or another version', async () => {
    const a = await generateAttachmentKey();
    const k = await generateContentKey();
    const wrapped = await wrapAttachmentKey(a, k, ctx);
    await expect(unwrapAttachmentKey(wrapped, k, { ...ctx, attachmentId: 'att-2' })).rejects.toThrow();
    await expect(unwrapAttachmentKey(wrapped, k, { ...ctx, workspaceId: 'ws-2' })).rejects.toThrow();
    await expect(unwrapAttachmentKey(wrapped, k, { ...ctx, keyVersion: 4 })).rejects.toThrow();
    await expect(unwrapAttachmentKey(wrapped, k, { ...ctx, keyVersion: 2 })).rejects.toThrow();
  });

  it('is not accepted under another key, or with a changed byte', async () => {
    const a = await generateAttachmentKey();
    const k = await generateContentKey();
    const wrapped = _sodium.from_base64(await wrapAttachmentKey(a, k, ctx));
    await expect(unwrapAttachmentKey(_sodium.to_base64(wrapped), await generateContentKey(), ctx)).rejects.toThrow();
    for (let i = 0; i < wrapped.length; i++) {
      const t = wrapped.slice();
      t[i] ^= 1;
      await expect(unwrapAttachmentKey(_sodium.to_base64(t), k, ctx), `byte ${i}`).rejects.toThrow();
    }
  });

  it('keeps the ids apart: ("a", "b:c") and ("a:b", "c") cannot collide', async () => {
    const k = await generateContentKey();
    const a = await generateAttachmentKey();
    await expect(wrapAttachmentKey(a, k, { ...ctx, workspaceId: 'a:b' })).rejects.toThrow("without ':'");
  });

  it('re-wrapping under a new version leaves the blob untouched and readable', async () => {
    const a = await generateAttachmentKey();
    const k3 = await generateContentKey();
    const k4 = await generateContentKey();
    const blob = await encryptBlob(bytes('payload'), a, 'att-1');
    const w3 = await wrapAttachmentKey(a, k3, ctx);
    const w4 = await wrapAttachmentKey(await unwrapAttachmentKey(w3, k3, ctx), k4, { ...ctx, keyVersion: 4 });
    expect(text(await decryptBlob(blob, await unwrapAttachmentKey(w4, k4, { ...ctx, keyVersion: 4 }), 'att-1'))).toBe('payload');
  });

  it('refuses keys of the wrong length', async () => {
    const k = await generateContentKey();
    await expect(wrapAttachmentKey(new Uint8Array(16), k, ctx)).rejects.toThrow('32 bytes');
    await expect(wrapAttachmentKey(await generateAttachmentKey(), new Uint8Array(16), ctx)).rejects.toThrow('32 bytes');
  });
});
