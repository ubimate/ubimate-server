/**
 * XChaCha20-Poly1305-IETF with a random 24-byte nonce, shared by every format 2 form
 * (blob, wrapped key, content frame, key chain). Output is nonce (24) || ciphertext+tag.
 * The associated data binds a ciphertext to what it is; each form builds its own.
 */

import _sodium from 'libsodium-wrappers-sumo';

export const KEY_BYTES = 32;
export const NONCE_BYTES = 24;
export const TAG_BYTES = 16;

export function assertKey(key: Uint8Array, what: string): void {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new Error(`${what} must be ${KEY_BYTES} bytes`);
  }
}

/** Ids go into `:`-separated associated data, so one containing `:` would make it ambiguous. */
export function assertId(id: string, what: string): void {
  if (typeof id !== 'string' || id.length === 0 || id.includes(':')) {
    throw new Error(`${what} must be a non-empty string without ':'`);
  }
}

/** Key versions start at 1 (4.3). */
export function assertVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1 || version > 0xffffffff) {
    throw new Error(`Key version must be an integer from 1 to 4294967295, got ${version}`);
  }
}

export async function aeadEncrypt(
  plaintext: Uint8Array,
  key: Uint8Array,
  associatedData: Uint8Array | string,
): Promise<Uint8Array> {
  await _sodium.ready;
  const nonce = _sodium.randombytes_buf(NONCE_BYTES);
  const ciphertext = _sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, associatedData, null, nonce, key);
  const out = new Uint8Array(NONCE_BYTES + ciphertext.length);
  out.set(nonce);
  out.set(ciphertext, NONCE_BYTES);
  return out;
}

/** Throws if the tag does not verify (wrong key, wrong associated data, or any changed byte). */
export async function aeadDecrypt(
  nonceAndCiphertext: Uint8Array,
  key: Uint8Array,
  associatedData: Uint8Array | string,
): Promise<Uint8Array> {
  await _sodium.ready;
  if (nonceAndCiphertext.length < NONCE_BYTES + TAG_BYTES) throw new Error('Ciphertext too short');
  const nonce = nonceAndCiphertext.slice(0, NONCE_BYTES);
  const ciphertext = nonceAndCiphertext.slice(NONCE_BYTES);
  return _sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, associatedData, nonce, key);
}
