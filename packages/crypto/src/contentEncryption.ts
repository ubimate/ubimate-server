/**
 * Symmetric content encryption using XSalsa20-Poly1305.
 *
 * Algorithm : libsodium crypto_secretbox_easy (XSalsa20-Poly1305)
 * Key       : 32-byte content key, held in memory for the session
 * Nonce     : 24-byte random nonce generated per encryption operation
 * Wire fmt  : version (1 byte) || nonce (24 bytes) || ciphertext+MAC  (raw Uint8Array)
 *
 * The version byte is always WIRE_VERSION (0x01) for the current implementation.
 * Clients MUST refuse to decrypt blobs with an unrecognised version byte and
 * surface a "please update your client" prompt to the user.
 *
 * For storage in text columns (e.g. `properties`) callers should base64-encode
 * the result of encrypt() and base64-decode before passing to decrypt().
 */

import _sodium from 'libsodium-wrappers-sumo';

/** Current wire format version. Increment when the encryption algorithm changes. */
const WIRE_VERSION = 0x01;

/** Generate a fresh random 32-byte content key. */
export async function generateContentKey(): Promise<Uint8Array> {
  await _sodium.ready;
  return _sodium.randombytes_buf(_sodium.crypto_secretbox_KEYBYTES);
}

/**
 * Encrypt plaintext bytes with the content key.
 * Returns version (1 byte) || nonce (24 bytes) || ciphertext+MAC as a single Uint8Array.
 */
export async function encrypt(plaintext: Uint8Array, contentKey: Uint8Array): Promise<Uint8Array> {
  await _sodium.ready;
  const sodium = _sodium;

  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, contentKey);

  // Wire format: version (1 byte) || nonce (24 bytes) || ciphertext+MAC
  const result = new Uint8Array(1 + nonce.length + ciphertext.length);
  result[0] = WIRE_VERSION;
  result.set(nonce, 1);
  result.set(ciphertext, 1 + nonce.length);
  return result;
}

/**
 * Decrypt a version||nonce||ciphertext+MAC blob produced by encrypt().
 * Throws if the version byte is unrecognised or if authentication fails.
 * Returns the plaintext bytes.
 *
 * Legacy migration: blobs written before the version prefix was introduced have
 * the wire format  nonce (24 bytes) || ciphertext+MAC  with no leading version
 * byte.  When the first byte is not WIRE_VERSION (0x01), the function
 * transparently attempts legacy decryption so that existing data is not
 * permanently lost on upgrade.  If legacy decryption also fails the Poly1305
 * MAC check, the version-mismatch error is thrown instead so the caller
 * receives a meaningful message.
 */
export async function decrypt(versionedBlob: Uint8Array, contentKey: Uint8Array): Promise<Uint8Array> {
  await _sodium.ready;
  const sodium = _sodium;

  const nonceLength = sodium.crypto_secretbox_NONCEBYTES;
  // Minimum: 1 (version) + 24 (nonce) + 16 (MAC)
  if (versionedBlob.length < 1 + nonceLength + sodium.crypto_secretbox_MACBYTES) {
    throw new Error('Ciphertext too short');
  }

  const version = versionedBlob[0];

  if (version === WIRE_VERSION) {
    // Current format: version (1) || nonce (24) || ciphertext+MAC
    const nonce = versionedBlob.slice(1, 1 + nonceLength);
    const ciphertext = versionedBlob.slice(1 + nonceLength);
    return sodium.crypto_secretbox_open_easy(ciphertext, nonce, contentKey);
  }

  // Legacy format (pre-version-prefix): nonce (24) || ciphertext+MAC
  // Attempt decryption treating the full blob as a legacy payload.
  // If the Poly1305 MAC check also fails, surface the version-mismatch error
  // so the caller knows to prompt the user to update their client.
  if (versionedBlob.length >= nonceLength + sodium.crypto_secretbox_MACBYTES) {
    try {
      const legacyNonce = versionedBlob.slice(0, nonceLength);
      const legacyCiphertext = versionedBlob.slice(nonceLength);
      return sodium.crypto_secretbox_open_easy(legacyCiphertext, legacyNonce, contentKey);
    } catch {
      // Legacy decryption also failed — fall through to version error below.
    }
  }

  throw new Error(
    `Unsupported wire format version 0x${version.toString(16).padStart(2, '0')}. Please update your client.`
  );
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
