import { describe, expect, it } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import {
  decryptFrame,
  decryptFrameString,
  decryptFrameWithKeyring,
  encryptFrame,
  encryptFrameString,
  FRAME_OVERHEAD,
  frameKeyVersion,
  generateContentKey,
} from './contentEncryption';
import { createKeyring, UnknownKeyVersionError } from './keyChain';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('frames (format 2)', () => {
  it('round-trips bytes, including an empty plaintext, at several versions', async () => {
    const key = await generateContentKey();
    for (const version of [1, 2, 300, 0xffffffff]) {
      for (const plaintext of ['hello', '', 'ünïcødé 🔐'.repeat(100)]) {
        const frame = await encryptFrame(bytes(plaintext), key, version);
        expect(text(await decryptFrame(frame, key))).toBe(plaintext);
        expect(frameKeyVersion(frame)).toBe(version);
      }
    }
  });

  it('writes 0x02, the version as a big-endian uint32, a 24-byte nonce, then ciphertext and a 16-byte tag', async () => {
    const key = await generateContentKey();
    const frame = await encryptFrame(bytes('abc'), key, 0x01020304);
    expect(Array.from(frame.slice(0, 5))).toEqual([0x02, 0x01, 0x02, 0x03, 0x04]);
    expect(frame.length).toBe(5 + 24 + 3 + 16);
    expect(frame.length).toBe(FRAME_OVERHEAD + 3);
  });

  it('never writes the earlier 0x01 format, even at version 1', async () => {
    const key = await generateContentKey();
    for (let i = 0; i < 20; i++) expect((await encryptFrame(bytes('x'), key, 1))[0]).toBe(0x02);
  });

  it('uses a fresh nonce each time', async () => {
    const key = await generateContentKey();
    const frames = await Promise.all(Array.from({ length: 50 }, () => encryptFrame(bytes('same'), key, 1)));
    expect(new Set(frames.map((f) => _sodium.to_hex(f.slice(5, 29)))).size).toBe(50);
    expect(new Set(frames.map((f) => _sodium.to_hex(f))).size).toBe(50);
  });

  it('does not contain the plaintext', async () => {
    const key = await generateContentKey();
    const frame = await encryptFrame(bytes('my secret page title'), key, 1);
    expect(_sodium.to_hex(frame)).not.toContain(_sodium.to_hex(bytes('my secret page title')));
  });

  it('refuses the wrong key', async () => {
    const frame = await encryptFrame(bytes('hello'), await generateContentKey(), 1);
    await expect(decryptFrame(frame, await generateContentKey())).rejects.toThrow();
  });

  it('refuses a frame with any single byte changed', async () => {
    const key = await generateContentKey();
    const frame = await encryptFrame(bytes('hello world'), key, 3);
    let refused = 0;
    for (let i = 0; i < frame.length; i++) {
      const tampered = frame.slice();
      tampered[i] ^= 0x01;
      await expect(decryptFrame(tampered, key), `byte ${i}`).rejects.toThrow();
      refused++;
    }
    expect(refused).toBe(5 + 24 + 11 + 16);
  });

  it('refuses a frame whose version bytes were changed, each of the four on its own', async () => {
    // The version is in the associated data, so it is authenticated even though it is plaintext.
    const key = await generateContentKey();
    const frame = await encryptFrame(bytes('hello'), key, 3);
    for (let i = 1; i <= 4; i++) {
      const tampered = frame.slice();
      tampered[i] ^= 0xff;
      expect(frameKeyVersion(tampered)).not.toBe(3);
      await expect(decryptFrame(tampered, key), `version byte ${i}`).rejects.toThrow();
    }
  });

  it('refuses a truncated frame and one too short to hold a tag', async () => {
    const key = await generateContentKey();
    const frame = await encryptFrame(bytes('hello world'), key, 1);
    await expect(decryptFrame(frame.slice(0, -1), key)).rejects.toThrow();
    await expect(decryptFrame(frame.slice(0, FRAME_OVERHEAD - 1), key)).rejects.toThrow('Ciphertext too short');
  });

  it('refuses the earlier 0x01 format and any other unknown format byte', async () => {
    const key = await generateContentKey();
    for (const format of [0x00, 0x01, 0x03]) {
      const frame = await encryptFrame(bytes('hello'), key, 1);
      frame[0] = format;
      await expect(decryptFrame(frame, key)).rejects.toThrow(/Unsupported wire format version.*update your client/);
    }
  });

  it('refuses version 0, to write and to read', async () => {
    const key = await generateContentKey();
    await expect(encryptFrame(bytes('x'), key, 0)).rejects.toThrow();
    const frame = await encryptFrame(bytes('x'), key, 1);
    frame.fill(0, 1, 5);
    expect(() => frameKeyVersion(frame)).toThrow(/version 0/);
  });

  it('refuses a key of the wrong length', async () => {
    await expect(encryptFrame(bytes('x'), new Uint8Array(31), 1)).rejects.toThrow('32 bytes');
  });

  it('reads a frame of a subarray view, not only a standalone buffer', async () => {
    const key = await generateContentKey();
    const frame = await encryptFrame(bytes('view'), key, 7);
    const padded = new Uint8Array(frame.length + 10);
    padded.set(frame, 3);
    const view = padded.subarray(3, 3 + frame.length);
    expect(frameKeyVersion(view)).toBe(7);
    expect(text(await decryptFrame(view, key))).toBe('view');
  });
});

describe('frames with a keyring', () => {
  it('take the key by the version in the header', async () => {
    const k1 = await generateContentKey();
    const k2 = await generateContentKey();
    const { wrapPreviousKey } = await import('./keyChain');
    const chain = new Map([[2, await wrapPreviousKey(k1, k2, 'ws', 2)]]);
    const keyring = createKeyring({ workspaceId: 'ws', currentVersion: 2, currentKey: k2, chain });
    const old = await encryptFrame(bytes('written at 1'), k1, 1);
    const now = await encryptFrame(bytes('written at 2'), k2, 2);
    expect(text(await decryptFrameWithKeyring(old, keyring))).toBe('written at 1');
    expect(text(await decryptFrameWithKeyring(now, keyring))).toBe('written at 2');
  });

  it('say so when the frame is from a version the keyring has not got yet', async () => {
    const k1 = await generateContentKey();
    const keyring = createKeyring({ workspaceId: 'ws', currentVersion: 1, currentKey: k1, chain: new Map() });
    const ahead = await encryptFrame(bytes('x'), await generateContentKey(), 2);
    await expect(decryptFrameWithKeyring(ahead, keyring)).rejects.toBeInstanceOf(UnknownKeyVersionError);
  });
});

describe('encryptFrameString / decryptFrameString', () => {
  it('round-trips through base64', async () => {
    const key = await generateContentKey();
    const encrypted = await encryptFrameString('{"title":"Secret"}', key, 2);
    expect(encrypted).not.toContain('Secret');
    expect(await decryptFrameString(encrypted, key)).toBe('{"title":"Secret"}');
  });

  it('refuses the wrong key', async () => {
    const encrypted = await encryptFrameString('x', await generateContentKey(), 1);
    await expect(decryptFrameString(encrypted, await generateContentKey())).rejects.toThrow();
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
