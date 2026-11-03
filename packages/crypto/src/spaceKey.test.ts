import { afterEach, describe, expect, it, vi } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import { decryptFrame, encryptFrame, frameKeyVersion, generateContentKey } from './contentEncryption';
import { MissingChainEntryError, UnknownKeyVersionError, unwrapPreviousKey } from './keyChain';
import {
  decryptFrameStringWithSpaceKey,
  decryptFrameWithSpaceKey,
  encryptFrameStringWithSpaceKey,
  encryptFrameWithSpaceKey,
  generateSpaceKey,
  isSpaceKey,
  makeSpaceKey,
  prepareRotation,
  setChainSource,
  type ChainSource,
  type SpaceKey,
} from './spaceKey';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** A Space that was rotated `versions - 1` times, the way the owner's client does it, and what the server then holds. */
async function rotatedSpace(versions: number, workspaceId = 'ws') {
  const keys: SpaceKey[] = [];
  const chain = new Map<number, string>();
  keys[1] = await generateSpaceKey(workspaceId);
  for (let v = 2; v <= versions; v++) {
    const { next, wrappedPrevious } = await prepareRotation(keys[v - 1]);
    keys[v] = next;
    chain.set(v, wrappedPrevious);
  }
  return { keys, chain };
}

/** A chain source that counts how often it is asked, and for which Space. */
const countingSource = (chain: Map<number, string>) => {
  const asked: string[] = [];
  const source: ChainSource = async (workspaceId) => { asked.push(workspaceId); return chain; };
  return { source, asked };
};

afterEach(() => setChainSource(null));

describe('making a SpaceKey', () => {
  it('copies the bytes, so changing the original afterwards does not change the key', async () => {
    const raw = await generateContentKey();
    const original = new Uint8Array(raw);
    const key = makeSpaceKey(raw, { workspaceId: 'ws', keyVersion: 2 });
    raw.fill(0);
    expect(key).toEqual(original);
  });

  it('carries its Space and version, and compares equal to its bytes alone', async () => {
    const raw = await generateContentKey();
    const key = makeSpaceKey(raw, { workspaceId: 'ws', keyVersion: 3 });
    expect([key.workspaceId, key.keyVersion]).toEqual(['ws', 3]);
    expect(key).toEqual(raw); // the extras are not enumerable
    expect(Object.keys(key)).toEqual(Object.keys(raw)); // only the byte indices
  });

  it('refuses what is not a key or a version: wrong length, version 0, a fraction, a Space id with a colon', async () => {
    const raw = await generateContentKey();
    expect(() => makeSpaceKey(raw.subarray(0, 31), { workspaceId: 'ws', keyVersion: 1 })).toThrow();
    for (const keyVersion of [0, -1, 1.5, 2 ** 32]) {
      expect(() => makeSpaceKey(raw, { workspaceId: 'ws', keyVersion })).toThrow();
    }
    expect(() => makeSpaceKey(raw, { workspaceId: 'a:b', keyVersion: 1 })).toThrow();
  });

  it('is told from a plain Uint8Array, including a copy of itself: a copy has lost its version', async () => {
    const key = await generateSpaceKey('ws');
    expect(isSpaceKey(key)).toBe(true);
    expect(isSpaceKey(new Uint8Array(key))).toBe(false);
    expect(isSpaceKey(key.slice())).toBe(false);
    expect(isSpaceKey(key.subarray(0))).toBe(false);
    expect(isSpaceKey(null)).toBe(false);
    expect(isSpaceKey({ keyVersion: 1, keyFor: () => null })).toBe(false);
  });

  it('a generated key is at version 1, and two are different', async () => {
    const [a, b] = [await generateSpaceKey('ws'), await generateSpaceKey('ws')];
    expect(a.keyVersion).toBe(1);
    expect(a).not.toEqual(b);
  });
});

