import { describe, expect, it } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import { deriveKeypair } from './keyDerivation';
import { ed25519ToX25519Public, openSealedBox, sealWithPublicKey } from './keyWrapping';
import { generateContentKey } from './contentEncryption';

describe('deriveKeypair', () => {
  it('derives the same public key it always has for a fixed passphrase and email', async () => {
    // Pinned on purpose. A change to the salt, the Argon2id parameters or libsodium's
    // output would derive different keys and lock every existing account out of its
    // wrapped content keys. If this fails, find out why before updating the value.
    const kp = await deriveKeypair('correct horse battery staple', 'alice@example.com');
    expect(kp.ed25519PublicKeyBase64).toBe('ndDgLKRJjl_9dp7IvMAVp2EMjPn3jZqvqtHjCmp7ohU');
  });

  it('is deterministic, and the X25519 public key matches the converted Ed25519 one', async () => {
    const a = await deriveKeypair('passphrase one', 'bob@example.com');
    const b = await deriveKeypair('passphrase one', 'bob@example.com');
    expect(_sodium.to_hex(a.ed25519PrivateKey)).toBe(_sodium.to_hex(b.ed25519PrivateKey));
    expect(_sodium.to_hex(a.x25519PrivateKey)).toBe(_sodium.to_hex(b.x25519PrivateKey));
    expect(_sodium.to_hex(await ed25519ToX25519Public(a.ed25519PublicKey))).toBe(_sodium.to_hex(a.x25519PublicKey));
  });

  it('ignores the case of the email, as the server does', async () => {
    const typed = await deriveKeypair('correct horse battery staple', 'Alice@Example.COM');
    expect(typed.ed25519PublicKeyBase64).toBe('ndDgLKRJjl_9dp7IvMAVp2EMjPn3jZqvqtHjCmp7ohU');
  });

  it('ignores spaces around the email, as the server does', async () => {
    const typed = await deriveKeypair('correct horse battery staple', ' alice@example.com\t\n');
    expect(typed.ed25519PublicKeyBase64).toBe('ndDgLKRJjl_9dp7IvMAVp2EMjPn3jZqvqtHjCmp7ohU');
  });

  it('gives a different key for a different passphrase or a different email', async () => {
    const base = await deriveKeypair('passphrase one', 'bob@example.com');
    const otherPassphrase = await deriveKeypair('passphrase two', 'bob@example.com');
    const otherEmail = await deriveKeypair('passphrase one', 'carol@example.com');
    expect(otherPassphrase.ed25519PublicKeyBase64).not.toBe(base.ed25519PublicKeyBase64);
    expect(otherEmail.ed25519PublicKeyBase64).not.toBe(base.ed25519PublicKeyBase64);
  });
});

describe('sealWithPublicKey / openSealedBox', () => {
  it('lets the recipient open a wrapped content key', async () => {
    const recipient = await deriveKeypair('recipient passphrase', 'r@example.com');
    const contentKey = await generateContentKey();
    const sealed = await sealWithPublicKey(contentKey, recipient.x25519PublicKey);
    const opened = await openSealedBox(sealed, recipient.x25519PublicKey, recipient.x25519PrivateKey);
    expect(_sodium.to_hex(opened)).toBe(_sodium.to_hex(contentKey));
  });

  it('refuses anyone else', async () => {
    const recipient = await deriveKeypair('recipient passphrase', 'r@example.com');
    const other = await deriveKeypair('other passphrase', 'o@example.com');
    const sealed = await sealWithPublicKey(await generateContentKey(), recipient.x25519PublicKey);
    await expect(openSealedBox(sealed, other.x25519PublicKey, other.x25519PrivateKey)).rejects.toThrow();
    // The right public key does not help without the matching private key.
    await expect(openSealedBox(sealed, recipient.x25519PublicKey, other.x25519PrivateKey)).rejects.toThrow();
  });

  it('refuses a sealed box with a byte changed', async () => {
    const recipient = await deriveKeypair('recipient passphrase', 'r@example.com');
    await _sodium.ready;
    const sealed = _sodium.from_base64(await sealWithPublicKey(await generateContentKey(), recipient.x25519PublicKey));
    expect(sealed.length).toBe(32 + 32 + 16);
    for (let i = 0; i < sealed.length; i++) {
      const tampered = sealed.slice();
      tampered[i] ^= 0x01;
      await expect(
        openSealedBox(_sodium.to_base64(tampered), recipient.x25519PublicKey, recipient.x25519PrivateKey),
        `byte ${i}`,
      ).rejects.toThrow();
    }
  });

  it('seals the same key differently each time', async () => {
    const recipient = await deriveKeypair('recipient passphrase', 'r@example.com');
    const contentKey = await generateContentKey();
    const a = await sealWithPublicKey(contentKey, recipient.x25519PublicKey);
    const b = await sealWithPublicKey(contentKey, recipient.x25519PublicKey);
    expect(a).not.toBe(b);
  });
});
