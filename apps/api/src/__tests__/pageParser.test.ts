import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  extractDatatableBlocks,
  buildProjectionFromContent,
  findDatatableContentByBlockId,
  rebuildPageProjections,
} from '../pageParser';
import type { BlockRegistryEntry } from '@notefinity/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a Y.Doc with a `'default'` Y.XmlFragment that mirrors the structure
 * TipTap/y-prosemirror writes for a page containing datatable nodes.
 *
 * Each `datatable` Y.XmlElement has a `content` attribute (the ProseMirror
 * attr name) containing the raw YAML+CSV string.
 */
function makePageDoc(
  datatables: Array<{ content: string }>,
  otherNodes: Array<{ type: string }> = [],
): Y.Doc {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment('default');

  // Represent the ProseMirror `doc` node (root)
  const docEl = new Y.XmlElement('doc');

  for (const dt of datatables) {
    const el = new Y.XmlElement('datatable');
    el.setAttribute('content', dt.content);
    docEl.push([el]);
  }

  for (const node of otherNodes) {
    const el = new Y.XmlElement(node.type);
    docEl.push([el]);
  }

  fragment.push([docEl]);
  return ydoc;
}

function makeDatatableContent(blockId: string, label: string): string {
  return [
    `label: ${label}`,
    `blockId: ${blockId}`,
    'columns:',
    '  - name: Name',
    '    type: string',
    '---',
    'Name,_row_id',
    'Alice,row-uuid-1',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// extractDatatableBlocks
// ---------------------------------------------------------------------------

describe('extractDatatableBlocks', () => {
  it('returns an empty map for a doc with no datatable nodes', () => {
    const ydoc = makePageDoc([], [{ type: 'paragraph' }]);
    const result = extractDatatableBlocks(ydoc, 'page-1');
    expect(result.size).toBe(0);
  });

  it('returns an empty map for an empty doc (no XmlFragment content)', () => {
    const ydoc = new Y.Doc();
    const result = extractDatatableBlocks(ydoc, 'page-1');
    expect(result.size).toBe(0);
  });

  it('extracts a single datatable block', () => {
    const content = makeDatatableContent('block-abc', 'My Table');
    const ydoc = makePageDoc([{ content }]);
    const result = extractDatatableBlocks(ydoc, 'page-1');

    expect(result.size).toBe(1);
    const entry = result.get('block-abc');
    expect(entry).toBeDefined();
    expect(entry?.label).toBe('My Table');
    expect(entry?.type).toBe('datatable');
    expect(entry?.documentId).toBe('page-1');
    expect(entry?.relations).toEqual([]);
    expect(typeof entry?.updatedAt).toBe('number');
  });

  it('extracts multiple datatable blocks from one page', () => {
    const ydoc = makePageDoc([
      { content: makeDatatableContent('block-1', 'Tasks') },
      { content: makeDatatableContent('block-2', 'People') },
    ]);
    const result = extractDatatableBlocks(ydoc, 'page-x');

    expect(result.size).toBe(2);
    expect(result.get('block-1')?.label).toBe('Tasks');
    expect(result.get('block-2')?.label).toBe('People');
  });

  it('handles datatable with empty label', () => {
    const content = [
      'label: ',
      'blockId: block-no-label',
      'columns: []',
      '---',
      '_row_id',
    ].join('\n');
    const ydoc = makePageDoc([{ content }]);
    const result = extractDatatableBlocks(ydoc, 'page-2');

    expect(result.size).toBe(1);
    const entry = result.get('block-no-label');
    expect(entry?.label).toBe('');
  });

  it('ignores datatable elements missing the content attribute', () => {
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment('default');
    const el = new Y.XmlElement('datatable');
    // deliberately not setting `content` attr
    fragment.push([el]);

    const result = extractDatatableBlocks(ydoc, 'page-3');
    expect(result.size).toBe(0);
  });

  it('ignores datatable elements with an empty content string', () => {
    const ydoc = makePageDoc([{ content: '' }]);
    const result = extractDatatableBlocks(ydoc, 'page-4');
    expect(result.size).toBe(0);
  });

  it('ignores datatable content missing a blockId', () => {
    const content = 'label: No ID\ncolumns: []\n---\n_row_id';
    const ydoc = makePageDoc([{ content }]);
    const result = extractDatatableBlocks(ydoc, 'page-5');
    expect(result.size).toBe(0);
  });

  it('ignores non-datatable nodes', () => {
    const ydoc = makePageDoc(
      [{ content: makeDatatableContent('block-dt', 'Valid') }],
      [{ type: 'paragraph' }, { type: 'heading' }],
    );
    const result = extractDatatableBlocks(ydoc, 'page-6');
    expect(result.size).toBe(1);
    expect(result.has('block-dt')).toBe(true);
  });

  it('finds datatables nested inside other block elements', () => {
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment('default');

    const docEl = new Y.XmlElement('doc');
    const colsEl = new Y.XmlElement('columns');
    const colEl = new Y.XmlElement('column');
    const dtEl = new Y.XmlElement('datatable');
    dtEl.setAttribute('content', makeDatatableContent('nested-block', 'Nested'));

    colEl.push([dtEl]);
    colsEl.push([colEl]);
    docEl.push([colsEl]);
    fragment.push([docEl]);

    const result = extractDatatableBlocks(ydoc, 'page-nested');
    expect(result.size).toBe(1);
    expect(result.get('nested-block')?.label).toBe('Nested');
  });

  it('uses the provided pageDocId as documentId on each entry', () => {
    const content = makeDatatableContent('block-x', 'Table X');
    const ydoc = makePageDoc([{ content }]);
    const result = extractDatatableBlocks(ydoc, 'my-specific-page-id');

    expect(result.get('block-x')?.documentId).toBe('my-specific-page-id');
  });

  it('extracts relations from YAML relations array', () => {
    const content = [
      'label: Tasks',
      'blockId: block-tasks',
      'columns:',
      '  - name: Name',
      '    type: string',
      'relations:',
      '  - column: Owner',
      '    target: "People(block-people)"',
      '    type: lookup',
    ].join('\n') + '\n---\nName,_row_id\nAlice,row-1';
    const ydoc = makePageDoc([{ content }]);
    const result = extractDatatableBlocks(ydoc, 'page-rel');

    const entry = result.get('block-tasks');
    expect(entry).toBeDefined();
    expect(entry?.relations).toHaveLength(1);
    expect(entry?.relations?.[0].column).toBe('Owner');
    expect(entry?.relations?.[0].targetBlockId).toBe('block-people');
  });

  it('extracts targetBlockId from qualified segment format pageName(pageId)/label(blockId)', () => {
    const content = [
      'label: Tasks',
      'blockId: block-tasks',
      'columns: []',
      'relations:',
      '  - column: Owner',
      '    target: "People(page-abc)/Members(block-members)"',
      '    type: lookup',
    ].join('\n') + '\n---\n_row_id';
    const ydoc = makePageDoc([{ content }]);
    const result = extractDatatableBlocks(ydoc, 'page-q');

    const entry = result.get('block-tasks');
    expect(entry?.relations?.[0].targetBlockId).toBe('block-members');
  });

  it('skips malformed relation entries (missing target)', () => {
    const content = [
      'label: Tasks',
      'blockId: block-tasks',
      'columns: []',
      'relations:',
      '  - column: Owner',
      '    type: lookup',
    ].join('\n') + '\n---\n_row_id';
    const ydoc = makePageDoc([{ content }]);
    const result = extractDatatableBlocks(ydoc, 'page-bad-rel');

    expect(result.get('block-tasks')?.relations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildProjectionFromContent
// ---------------------------------------------------------------------------

function makeCsvContent(blockId: string, label: string, headers: string[], rows: string[][]): string {
  const headerLine = headers.join(',');
  const rowLines = rows.map((r) => r.join(','));
  return [
    `label: ${label}`,
    `blockId: ${blockId}`,
    'columns: []',
    '---',
    headerLine,
    ...rowLines,
  ].join('\n');
}

describe('buildProjectionFromContent', () => {
  it('returns null when no separator is present', () => {
    const result = buildProjectionFromContent('label: x\nblockId: b', ['Name']);
    expect(result).toBeNull();
  });

  it('returns null when columns array is empty', () => {
    const content = makeCsvContent('b', 'T', ['Name', '_row_id'], [['Alice', 'r-1']]);
    expect(buildProjectionFromContent(content, [])).toBeNull();
  });

  it('returns null when CSV is empty after separator', () => {
    const content = 'label: x\nblockId: b\n---\n';
    expect(buildProjectionFromContent(content, ['Name'])).toBeNull();
  });

  it('builds a projection for a single column', () => {
    const content = makeCsvContent('b', 'T', ['Name', 'Age', '_row_id'], [
      ['Alice', '30', 'row-1'],
      ['Bob', '25', 'row-2'],
    ]);
    const proj = buildProjectionFromContent(content, ['Name']);
    expect(proj).not.toBeNull();
    expect(proj?.columns).toEqual(['Name']);
    expect(proj?.rows['row-1']).toEqual({ Name: 'Alice' });
    expect(proj?.rows['row-2']).toEqual({ Name: 'Bob' });
  });

  it('builds a projection for multiple columns', () => {
    const content = makeCsvContent('b', 'T', ['Name', 'Age', '_row_id'], [
      ['Alice', '30', 'row-1'],
    ]);
    const proj = buildProjectionFromContent(content, ['Name', 'Age']);
    expect(proj?.columns).toEqual(['Age', 'Name']); // sorted
    expect(proj?.rows['row-1']).toEqual({ Name: 'Alice', Age: '30' });
  });

  it('skips rows with empty _row_id', () => {
    const content = makeCsvContent('b', 'T', ['Name', '_row_id'], [
      ['Alice', 'row-1'],
      ['Bob', ''],
    ]);
    const proj = buildProjectionFromContent(content, ['Name']);
    expect(Object.keys(proj?.rows ?? {})).toHaveLength(1);
    expect(proj?.rows['row-1']).toBeDefined();
  });

  it('returns null when none of the requested columns exist in headers', () => {
    const content = makeCsvContent('b', 'T', ['Name', '_row_id'], [['Alice', 'r-1']]);
    const proj = buildProjectionFromContent(content, ['NonExistent']);
    expect(proj).toBeNull();
  });

  it('handles quoted CSV fields', () => {
    const content = [
      'label: T',
      'blockId: b',
      'columns: []',
      '---',
      'Name,_row_id',
      '"Alice, Jr.",row-1',
    ].join('\n');
    const proj = buildProjectionFromContent(content, ['Name']);
    expect(proj?.rows['row-1']?.Name).toBe('Alice, Jr.');
  });

  it('handles escaped double-quotes in CSV fields', () => {
    const content = [
      'label: T',
      'blockId: b',
      'columns: []',
      '---',
      'Name,_row_id',
      '"Say ""hi""",row-1',
    ].join('\n');
    const proj = buildProjectionFromContent(content, ['Name']);
    expect(proj?.rows['row-1']?.Name).toBe('Say "hi"');
  });
});

// ---------------------------------------------------------------------------
// findDatatableContentByBlockId
// ---------------------------------------------------------------------------

describe('findDatatableContentByBlockId', () => {
  it('returns null for an empty doc', () => {
    const ydoc = new Y.Doc();
    expect(findDatatableContentByBlockId(ydoc, 'block-x')).toBeNull();
  });

  it('returns null when blockId does not match any datatable', () => {
    const content = makeDatatableContent('block-abc', 'Table');
    const ydoc = makePageDoc([{ content }]);
    expect(findDatatableContentByBlockId(ydoc, 'block-xyz')).toBeNull();
  });

  it('returns the raw content string for a matching blockId', () => {
    const content = makeDatatableContent('block-abc', 'Table');
    const ydoc = makePageDoc([{ content }]);
    expect(findDatatableContentByBlockId(ydoc, 'block-abc')).toBe(content);
  });

  it('returns the correct content from multiple datatables', () => {
    const c1 = makeDatatableContent('block-1', 'First');
    const c2 = makeDatatableContent('block-2', 'Second');
    const ydoc = makePageDoc([{ content: c1 }, { content: c2 }]);
    expect(findDatatableContentByBlockId(ydoc, 'block-2')).toBe(c2);
  });
});

// ---------------------------------------------------------------------------
// rebuildPageProjections
// ---------------------------------------------------------------------------

describe('rebuildPageProjections', () => {
  /** Build a registry Y.Map pre-populated with the given entries. */
  function makeRegistry(
    entries: Array<[string, Partial<BlockRegistryEntry>]>,
  ): { ydoc: Y.Doc; blocks: Y.Map<BlockRegistryEntry> } {
    const ydoc = new Y.Doc();
    const blocks = ydoc.getMap<BlockRegistryEntry>('blocks');
    for (const [id, partial] of entries) {
      const entry: BlockRegistryEntry = {
        documentId: partial.documentId ?? 'page-x',
        label: partial.label ?? 'Label',
        type: partial.type ?? 'datatable',
        relations: partial.relations ?? [],
        projection: partial.projection,
        updatedAt: partial.updatedAt ?? 1000,
      };
      blocks.set(id, entry);
    }
    return { ydoc, blocks };
  }

  it('is a no-op when no blocks are referenced as targets', () => {
    const pageDoc = makePageDoc([{ content: makeDatatableContent('block-a', 'A') }]);
    const { blocks } = makeRegistry([
      ['block-a', { documentId: 'page-1', relations: [] }],
    ]);
    // No consumer references block-a as a target → no change.
    rebuildPageProjections(pageDoc, 'page-1', blocks);
    expect(blocks.get('block-a')?.projection).toBeUndefined();
  });

  it('is a no-op when no consumer has projectedColumns declared', () => {
    const pageDoc = makePageDoc([{ content: makeDatatableContent('block-target', 'Target') }]);
    const { blocks } = makeRegistry([
      ['block-target', { documentId: 'page-target' }],
      ['block-consumer', {
        documentId: 'page-consumer',
        relations: [{ column: 'Ref', targetBlockId: 'block-target', projectedColumns: [] }],
      }],
    ]);
    rebuildPageProjections(pageDoc, 'page-target', blocks);
    expect(blocks.get('block-target')?.projection).toBeUndefined();
  });

  it('rebuilds projection for a target block when consumer declares projectedColumns', () => {
    const targetContent = makeCsvContent('block-target', 'People', ['Name', '_row_id'], [
      ['Alice', 'row-1'],
      ['Bob', 'row-2'],
    ]);
    const pageDoc = makePageDoc([{ content: targetContent }]);

    const { blocks } = makeRegistry([
      ['block-target', { documentId: 'page-target' }],
      ['block-consumer', {
        documentId: 'page-consumer',
        relations: [{ column: 'Person', targetBlockId: 'block-target', projectedColumns: ['Name'] }],
      }],
    ]);

    rebuildPageProjections(pageDoc, 'page-target', blocks);

    const proj = blocks.get('block-target')?.projection;
    expect(proj).toBeDefined();
    expect(proj?.columns).toEqual(['Name']);
    expect(proj?.rows['row-1']).toEqual({ Name: 'Alice' });
    expect(proj?.rows['row-2']).toEqual({ Name: 'Bob' });
  });

  it('merges projectedColumns from multiple consumers', () => {
    const targetContent = makeCsvContent('block-target', 'People', ['Name', 'Age', '_row_id'], [
      ['Alice', '30', 'row-1'],
    ]);
    const pageDoc = makePageDoc([{ content: targetContent }]);

    const { blocks } = makeRegistry([
      ['block-target', { documentId: 'page-target' }],
      ['block-consumer-1', {
        documentId: 'page-a',
        relations: [{ column: 'Person', targetBlockId: 'block-target', projectedColumns: ['Name'] }],
      }],
      ['block-consumer-2', {
        documentId: 'page-b',
        relations: [{ column: 'Person', targetBlockId: 'block-target', projectedColumns: ['Age'] }],
      }],
    ]);

    rebuildPageProjections(pageDoc, 'page-target', blocks);

    const proj = blocks.get('block-target')?.projection;
    expect(proj?.columns).toEqual(['Age', 'Name']); // union, sorted
    expect(proj?.rows['row-1']).toEqual({ Name: 'Alice', Age: '30' });
  });

  it('does not rebuild targets that live on a different page', () => {
    const pageDoc = makePageDoc([]); // current page has no datatables
    const { blocks } = makeRegistry([
      ['block-target', { documentId: 'page-OTHER' }], // target is on a different page
      ['block-consumer', {
        documentId: 'page-current',
        relations: [{ column: 'Ref', targetBlockId: 'block-target', projectedColumns: ['Name'] }],
      }],
    ]);

    rebuildPageProjections(pageDoc, 'page-current', blocks);
    expect(blocks.get('block-target')?.projection).toBeUndefined();
  });

  it('preserves existing fields when updating the projection', () => {
    const targetContent = makeCsvContent('block-t', 'T', ['Name', '_row_id'], [['Alice', 'r-1']]);
    const pageDoc = makePageDoc([{ content: targetContent }]);

    const { blocks } = makeRegistry([
      ['block-t', { documentId: 'page-t', label: 'My Label', relations: [] }],
      ['block-c', {
        documentId: 'page-c',
        relations: [{ column: 'R', targetBlockId: 'block-t', projectedColumns: ['Name'] }],
      }],
    ]);

    rebuildPageProjections(pageDoc, 'page-t', blocks);

    const updated = blocks.get('block-t');
    expect(updated?.label).toBe('My Label'); // preserved
    expect(updated?.projection).toBeDefined(); // added
  });
});
