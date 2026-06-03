/**
 * Symmetric content encryption using XChaCha20-Poly1305.
 *
 * Algorithm : libsodium crypto_secretbox_easy (XChaCha20-Poly1305)
 * Key       : 32-byte content key, held in memory for the session
 * Nonce     : 24-byte random nonce generated per encryption operation
 * Wire fmt  : nonce (24 bytes) || ciphertext+MAC  (raw Uint8Array)
 *
 * For storage in text columns (e.g. `properties`) callers should base64-encode
 * the result of encrypt() and base64-decode before passing to decrypt().
 */

import _sodium from 'libsodium-wrappers-sumo';

/** Generate a fresh random 32-byte content key. */
export async function generateContentKey(): Promise<Uint8Array> {
  await _sodium.ready;
  return _sodium.randombytes_buf(_sodium.crypto_secretbox_KEYBYTES);
}

/**
 * Encrypt plaintext bytes with the content key.
 * Returns nonce (24 bytes) || ciphertext+MAC as a single Uint8Array.
 */
export async function encrypt(plaintext: Uint8Array, contentKey: Uint8Array): Promise<Uint8Array> {
  await _sodium.ready;
  const sodium = _sodium;

  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, contentKey);

  const result = new Uint8Array(nonce.length + ciphertext.length);
  result.set(nonce, 0);
  result.set(ciphertext, nonce.length);
  return result;
}

/**
 * Decrypt a nonce||ciphertext+MAC blob produced by encrypt().
 * Returns the plaintext bytes or throws if authentication fails.
 */
export async function decrypt(nonceAndCiphertext: Uint8Array, contentKey: Uint8Array): Promise<Uint8Array> {
  await _sodium.ready;
  const sodium = _sodium;

  const nonceLength = sodium.crypto_secretbox_NONCEBYTES;
  if (nonceAndCiphertext.length <= nonceLength) {
    throw new Error('Ciphertext too short');
  }

  const nonce = nonceAndCiphertext.slice(0, nonceLength);
  const ciphertext = nonceAndCiphertext.slice(nonceLength);

  const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, contentKey);
  return plaintext;
}

/** Encrypt a UTF-8 string and return the result as a base64 string. */
export async function encryptString(plaintext: string, contentKey: Uint8Array): Promise<string> {
  await _sodium.ready;
  const bytes = _sodium.from_string(plaintext);
  const encrypted = await encrypt(bytes, contentKey);
  return _sodium.to_base64(encrypted);
}

/** Decrypt a base64 string produced by encryptString() and return the UTF-8 plaintext. */
export async function decryptString(base64Ciphertext: string, contentKey: Uint8Array): Promise<string> {
  await _sodium.ready;
  const bytes = _sodium.from_base64(base64Ciphertext);
  const plaintext = await decrypt(bytes, contentKey);
  return _sodium.to_string(plaintext);
}
