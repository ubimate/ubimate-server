import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { extractDatatableBlocks } from '../pageParser';

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
});
