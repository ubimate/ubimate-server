/**
 * Attachment blobs (format 2) and wrapped attachment keys (docs/ATTACHMENT-ENCRYPTION.md 4.1, 4.2).
 *
 * Blob : 0x02 || nonce (24) || AEAD(plaintext, A, AD = "ubimate:blob:2:" + attachmentId)
 * Wrap : base64( nonce (24) || AEAD(A, K_v, AD = "ubimate:attkey:2:" + workspaceId + ":" + attachmentId + ":" + v) )
 *
 * A is the attachment's own random key. The blob is encrypted once under A; only A is
 * wrapped under the Space key, so a rotation re-wraps 32 bytes and never touches the blob.
 */

import _sodium from 'libsodium-wrappers-sumo';
import { aeadDecrypt, aeadEncrypt, assertId, assertKey, assertVersion, NONCE_BYTES, TAG_BYTES } from './aead';
import { generateContentKey } from './contentEncryption';

export const BLOB_FORMAT = 0x02;
/** Bytes a blob adds to its plaintext: what the server sees as `size` is plaintext + this. */
export const BLOB_OVERHEAD = 1 + NONCE_BYTES + TAG_BYTES;
/** Bytes in a wrapped attachment key before base64. */
export const WRAPPED_KEY_BYTES = NONCE_BYTES + 32 + TAG_BYTES;

export interface AttachmentKeyContext {
  workspaceId: string;
  attachmentId: string;
  keyVersion: number;
}

/** A fresh random attachment key `A`. Never reuse one. */
export const generateAttachmentKey = generateContentKey;

const blobAd = (attachmentId: string) => `ubimate:blob:2:${attachmentId}`;

function wrapAd({ workspaceId, attachmentId, keyVersion }: AttachmentKeyContext): string {
  assertId(workspaceId, 'workspaceId');
  assertId(attachmentId, 'attachmentId');
  assertVersion(keyVersion);
  return `ubimate:attkey:2:${workspaceId}:${attachmentId}:${keyVersion}`;
}

export async function encryptBlob(plaintext: Uint8Array, attachmentKey: Uint8Array, attachmentId: string): Promise<Uint8Array> {
  assertKey(attachmentKey, 'Attachment key');
  assertId(attachmentId, 'attachmentId');
  const body = await aeadEncrypt(plaintext, attachmentKey, blobAd(attachmentId));
  const blob = new Uint8Array(1 + body.length);
  blob[0] = BLOB_FORMAT;
  blob.set(body, 1);
  return blob;
}

/** Throws if the blob is not format 2, or was not encrypted under `attachmentKey` for `attachmentId`. */
export async function decryptBlob(blob: Uint8Array, attachmentKey: Uint8Array, attachmentId: string): Promise<Uint8Array> {
  assertKey(attachmentKey, 'Attachment key');
  assertId(attachmentId, 'attachmentId');
  if (blob.length < BLOB_OVERHEAD) throw new Error('Ciphertext too short');
  if (blob[0] !== BLOB_FORMAT) {
    throw new Error(`Unsupported blob format 0x${blob[0].toString(16).padStart(2, '0')}. Please update your client.`);
  }
  return aeadDecrypt(blob.subarray(1), attachmentKey, blobAd(attachmentId));
}

/** Wrap `A` under the Space key at `context.keyVersion`. Returns base64. */
export async function wrapAttachmentKey(
  attachmentKey: Uint8Array,
  spaceKey: Uint8Array,
  context: AttachmentKeyContext,
): Promise<string> {
  assertKey(attachmentKey, 'Attachment key');
  assertKey(spaceKey, 'Space key');
  const wrapped = await aeadEncrypt(attachmentKey, spaceKey, wrapAd(context));
  await _sodium.ready;
  return _sodium.to_base64(wrapped);
}

/** Throws unless the wrapping was made under this Space key for this exact attachment, Space and version. */
export async function unwrapAttachmentKey(
  wrappedKey: string,
  spaceKey: Uint8Array,
  context: AttachmentKeyContext,
): Promise<Uint8Array> {
  assertKey(spaceKey, 'Space key');
  await _sodium.ready;
  const key = await aeadDecrypt(_sodium.from_base64(wrappedKey), spaceKey, wrapAd(context));
  assertKey(key, 'Unwrapped attachment key');
  return key;
}