describe('keyFor', () => {
  it('gives the key itself for its own version, without asking for the chain', async () => {
    const { source, asked } = countingSource(new Map());
    const key = makeSpaceKey(await generateContentKey(), { workspaceId: 'ws', keyVersion: 3, chainSource: source });
    expect(await key.keyFor(3)).toEqual(key);
    expect(asked).toEqual([]);
  });

  it('walks the chain down for an older version, and asks for it once however many are opened', async () => {
    const { keys, chain } = await rotatedSpace(4);
    const { source, asked } = countingSource(chain);
    const current = makeSpaceKey(keys[4], { workspaceId: 'ws', keyVersion: 4, chainSource: source });
    expect(await current.keyFor(2)).toEqual(keys[2]);
    expect(await current.keyFor(1)).toEqual(keys[1]);
    expect(await current.keyFor(3)).toEqual(keys[3]);
    expect(await current.keyFor(1)).toEqual(keys[1]);
    expect(asked).toEqual(['ws']);
  });

  it('refuses a newer version than its own (the caller refetches the key), and nonsense versions', async () => {
    const key = await generateSpaceKey('ws');
    for (const v of [2, 99, 0, -1, 1.5, Number.NaN]) {
      await expect(key.keyFor(v)).rejects.toBeInstanceOf(UnknownKeyVersionError);
    }
    await expect(key.keyFor(2)).rejects.toMatchObject({ version: 2, currentVersion: 1 });
  });

  it('says why when there is nothing to walk: no source set, or a key whose Space had no id', async () => {
    const { keys } = await rotatedSpace(2);
    const noSource = makeSpaceKey(keys[2], { workspaceId: 'ws', keyVersion: 2 });
    await expect(noSource.keyFor(1)).rejects.toThrow(/No source for the key chain/);
    const noSpace = makeSpaceKey(keys[2], { workspaceId: null, keyVersion: 2, chainSource: async () => new Map() });
    await expect(noSpace.keyFor(1)).rejects.toThrow(/no key chain to walk/);
  });

  it('uses the source set for the app unless the key has its own, and stops when it is cleared', async () => {
    const { keys, chain } = await rotatedSpace(2);
    const { source, asked } = countingSource(chain);
    setChainSource(source);
    expect(await makeSpaceKey(keys[2], { workspaceId: 'ws', keyVersion: 2 }).keyFor(1)).toEqual(keys[1]);
    expect(asked).toEqual(['ws']);
    setChainSource(null);
    await expect(makeSpaceKey(keys[2], { workspaceId: 'ws', keyVersion: 2 }).keyFor(1)).rejects.toThrow();
  });

  it('does not remember a failed fetch: the next older frame tries again', async () => {
    const { keys, chain } = await rotatedSpace(2);
    const source = vi.fn<ChainSource>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(chain);
    const key = makeSpaceKey(keys[2], { workspaceId: 'ws', keyVersion: 2, chainSource: source });
    await expect(key.keyFor(1)).rejects.toThrow('offline');
    expect(await key.keyFor(1)).toEqual(keys[1]);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it('reports a chain with a hole instead of guessing', async () => {
    const { keys, chain } = await rotatedSpace(3);
    chain.delete(2);
    const key = makeSpaceKey(keys[3], { workspaceId: 'ws', keyVersion: 3, chainSource: async () => chain });
    await expect(key.keyFor(1)).rejects.toBeInstanceOf(MissingChainEntryError);
    // K_2 is still reached through the entry for 3; only what lies below the hole is lost.
    expect(await key.keyFor(2)).toEqual(keys[2]);
  });

  it('never returns a wrong key from a chain that belongs to another Space or was altered', async () => {
    const mine = await rotatedSpace(2, 'ws');
    const other = await rotatedSpace(2, 'other');
    const foreign = makeSpaceKey(mine.keys[2], { workspaceId: 'ws', keyVersion: 2, chainSource: async () => other.chain });
    await expect(foreign.keyFor(1)).rejects.toThrow();
    const flipped = new Map(mine.chain);
    const entry = _sodium.from_base64(flipped.get(2)!);
    entry[30] ^= 1;
    flipped.set(2, _sodium.to_base64(entry));
    const altered = makeSpaceKey(mine.keys[2], { workspaceId: 'ws', keyVersion: 2, chainSource: async () => flipped });
    await expect(altered.keyFor(1)).rejects.toThrow();
  });
});

describe('content frames under a SpaceKey', () => {
  it('are written at the key’s own version', async () => {
    const { keys } = await rotatedSpace(3);
    for (const v of [1, 2, 3]) {
      expect(frameKeyVersion(await encryptFrameWithSpaceKey(bytes('x'), keys[v]))).toBe(v);
    }
  });

  it('round-trip, as bytes and as strings', async () => {
    const key = await generateSpaceKey('ws');
    expect(text(await decryptFrameWithSpaceKey(await encryptFrameWithSpaceKey(bytes('héllo'), key), key))).toBe('héllo');
    const b64 = await encryptFrameStringWithSpaceKey('{"title":"Plan"}', key);
    expect(await decryptFrameStringWithSpaceKey(b64, key)).toBe('{"title":"Plan"}');
    expect(b64).not.toContain('Plan');
  });

  it('written before a rotation are still opened by the current key, through the chain; those written after, too', async () => {
    const { keys, chain } = await rotatedSpace(3);
    const frames = await Promise.all([1, 2, 3].map((v) => encryptFrameWithSpaceKey(bytes(`written at ${v}`), keys[v])));
    const { source } = countingSource(chain);
    const current = makeSpaceKey(keys[3], { workspaceId: 'ws', keyVersion: 3, chainSource: source });
    expect(frames).toHaveLength(3);
    for (const [i, frame] of frames.entries()) {
      expect(text(await decryptFrameWithSpaceKey(frame, current))).toBe(`written at ${i + 1}`);
    }
  });

  it('written after a rotation cannot be opened by a holder of an older key, whatever the server serves', async () => {
    // The removed member kept K_1 and every chain entry the server has: the chain only goes down.
    const { keys, chain } = await rotatedSpace(3);
    const leaver = makeSpaceKey(keys[1], { workspaceId: 'ws', keyVersion: 1, chainSource: async () => chain });
    const after = await encryptFrameWithSpaceKey(bytes('secret after removal'), keys[3]);
    await expect(decryptFrameWithSpaceKey(after, leaver)).rejects.toBeInstanceOf(UnknownKeyVersionError);
    // And with the raw bytes, ignoring versions altogether:
    await expect(decryptFrame(after, keys[1])).rejects.toThrow();
    await expect(decryptFrame(after, keys[2])).rejects.toThrow();
    // Neither entry of the chain opens with K_1 either.
    await expect(unwrapPreviousKey(chain.get(2)!, keys[1], 'ws', 2)).rejects.toThrow();
    await expect(unwrapPreviousKey(chain.get(3)!, keys[1], 'ws', 3)).rejects.toThrow();
  });

  it('cannot be passed off as an older version by editing the header: the version is authenticated', async () => {
    const { keys } = await rotatedSpace(2);
    const frame = await encryptFrameWithSpaceKey(bytes('x'), keys[2]);
    const relabelled = new Uint8Array(frame);
    new DataView(relabelled.buffer).setUint32(1, 1, false);
    expect(frameKeyVersion(relabelled)).toBe(1);
    await expect(decryptFrame(relabelled, keys[1])).rejects.toThrow();
    await expect(decryptFrame(relabelled, keys[2])).rejects.toThrow();
  });

  it('are not opened by another Space’s key at the same version', async () => {
    const [a, b] = [await generateSpaceKey('a'), await generateSpaceKey('b')];
    await expect(decryptFrameWithSpaceKey(await encryptFrameWithSpaceKey(bytes('x'), a), b)).rejects.toThrow();
  });

  it('fail in the way a trial over many keys expects, never with a wrong plaintext', async () => {
    const { keys } = await rotatedSpace(2);
    const future = await encryptFrame(bytes('x'), await generateContentKey(), 9);
    await expect(decryptFrameWithSpaceKey(future, keys[2])).rejects.toBeInstanceOf(UnknownKeyVersionError);
    await expect(decryptFrameWithSpaceKey(new Uint8Array(4), keys[2])).rejects.toThrow();
    await expect(decryptFrameWithSpaceKey(new Uint8Array(0), keys[2])).rejects.toThrow();
  });
});

describe('prepareRotation', () => {
  it('makes the next version of the same Space, with a chain entry only the new key opens', async () => {
    const current = await generateSpaceKey('ws');
    const { next, wrappedPrevious } = await prepareRotation(current);
    expect([next.workspaceId, next.keyVersion]).toEqual(['ws', 2]);
    expect(next).not.toEqual(current);
    expect(wrappedPrevious).toHaveLength(96);
    expect(await unwrapPreviousKey(wrappedPrevious, next, 'ws', 2)).toEqual(current);
    await expect(unwrapPreviousKey(wrappedPrevious, current, 'ws', 2)).rejects.toThrow();
    await expect(unwrapPreviousKey(wrappedPrevious, next, 'other', 2)).rejects.toThrow();
    await expect(unwrapPreviousKey(wrappedPrevious, next, 'ws', 3)).rejects.toThrow();
  });

  it('can be repeated: each version’s key opens everything below it', async () => {
    const { keys, chain } = await rotatedSpace(5);
    expect(chain.size).toBe(4);
    const top = makeSpaceKey(keys[5], { workspaceId: 'ws', keyVersion: 5, chainSource: async () => chain });
    for (let v = 1; v <= 5; v++) expect(await top.keyFor(v)).toEqual(keys[v]);
  });

  it('refuses a key that does not know its Space', async () => {
    await expect(prepareRotation(await generateSpaceKey(null))).rejects.toThrow(/without a Space id/);
  });
});
