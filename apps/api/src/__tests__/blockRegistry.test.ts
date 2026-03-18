import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import type { BlockRegistryEntry } from '@notefinity/types';
import {
  blockRegistryDocName,
  isBlockRegistryDoc,
  getBlockRegistryMaps,
  registerBlock,
  unregisterBlock,
  collectUnusedProjection,
} from '../blockRegistry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  overrides: Partial<BlockRegistryEntry> = {},
): BlockRegistryEntry {
  return {
    documentId: 'doc-1',
    label: 'My Block',
    type: 'datatable',
    updatedAt: 1000,
    ...overrides,
  };
}

function freshMaps() {
  const ydoc = new Y.Doc();
  return getBlockRegistryMaps(ydoc);
}

// ---------------------------------------------------------------------------
// blockRegistryDocName
// ---------------------------------------------------------------------------

describe('blockRegistryDocName', () => {
  it('returns the block-registry: prefixed name', () => {
    expect(blockRegistryDocName('ws-123')).toBe('block-registry:ws-123');
  });

  it('works with any workspace id string', () => {
    expect(blockRegistryDocName('abc-def-ghi')).toBe('block-registry:abc-def-ghi');
  });
});

// ---------------------------------------------------------------------------
// isBlockRegistryDoc
// ---------------------------------------------------------------------------

