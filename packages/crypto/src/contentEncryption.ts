/**
 * Content frames, format 2: Yjs updates, awareness and encrypted properties.
 *
 * Algorithm : XChaCha20-Poly1305-IETF (see aead.ts)
 * Key       : the 32-byte Space key at the version named in the header
 * Wire fmt  : 0x02 || keyVersion (uint32 BE) || nonce (24) || ciphertext+tag
 * AD        : the five header bytes (0x02 || keyVersion), so a frame whose version
 *             bytes were changed does not decrypt
 *
 * Every frame is written this way, at every version, including version 1. There is no
 * reader for the earlier 0x01 format (docs/ATTACHMENT-ENCRYPTION.md decision 6).
 * The key version is plaintext metadata.
 *
 * For storage in text columns (e.g. `properties`) use the String variants, which
 * base64-encode the frame.
 */

import _sodium from 'libsodium-wrappers-sumo';
import { aeadDecrypt, aeadEncrypt, assertKey, assertVersion, NONCE_BYTES, TAG_BYTES } from './aead';
import type { Keyring } from './keyChain';

export const FRAME_FORMAT = 0x02;
const HEADER_BYTES = 5;
/** Bytes a frame adds to its plaintext. */
export const FRAME_OVERHEAD = HEADER_BYTES + NONCE_BYTES + TAG_BYTES;

/** Generate a fresh random 32-byte key (a Space key, or an attachment key). */
export async function generateContentKey(): Promise<Uint8Array> {
  await _sodium.ready;
  return _sodium.randombytes_buf(_sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
}

/** Encrypt `plaintext` as a format 2 frame under `key`, which is the Space key at `keyVersion`. */
export async function encryptFrame(
  plaintext: Uint8Array,
  key: Uint8Array,
  keyVersion: number,
): Promise<Uint8Array> {
  assertKey(key, 'Content key');
  assertVersion(keyVersion);
  const header = new Uint8Array(HEADER_BYTES);
  header[0] = FRAME_FORMAT;
  new DataView(header.buffer).setUint32(1, keyVersion, false);
  const body = await aeadEncrypt(plaintext, key, header);
  const frame = new Uint8Array(HEADER_BYTES + body.length);
  frame.set(header);
  frame.set(body, HEADER_BYTES);
  return frame;
}

/**
 * The key version a frame names, after checking its format byte and length.
 * Does not authenticate: the version is only trustworthy once decryptFrame succeeds.
 */
export function frameKeyVersion(frame: Uint8Array): number {
  if (frame.length < FRAME_OVERHEAD) throw new Error('Ciphertext too short');
  if (frame[0] !== FRAME_FORMAT) {
    throw new Error(`Unsupported wire format version 0x${frame[0].toString(16).padStart(2, '0')}. Please update your client.`);
  }
  const version = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1, false);
  if (version < 1) throw new Error('Invalid key version 0 in frame header');
  return version;
}

/** Decrypt a frame with the key for its version. Throws if the key, the header or any byte is wrong. */
export async function decryptFrame(frame: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  frameKeyVersion(frame);
  assertKey(key, 'Content key');
  return aeadDecrypt(frame.subarray(HEADER_BYTES), key, frame.slice(0, HEADER_BYTES));
}

/** Decrypt a frame with the key its header names, taken from the Space's keyring. */
export async function decryptFrameWithKeyring(frame: Uint8Array, keyring: Keyring): Promise<Uint8Array> {
  return decryptFrame(frame, await keyring.keyFor(frameKeyVersion(frame)));
}

/** Encrypt a UTF-8 string and return the frame as a base64 string. */
export async function encryptFrameString(plaintext: string, key: Uint8Array, keyVersion: number): Promise<string> {
  await _sodium.ready;
  return _sodium.to_base64(await encryptFrame(_sodium.from_string(plaintext), key, keyVersion));
}

/** Decrypt a base64 frame produced by encryptFrameString() and return the UTF-8 plaintext. */
export async function decryptFrameString(base64Frame: string, key: Uint8Array): Promise<string> {
  await _sodium.ready;
  return _sodium.to_string(await decryptFrame(_sodium.from_base64(base64Frame), key));
}

/** Like decryptFrameString, taking the key by the version in the frame's header. */
export async function decryptFrameStringWithKeyring(base64Frame: string, keyring: Keyring): Promise<string> {
  await _sodium.ready;
  return _sodium.to_string(await decryptFrameWithKeyring(_sodium.from_base64(base64Frame), keyring));
}
