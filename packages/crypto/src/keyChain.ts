/**
 * The key chain and the keyring (docs/ATTACHMENT-ENCRYPTION.md 4.4, 8.3).
 *
 * wrapped_previous(v) = base64( nonce (24) || AEAD(K_{v-1}, K_v, AD = "ubimate:keychain:" + workspaceId + ":" + v) )
 *
 * A member holds only the current Space key. Older keys come from walking the chain
 * down. The chain only goes backwards: K_1 gives nothing about K_2.
 */

import _sodium from 'libsodium-wrappers-sumo';
import { aeadDecrypt, aeadEncrypt, assertId, assertKey, assertVersion } from './aead';

const chainAd = (workspaceId: string, version: number) => {
  assertId(workspaceId, 'workspaceId');
  assertVersion(version);
  return `ubimate:keychain:${workspaceId}:${version}`;
};

/** Wrap `K_{version-1}` under `K_version`. Only meaningful for version > 1. */
export async function wrapPreviousKey(
  previousKey: Uint8Array,
  currentKey: Uint8Array,
  workspaceId: string,
  version: number,
): Promise<string> {
  assertKey(previousKey, 'Previous key');
  assertKey(currentKey, 'Current key');
  if (version < 2) throw new Error('Version 1 has no previous key');
  const wrapped = await aeadEncrypt(previousKey, currentKey, chainAd(workspaceId, version));
  await _sodium.ready;
  return _sodium.to_base64(wrapped);
}

/** Recover `K_{version-1}` from the chain entry stored for `version`, using `K_version`. */
export async function unwrapPreviousKey(
  wrappedPrevious: string,
  currentKey: Uint8Array,
  workspaceId: string,
  version: number,
): Promise<Uint8Array> {
  assertKey(currentKey, 'Current key');
  await _sodium.ready;
  const key = await aeadDecrypt(_sodium.from_base64(wrappedPrevious), currentKey, chainAd(workspaceId, version));
  assertKey(key, 'Unwrapped previous key');
  return key;
}

/** The version asked for is not one this keyring can have: callers refetch keys and retry. */
export class UnknownKeyVersionError extends Error {
  readonly version: number;
  readonly currentVersion: number;
  constructor(version: number, currentVersion: number) {
    super(`No key for version ${version} (current version is ${currentVersion})`);
    this.name = 'UnknownKeyVersionError';
    this.version = version;
    this.currentVersion = currentVersion;
  }
}

/** The chain has no entry to walk past `version`. */
export class MissingChainEntryError extends Error {
  readonly version: number;
  constructor(version: number) {
    super(`Key chain has no entry for version ${version}`);
    this.name = 'MissingChainEntryError';
    this.version = version;
  }
}

export interface Keyring {
  readonly workspaceId: string;
  readonly currentVersion: number;
  readonly currentKey: Uint8Array;
  /** `K_v`, walking the chain down from the current key on first need. */
  keyFor(version: number): Promise<Uint8Array>;
}

export interface KeyringOptions {
  workspaceId: string;
  currentVersion: number;
  currentKey: Uint8Array;
  /** `wrapped_previous` by version, as `GET /api/workspaces/:id/keychain` returns it. */
  chain: ReadonlyMap<number, string> | Readonly<Record<number, string>>;
}

export function createKeyring(options: KeyringOptions): Keyring {
  const { workspaceId, currentVersion, currentKey } = options;
  assertId(workspaceId, 'workspaceId');
  assertVersion(currentVersion);
  assertKey(currentKey, 'Current key');
  const entry = (v: number) => (options.chain instanceof Map ? options.chain.get(v) : (options.chain as Record<number, string>)[v]);

  const known = new Map<number, Uint8Array>([[currentVersion, currentKey]]);
  // Known versions are always contiguous, from `lowest` up to the current one.
  let lowest = currentVersion;

  return {
    workspaceId,
    currentVersion,
    currentKey,
    async keyFor(version: number): Promise<Uint8Array> {
      if (!Number.isInteger(version) || version < 1 || version > currentVersion) {
        throw new UnknownKeyVersionError(version, currentVersion);
      }
      while (lowest > version) {
        const wrapped = entry(lowest);
        if (wrapped === undefined) throw new MissingChainEntryError(lowest);
        const previous = await unwrapPreviousKey(wrapped, known.get(lowest)!, workspaceId, lowest);
        known.set(lowest - 1, previous);
        lowest -= 1;
      }
      return known.get(version)!;
    },
  };
}
