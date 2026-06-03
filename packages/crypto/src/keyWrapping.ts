/**
 * Asymmetric key wrapping using libsodium crypto_box_seal.
 *
 * Used for:
 *   - Wrapping the content key with the user's own X25519 public key at sign-up
 *   - Wrapping the content key with another user's X25519 public key for sharing
 *   - Unwrapping the content key with the user's X25519 private key at session start
 *
 * crypto_box_seal uses X25519 + XSalsa20-Poly1305 (anonymous sender, no shared secret needed).
 * The sealed box can only be opened by the holder of the corresponding private key.
 *
 * Wire format: raw bytes, base64-encoded for transport/storage.
 */

import _sodium from 'libsodium-wrappers-sumo';

/**
 * Wrap (seal) plaintext bytes with a recipient's X25519 public key.
 * Returns the sealed box as a base64 string.
 */
export async function sealWithPublicKey(
  plaintext: Uint8Array,
  recipientX25519PublicKey: Uint8Array,
): Promise<string> {
  await _sodium.ready;
  const sealed = _sodium.crypto_box_seal(plaintext, recipientX25519PublicKey);
  return _sodium.to_base64(sealed);
}

/**
 * Convert an Ed25519 public key to its X25519 (Curve25519) equivalent.
 * This allows sealing a box for a user given only their signing public key.
 */
export async function ed25519ToX25519Public(ed25519PublicKey: Uint8Array): Promise<Uint8Array> {
  await _sodium.ready;
  return _sodium.crypto_sign_ed25519_pk_to_curve25519(ed25519PublicKey);
}

/**
 * Unwrap (open) a sealed box using the recipient's X25519 keypair.
 * Returns the original plaintext bytes or throws if decryption fails.
 */
export async function openSealedBox(
  base64SealedBox: string,
  recipientX25519PublicKey: Uint8Array,
  recipientX25519PrivateKey: Uint8Array,
): Promise<Uint8Array> {
  await _sodium.ready;
  const sealed = _sodium.from_base64(base64SealedBox);
  const plaintext = _sodium.crypto_box_seal_open(
    sealed,
    recipientX25519PublicKey,
    recipientX25519PrivateKey,
  );
  return plaintext;
}
