import { describe, expect, it } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import { generateContentKey, encryptFrame, decryptFrame } from './contentEncryption';
import { generateAttachmentKey, encryptBlob, decryptBlob, unwrapAttachmentKey, wrapAttachmentKey } from './attachmentEncryption';
import {
  createKeyring,
  MissingChainEntryError,
  UnknownKeyVersionError,
  unwrapPreviousKey,
  wrapPreviousKey,
} from './keyChain';

const bytes = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => _sodium.to_hex(b);

/** K_1..K_n and the chain entries a server would hold for them. */
async function space(n: number, workspaceId = 'ws') {
  const keys: Uint8Array[] = [];
  const chain = new Map<number, string>();
  for (let v = 1; v <= n; v++) {
    keys[v] = await generateContentKey();
    if (v > 1) chain.set(v, await wrapPreviousKey(keys[v - 1], keys[v], workspaceId, v));
  }
  return { keys, chain };
}

describe('chain entries', () => {
  it('give back K_{v-1} from K_v', async () => {
    const { keys, chain } = await space(2);
    expect(await unwrapPreviousKey(chain.get(2)!, keys[2], 'ws', 2)).toEqual(keys[1]);
  });

  it('are not accepted for another Space or another version, or under the older key', async () => {
    const { keys, chain } = await space(3);
    await expect(unwrapPreviousKey(chain.get(3)!, keys[3], 'other', 3)).rejects.toThrow();
    await expect(unwrapPreviousKey(chain.get(3)!, keys[3], 'ws', 2)).rejects.toThrow();
    await expect(unwrapPreviousKey(chain.get(3)!, keys[2], 'ws', 3)).rejects.toThrow();
  });

  it('exist only from version 2', async () => {
    const k = await generateContentKey();
    await expect(wrapPreviousKey(k, k, 'ws', 1)).rejects.toThrow('Version 1');
  });
});

describe('keyring', () => {
  it('walking from K_3 gives K_2 and K_1', async () => {
    const { keys, chain } = await space(3);
    const keyring = createKeyring({ workspaceId: 'ws', currentVersion: 3, currentKey: keys[3], chain });
    expect(await keyring.keyFor(3)).toEqual(keys[3]);
    expect(await keyring.keyFor(1)).toEqual(keys[1]);
    expect(await keyring.keyFor(2)).toEqual(keys[2]);
  });

  it('takes the chain as a plain record too', async () => {
    const { keys, chain } = await space(3);
    const keyring = createKeyring({ workspaceId: 'ws', currentVersion: 3, currentKey: keys[3], chain: Object.fromEntries(chain) });
    expect(await keyring.keyFor(1)).toEqual(keys[1]);
  });

  it('a version above the current one is unknown, as are 0 and fractions', async () => {
    const { keys, chain } = await space(3);
    const keyring = createKeyring({ workspaceId: 'ws', currentVersion: 3, currentKey: keys[3], chain });
    for (const v of [4, 0, -1, 1.5]) {
      await expect(keyring.keyFor(v)).rejects.toBeInstanceOf(UnknownKeyVersionError);
    }
    await expect(keyring.keyFor(4)).rejects.toMatchObject({ version: 4, currentVersion: 3 });
  });

  it('says which chain entry is missing, and still serves the versions above it', async () => {
    const { keys, chain } = await space(4);
    chain.delete(2);
    const keyring = createKeyring({ workspaceId: 'ws', currentVersion: 4, currentKey: keys[4], chain });
    await expect(keyring.keyFor(1)).rejects.toMatchObject({ name: 'MissingChainEntryError', version: 2 });
    await expect(keyring.keyFor(1)).rejects.toBeInstanceOf(MissingChainEntryError);
    expect(await keyring.keyFor(2)).toEqual(keys[2]);
  });

  it('refuses a chain entry that was swapped for one of another Space', async () => {
    const mine = await space(2, 'ws');
    const theirs = await space(2, 'other');
    const chain = new Map([[2, theirs.chain.get(2)!]]);
    const keyring = createKeyring({ workspaceId: 'ws', currentVersion: 2, currentKey: mine.keys[2], chain });
    await expect(keyring.keyFor(1)).rejects.toThrow();
  });

  it('K_1 opens nothing written at version 3', async () => {
    const { keys, chain } = await space(3);
    const frame = await encryptFrame(bytes('v3 page'), keys[3], 3);
    await expect(decryptFrame(frame, keys[1])).rejects.toThrow();
    await expect(decryptFrame(frame, keys[2])).rejects.toThrow();
    for (const wrapped of chain.values()) {
      // The chain entries are the only material about K_3 a holder of K_1 could be given.
      await expect(unwrapPreviousKey(wrapped, keys[1], 'ws', 3)).rejects.toThrow();
      await expect(unwrapPreviousKey(wrapped, keys[1], 'ws', 2)).rejects.toThrow();
    }
  });
});

describe('revocation, at the crypto level', () => {
  it('a member removed at version 3 cannot read anything written at version 4', async () => {
    // B held K_1..K_3, the whole chain up to 3, and (breached server) every stored byte.
    const { keys, chain } = await space(4);
    const heldByB = [keys[1], keys[2], keys[3]];

    const a = await generateAttachmentKey();
    const blob = await encryptBlob(bytes('secret file'), a, 'att-9');
    const wrapped = await wrapAttachmentKey(a, keys[4], { workspaceId: 'ws', attachmentId: 'att-9', keyVersion: 4 });
    const frame = await encryptFrame(bytes('secret edit'), keys[4], 4);

    // The server keeps the whole chain, including the entry that holds K_3 under K_4.
    const everyChainEntry = [...chain.entries()];
    const candidates = [...heldByB];
    // Anything B can derive from the chain with what it holds: it can open only entries below its own versions.
    for (const [v, entry] of everyChainEntry) {
      for (const k of heldByB) {
        try { candidates.push(await unwrapPreviousKey(entry, k, 'ws', v)); } catch { /* not openable by B */ }
      }
    }
    expect(candidates.some((k) => hex(k) === hex(keys[4]))).toBe(false);

    for (const k of candidates) {
      await expect(decryptFrame(frame, k)).rejects.toThrow();
      for (const v of [1, 2, 3, 4]) {
        let unwrapped: Uint8Array | undefined;
        try { unwrapped = await unwrapAttachmentKey(wrapped, k, { workspaceId: 'ws', attachmentId: 'att-9', keyVersion: v }); } catch { /* expected */ }
        expect(unwrapped).toBeUndefined();
      }
      // Even guessing the blob's key as a Space key does not help.
      await expect(decryptBlob(blob, k, 'att-9')).rejects.toThrow();
    }

    // The current members still read all of it.
    const keyring = createKeyring({ workspaceId: 'ws', currentVersion: 4, currentKey: keys[4], chain });
    const unwrapped = await unwrapAttachmentKey(wrapped, await keyring.keyFor(4), { workspaceId: 'ws', attachmentId: 'att-9', keyVersion: 4 });
    expect(new TextDecoder().decode(await decryptBlob(blob, unwrapped, 'att-9'))).toBe('secret file');
    expect(new TextDecoder().decode(await decryptFrame(frame, await keyring.keyFor(4)))).toBe('secret edit');
  });
});