describe('isBlockRegistryDoc', () => {
  it('returns true for block-registry: prefixed names', () => {
    expect(isBlockRegistryDoc('block-registry:ws-123')).toBe(true);
    expect(isBlockRegistryDoc('block-registry:anything')).toBe(true);
  });

  it('returns false for page document names', () => {
    expect(isBlockRegistryDoc('page-abc')).toBe(false);
  });

  it('returns false for workspace document names', () => {
    expect(isBlockRegistryDoc('ws-123')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isBlockRegistryDoc('')).toBe(false);
  });

  it('returns false for names that merely contain the prefix in the middle', () => {
    expect(isBlockRegistryDoc('my-block-registry:ws')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getBlockRegistryMaps
// ---------------------------------------------------------------------------

describe('getBlockRegistryMaps', () => {
  it('returns Y.Map instances for blocks and tagDefs', () => {
    const ydoc = new Y.Doc();
    const { blocks, tagDefs } = getBlockRegistryMaps(ydoc);
    expect(blocks).toBeInstanceOf(Y.Map);
    expect(tagDefs).toBeInstanceOf(Y.Map);
  });

  it('returns stable references to the same maps on repeated calls', () => {
    const ydoc = new Y.Doc();
    const first = getBlockRegistryMaps(ydoc);
    const second = getBlockRegistryMaps(ydoc);
    expect(first.blocks).toBe(second.blocks);
    expect(first.tagDefs).toBe(second.tagDefs);
  });

  it('returns independent maps for different Y.Docs', () => {
    const ydoc1 = new Y.Doc();
    const ydoc2 = new Y.Doc();
    const { blocks: b1 } = getBlockRegistryMaps(ydoc1);
    const { blocks: b2 } = getBlockRegistryMaps(ydoc2);
    expect(b1).not.toBe(b2);
  });
});

// ---------------------------------------------------------------------------
// registerBlock
// ---------------------------------------------------------------------------

describe('registerBlock', () => {
  let blocks: Y.Map<BlockRegistryEntry>;

  beforeEach(() => {
    ({ blocks } = freshMaps());
  });

  it('inserts a new block entry', () => {
    const entry = makeEntry({ label: 'Sales Table' });
    registerBlock(blocks, 'block-1', entry);
    expect(blocks.get('block-1')).toEqual(entry);
  });

  it('overwrites an existing entry (upsert)', () => {
    registerBlock(blocks, 'block-1', makeEntry({ label: 'Old Label', updatedAt: 100 }));
    registerBlock(blocks, 'block-1', makeEntry({ label: 'New Label', updatedAt: 200 }));
    expect(blocks.get('block-1')?.label).toBe('New Label');
    expect(blocks.get('block-1')?.updatedAt).toBe(200);
  });

  it('inserts multiple blocks independently', () => {
    registerBlock(blocks, 'block-1', makeEntry({ label: 'A' }));
    registerBlock(blocks, 'block-2', makeEntry({ label: 'B' }));
    expect(blocks.size).toBe(2);
    expect(blocks.get('block-1')?.label).toBe('A');
    expect(blocks.get('block-2')?.label).toBe('B');
  });

  it('stores optional relation fields', () => {
    const entry = makeEntry({
      relations: [
        { column: 'owner', targetBlockId: 'block-target', projectedColumns: ['name'] },
      ],
    });
    registerBlock(blocks, 'block-1', entry);
    expect(blocks.get('block-1')?.relations?.[0].column).toBe('owner');
  });
});

// ---------------------------------------------------------------------------
// collectUnusedProjection
// ---------------------------------------------------------------------------

describe('collectUnusedProjection', () => {
  it('drops the projection when no consumers remain for a target', () => {
    const { blocks } = freshMaps();

    // Consumer block that references target
    registerBlock(blocks, 'consumer-1', makeEntry({
      type: 'datatable',
      relations: [{ column: 'ref', targetBlockId: 'target-1', projectedColumns: ['name'] }],
    }));
    // Target block with a projection
    registerBlock(blocks, 'target-1', makeEntry({
      type: 'datatable',
      projection: {
        columns: ['name'],
        rows: { 'row-1': { name: 'Alice' } },
      },
    }));

    // Simulate: consumer-1 has been deleted (already removed from map before GC)
    blocks.delete('consumer-1');
    collectUnusedProjection(blocks, 'consumer-1');

    expect(blocks.get('target-1')?.projection).toBeUndefined();
  });

  it('narrows projection columns to the union of remaining consumers', () => {
    const { blocks } = freshMaps();

    // consumer-1 needs [name], consumer-2 needs [name, email]
    registerBlock(blocks, 'consumer-1', makeEntry({
      relations: [{ column: 'a', targetBlockId: 'target-1', projectedColumns: ['name'] }],
    }));
    registerBlock(blocks, 'consumer-2', makeEntry({
      relations: [{ column: 'b', targetBlockId: 'target-1', projectedColumns: ['name', 'email'] }],
    }));
    // Target with projection covering both
    registerBlock(blocks, 'target-1', makeEntry({
      projection: {
        columns: ['email', 'name'],
        rows: {
          'row-1': { name: 'Alice', email: 'alice@example.com' },
        },
      },
    }));

    // consumer-2 is removed — only consumer-1 (needing 'name') remains
    blocks.delete('consumer-2');
    collectUnusedProjection(blocks, 'consumer-2');

    const projection = blocks.get('target-1')?.projection;
    expect(projection?.columns).toEqual(['name']);
    // Row data narrowed to only 'name'
    expect(projection?.rows['row-1']).toEqual({ name: 'Alice' });
    expect(projection?.rows['row-1']).not.toHaveProperty('email');
  });

  it('is a no-op when no block has a projection', () => {
    const { blocks } = freshMaps();
    registerBlock(blocks, 'block-1', makeEntry({ type: 'smart-tag', value: 'high' }));
    // Should not throw
    expect(() => collectUnusedProjection(blocks, 'block-1')).not.toThrow();
    // Entry unchanged
    expect(blocks.get('block-1')?.type).toBe('smart-tag');
  });

  it('leaves projection intact when all remaining consumers need the same columns', () => {
    const { blocks } = freshMaps();

    registerBlock(blocks, 'consumer-1', makeEntry({
      relations: [{ column: 'x', targetBlockId: 'target-1', projectedColumns: ['name'] }],
    }));
    registerBlock(blocks, 'consumer-2', makeEntry({
      relations: [{ column: 'y', targetBlockId: 'target-1', projectedColumns: ['name'] }],
    }));
    registerBlock(blocks, 'target-1', makeEntry({
      projection: {
        columns: ['name'],
        rows: { 'row-1': { name: 'Bob' } },
      },
    }));

    // consumer-2 removed, but consumer-1 still needs 'name' → projection unchanged
    blocks.delete('consumer-2');
    collectUnusedProjection(blocks, 'consumer-2');

    const projection = blocks.get('target-1')?.projection;
    expect(projection?.columns).toEqual(['name']);
    expect(projection?.rows['row-1']?.name).toBe('Bob');
  });

  it('handles multiple targets in one pass', () => {
    const { blocks } = freshMaps();

    // One consumer that references two targets
    registerBlock(blocks, 'consumer-1', makeEntry({
      relations: [
        { column: 'a', targetBlockId: 'target-1', projectedColumns: ['x'] },
        { column: 'b', targetBlockId: 'target-2', projectedColumns: ['y'] },
      ],
    }));
    registerBlock(blocks, 'target-1', makeEntry({
      projection: { columns: ['x'], rows: { r1: { x: '1' } } },
    }));
    registerBlock(blocks, 'target-2', makeEntry({
      projection: { columns: ['y'], rows: { r2: { y: '2' } } },
    }));

    // Delete consumer-1 → both targets lose their only consumer
    blocks.delete('consumer-1');
    collectUnusedProjection(blocks, 'consumer-1');

    expect(blocks.get('target-1')?.projection).toBeUndefined();
    expect(blocks.get('target-2')?.projection).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// unregisterBlock
// ---------------------------------------------------------------------------

describe('unregisterBlock', () => {
  it('removes the block entry from the map', () => {
    const { blocks } = freshMaps();
    registerBlock(blocks, 'block-1', makeEntry());
    expect(blocks.has('block-1')).toBe(true);

    unregisterBlock(blocks, 'block-1');
    expect(blocks.has('block-1')).toBe(false);
  });

  it('runs projection GC after deletion', () => {
    const { blocks } = freshMaps();

    // Register a consumer and a target with projection
    registerBlock(blocks, 'consumer-1', makeEntry({
      relations: [{ column: 'ref', targetBlockId: 'target-1', projectedColumns: ['name'] }],
    }));
    registerBlock(blocks, 'target-1', makeEntry({
      projection: { columns: ['name'], rows: { r1: { name: 'Test' } } },
    }));

    // Unregister consumer-1 → GC should drop target-1's projection
    unregisterBlock(blocks, 'consumer-1');

    expect(blocks.has('consumer-1')).toBe(false);
    expect(blocks.get('target-1')?.projection).toBeUndefined();
  });

  it('is a no-op for a block id that does not exist', () => {
    const { blocks } = freshMaps();
    expect(() => unregisterBlock(blocks, 'nonexistent')).not.toThrow();
  });
});
