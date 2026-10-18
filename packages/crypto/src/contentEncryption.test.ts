import { describe, expect, it } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import { decrypt, decryptString, encrypt, encryptString, generateContentKey } from './contentEncryption';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** The format written before the version byte: nonce (24) || ciphertext+MAC. */
async function legacyEncrypt(plaintext: Uint8Array, key: Uint8Array, nonce?: Uint8Array): Promise<Uint8Array> {
  await _sodium.ready;
  const n = nonce ?? _sodium.randombytes_buf(_sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = _sodium.crypto_secretbox_easy(plaintext, n, key);
  const blob = new Uint8Array(n.length + ciphertext.length);
  blob.set(n);
  blob.set(ciphertext, n.length);
  return blob;
}

describe('encrypt / decrypt', () => {
  it('round-trips bytes, including an empty plaintext', async () => {
    const key = await generateContentKey();
    for (const plaintext of ['hello', '', 'ünïcødé 🔐'.repeat(100)]) {
      expect(text(await decrypt(await encrypt(bytes(plaintext), key), key))).toBe(plaintext);
    }
  });

  it('writes version 0x01, then a 24-byte nonce, then ciphertext and a 16-byte MAC', async () => {
    const key = await generateContentKey();
    const blob = await encrypt(bytes('abc'), key);
    expect(blob[0]).toBe(0x01);
    expect(blob.length).toBe(1 + 24 + 3 + 16);
  });

  it('uses a fresh nonce each time, so the same plaintext never encrypts the same way twice', async () => {
    const key = await generateContentKey();
    const blobs = await Promise.all(Array.from({ length: 50 }, () => encrypt(bytes('same'), key)));
    const nonces = new Set(blobs.map((b) => _sodium.to_hex(b.slice(1, 25))));
    const whole = new Set(blobs.map((b) => _sodium.to_hex(b)));
    expect(nonces.size).toBe(50);
    expect(whole.size).toBe(50);
  });

  it('does not contain the plaintext', async () => {
    const key = await generateContentKey();
    const secret = 'my secret page title';
    const blob = await encrypt(bytes(secret), key);
    expect(_sodium.to_hex(blob)).not.toContain(_sodium.to_hex(bytes(secret)));
  });

  it('refuses the wrong key', async () => {
    const blob = await encrypt(bytes('hello'), await generateContentKey());
    await expect(decrypt(blob, await generateContentKey())).rejects.toThrow();
  });

  it('refuses a blob with any single byte changed', async () => {
    const key = await generateContentKey();
    const blob = await encrypt(bytes('hello world'), key);
    // Byte 0 is the version: flipping it leaves the legacy fallback, which also fails.
    let refused = 0;
    for (let i = 0; i < blob.length; i++) {
      const tampered = blob.slice();
      tampered[i] ^= 0x01;
      await expect(decrypt(tampered, key), `byte ${i}`).rejects.toThrow();
      refused++;
    }
    expect(refused).toBe(1 + 24 + 11 + 16);
  });

  it('refuses a truncated blob and one too short to hold a MAC', async () => {
    const key = await generateContentKey();
    const blob = await encrypt(bytes('hello world'), key);
    await expect(decrypt(blob.slice(0, -1), key)).rejects.toThrow();
    await expect(decrypt(blob.slice(0, 1 + 24 + 15), key)).rejects.toThrow('Ciphertext too short');
  });

  it('refuses an unknown version byte with an "update your client" message', async () => {
    const key = await generateContentKey();
    const blob = await encrypt(bytes('hello'), key);
    blob[0] = 0x02;
    await expect(decrypt(blob, key)).rejects.toThrow(/version 0x02.*update your client/);
  });
});

describe('legacy blobs (no version byte)', () => {
  it('still decrypt', async () => {
    const key = await generateContentKey();
    // A nonce that cannot be mistaken for the current version byte.
    const nonce = new Uint8Array(24).fill(0x42);
    expect(text(await decrypt(await legacyEncrypt(bytes('old data'), key, nonce), key))).toBe('old data');
  });

  it('still decrypt when the random nonce happens to start with 0x01', async () => {
    // One legacy blob in 256 has a nonce whose first byte equals WIRE_VERSION, so it
    // reads as the current format. Its data must not be lost to that coincidence.
    const key = await generateContentKey();
    const nonce = new Uint8Array(24).fill(0x42);
    nonce[0] = 0x01;
    expect(text(await decrypt(await legacyEncrypt(bytes('old data'), key, nonce), key))).toBe('old data');
  });

  it('refuse the wrong key', async () => {
    const nonce = new Uint8Array(24).fill(0x42);
    const blob = await legacyEncrypt(bytes('old data'), await generateContentKey(), nonce);
    await expect(decrypt(blob, await generateContentKey())).rejects.toThrow();
  });
});

describe('encryptString / decryptString', () => {
  it('round-trips through base64', async () => {
    const key = await generateContentKey();
    const encrypted = await encryptString('{"title":"Secret"}', key);
    expect(encrypted).not.toContain('Secret');
    expect(await decryptString(encrypted, key)).toBe('{"title":"Secret"}');
  });

  it('refuses the wrong key', async () => {
    const encrypted = await encryptString('x', await generateContentKey());
    await expect(decryptString(encrypted, await generateContentKey())).rejects.toThrow();
  });
});

describe('generateContentKey', () => {
  it('returns 32 random bytes', async () => {
    const a = await generateContentKey();
    const b = await generateContentKey();
    expect(a.length).toBe(32);
    expect(_sodium.to_hex(a)).not.toBe(_sodium.to_hex(b));
  });
});
