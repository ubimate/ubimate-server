/**
 * A Space key that knows its own version (docs/ATTACHMENT-ENCRYPTION.md 4.3, 4.4, 8.3).
 *
 * A `SpaceKey` is a `Uint8Array` of the key's 32 bytes, so everything that takes the raw key keeps
 * working, with two additions: the version the key is at, and `keyFor(v)`, which gives the key of an
 * older version by walking the key chain down from this one.
 *
 * Sealing and opening content take a `SpaceKey`, not a `Uint8Array`: a key whose version is not known
 * does not type-check, so no call site can label a key with a version it does not hold. Writing
 * content under a version the key is not would make it unreadable later, when the chain walk lands
 * on the wrong key.
 *
 * The chain is fetched only when a frame under an older version has to be opened, once per key, from
 * the source set by `setChainSource` (the app points it at `GET /api/workspaces/:id/keychain`).
 */

import { assertId, assertKey, assertVersion } from './aead';
import { decryptFrame, encryptFrame, frameKeyVersion, generateContentKey } from './contentEncryption';
import { createKeyring, UnknownKeyVersionError, wrapPreviousKey, type Keyring } from './keyChain';
import _sodium from 'libsodium-wrappers-sumo';

/** `wrapped_previous` by version, as `GET /api/workspaces/:id/keychain` returns it. */
export type ChainEntries = ReadonlyMap<number, string> | Readonly<Record<number, string>>;

/** Fetch the key chain of a Space. */
export type ChainSource = (workspaceId: string) => Promise<ChainEntries>;

export interface SpaceKey extends Uint8Array {
  /** The Space this key belongs to; null for a key made before the server gave its Space an id (version 1 only). */
  readonly workspaceId: string | null;
  /** The version of the Space key these bytes are. */
  readonly keyVersion: number;
  /** `K_v` for `v <= keyVersion`; throws `UnknownKeyVersionError` for a newer version, which means: refetch the key. */
  keyFor(version: number): Promise<Uint8Array>;
}

export interface SpaceKeyOptions {
  workspaceId: string | null;
  keyVersion: number;
  /** Overrides the source set by `setChainSource`; for tests. */
  chainSource?: ChainSource;
}

let defaultChainSource: ChainSource | null = null;

/** Where keys fetch their chain from. The app sets this when it has a client; null clears it. */
export function setChainSource(source: ChainSource | null): void {
  defaultChainSource = source;
}

/** Make a `SpaceKey` from the key's bytes (copied), the Space it belongs to and its version. */
export function makeSpaceKey(bytes: Uint8Array, options: SpaceKeyOptions): SpaceKey {
  assertKey(bytes, 'Space key');
  assertVersion(options.keyVersion);
  if (options.workspaceId !== null) assertId(options.workspaceId, 'workspaceId');
  const key = new Uint8Array(bytes);
  const { workspaceId, keyVersion } = options;

  let keyring: Promise<Keyring> | null = null;
  const chain = (): Promise<Keyring> => {
    if (keyring) return keyring;
    const source = options.chainSource ?? defaultChainSource;
    if (workspaceId === null) throw new Error('A Space key made before its Space had an id has no key chain to walk');
    if (!source) throw new Error('No source for the key chain has been set');
    keyring = source(workspaceId).then((entries) => createKeyring({ workspaceId, currentVersion: keyVersion, currentKey: key, chain: entries }));
    // A failed fetch is not remembered: the next frame under an older version tries again.
    keyring.catch(() => { keyring = null; });
    return keyring;
  };

  // Not enumerable, so comparing two keys by value (toEqual, JSON of the bytes) sees only the bytes.
  Object.defineProperties(key, {
    workspaceId: { value: workspaceId },
    keyVersion: { value: keyVersion },
    keyFor: {
      value: async (version: number): Promise<Uint8Array> => {
        if (!Number.isInteger(version) || version < 1 || version > keyVersion) throw new UnknownKeyVersionError(version, keyVersion);
        if (version === keyVersion) return key;
        return (await chain()).keyFor(version);
      },
    },
  });
  return key as SpaceKey;
}

/**
 * The same key, now knowing its Space. A key is made before its Space has an id when the server assigns
 * the id (a new Space, an import); this is the moment it becomes known. A key already bound to another
 * Space is refused: the same bytes must never be taken for two Spaces' keys.
 */
export function bindSpaceKey(key: SpaceKey, workspaceId: string): SpaceKey {
  if (key.workspaceId === workspaceId) return key;
  if (key.workspaceId !== null) throw new Error(`This Space key belongs to ${key.workspaceId}, not ${workspaceId}`);
  return makeSpaceKey(key, { workspaceId, keyVersion: key.keyVersion });
}

/** Whether `value` was made by `makeSpaceKey`. */
export function isSpaceKey(value: unknown): value is SpaceKey {
  return value instanceof Uint8Array && typeof (value as Partial<SpaceKey>).keyVersion === 'number' && typeof (value as Partial<SpaceKey>).keyFor === 'function';
}

/** A fresh Space key at version 1, for a Space being created. Its id is not known yet when the server assigns it. */
export async function generateSpaceKey(workspaceId: string | null = null): Promise<SpaceKey> {
  return makeSpaceKey(await generateContentKey(), { workspaceId, keyVersion: 1 });
}

/** Encrypt as a frame under the key's own version. */
export function encryptFrameWithSpaceKey(plaintext: Uint8Array, key: SpaceKey): Promise<Uint8Array> {
  return encryptFrame(plaintext, key, key.keyVersion);
}

/** Decrypt a frame with the key for the version in its header, walking the chain when that is an older one. */
export async function decryptFrameWithSpaceKey(frame: Uint8Array, key: SpaceKey): Promise<Uint8Array> {
  return decryptFrame(frame, await key.keyFor(frameKeyVersion(frame)));
}

/** `encryptFrameWithSpaceKey` for a string, returned as base64. */
export async function encryptFrameStringWithSpaceKey(plaintext: string, key: SpaceKey): Promise<string> {
  await _sodium.ready;
  return _sodium.to_base64(await encryptFrameWithSpaceKey(_sodium.from_string(plaintext), key));
}

/** `decryptFrameWithSpaceKey` for a base64 frame holding a string. */
export async function decryptFrameStringWithSpaceKey(base64Frame: string, key: SpaceKey): Promise<string> {
  await _sodium.ready;
  return _sodium.to_string(await decryptFrameWithSpaceKey(_sodium.from_base64(base64Frame), key));
}

/**
 * What the owner's client makes to move a Space to its next version: the new key, and `K_v` sealed under it
 * for the chain (`wrappedPrevious`, 4.4). Nothing is sent: the caller seals the new key for each remaining
 * member and posts it all to `POST /api/workspaces/:id/rotate`.
 */
export async function prepareRotation(current: SpaceKey): Promise<{ next: SpaceKey; wrappedPrevious: string }> {
  if (current.workspaceId === null) throw new Error('A Space key without a Space id cannot be rotated');
  const version = current.keyVersion + 1;
  const bytes = await generateContentKey();
  const wrappedPrevious = await wrapPreviousKey(current, bytes, current.workspaceId, version);
  return { next: makeSpaceKey(bytes, { workspaceId: current.workspaceId, keyVersion: version }), wrappedPrevious };
}
