/**
 * pageParser.ts — Server-side extraction of labelled block entries from a page Y.Doc.
 *
 * Walks the Tiptap/ProseMirror Y.XmlFragment stored in the `'default'` shared
 * fragment of a page document and returns all datatable blocks found, ready to
 * be written into the workspace's block-registry document.
 *
 * The TipTap Collaboration extension binds ProseMirror documents to Y.XmlFragment
 * via y-prosemirror. Each ProseMirror node becomes a Y.XmlElement whose:
 *   - `nodeName` equals the ProseMirror node-type name (e.g. `'datatable'`)
 *   - attributes are keyed by ProseMirror attribute name (NOT HTML attribute name)
 *
 * For `DatatableNode`, the relevant ProseMirror attribute is `content` (YAML+CSV).
 */

import * as Y from 'yjs';
import yaml from 'js-yaml';
import type { BlockRegistryEntry } from '@notefinity/types';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface DatatableRelation {
  column: string;
  targetBlockId: string;
  projectedColumns: string[];
}

interface ParsedDatatableContent {
  label: string;
  blockId: string;
  relations: DatatableRelation[];
}

// ---------------------------------------------------------------------------
// YAML front-matter parser
// ---------------------------------------------------------------------------

/**
 * Relation target reference format (per DATATABLE.md §5.1):
 *   [<pageName>(<pageId>)/]<datatableLabel>(<blockId>)
 *
 * The blockId is always the last parenthesized token in the string.
 */
function extractTargetBlockId(targetStr: string): string | null {
  const match = targetStr.match(/\(([^)]+)\)\s*$/);
  return match ? match[1].trim() : null;
}

/**
 * Parse YAML front-matter and extract structured datatable metadata.
 * Uses js-yaml for correct handling of the `relations:` array structure.
 */
function parseDatatableContent(raw: string): ParsedDatatableContent | null {
  const sepIdx = raw.indexOf('\n---\n');
  const yamlPart = sepIdx >= 0 ? raw.slice(0, sepIdx) : raw;

  let parsed: Record<string, unknown> | null;
  try {
    parsed = yaml.load(yamlPart) as Record<string, unknown> | null;
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;

  const blockId = String(parsed.blockId ?? '').trim();
  if (!blockId) return null;

  const label = String(parsed.label ?? '').trim();

  // Parse relations: top-level YAML array
  const rawRels = Array.isArray(parsed.relations) ? parsed.relations : [];
  const relations: DatatableRelation[] = [];
  for (const r of rawRels as Array<Record<string, unknown>>) {
    const column = String(r.column ?? '').trim();
    const targetStr = String(r.target ?? '').trim();
    if (!column || !targetStr) continue;
    const targetBlockId = extractTargetBlockId(targetStr);
    if (!targetBlockId) continue;
    relations.push({ column, targetBlockId, projectedColumns: [] });
  }

  return { label, blockId, relations };
}

// ---------------------------------------------------------------------------
// Minimal RFC 4180 CSV parser (single-line cells only)
// ---------------------------------------------------------------------------

/**
 * Parse a single CSV row, handling quoted fields and escaped double-quotes.
 * Assumes cells do not span multiple lines (sufficient for datatable content
 * where rich-text cells store markdown without embedded newlines).
 */
function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      i++;
      let field = '';
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          field += line[i++];
        }
      }
      fields.push(field);
      if (line[i] === ',') i++;
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) {
        fields.push(line.slice(i));
        break;
      }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

/**
 * Split the CSV section of a datatable content string into a header row and
 * data rows. Returns null when the CSV is empty or malformed.
 */
function parseCsvSection(
  csvPart: string,
): { headers: string[]; dataRows: string[][] } | null {
  const lines = csvPart.trim().split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 1) return null;
  const headers = parseCsvRow(lines[0]);
  const dataRows = lines.slice(1).map(parseCsvRow);
  return { headers, dataRows };
}

// ---------------------------------------------------------------------------
// Projection builder
// ---------------------------------------------------------------------------

/**
 * Build a row projection from datatable content.
 *
 * @param rawContent  The raw YAML+CSV content string.
 * @param columns     Column names to include in the projection.
 * @returns           A projection object or null on parse failure.
 */
export function buildProjectionFromContent(
  rawContent: string,
  columns: string[],
): BlockRegistryEntry['projection'] | null {
  if (columns.length === 0) return null;

  const sepIdx = rawContent.indexOf('\n---\n');
  if (sepIdx < 0) return null;
  const csvPart = rawContent.slice(sepIdx + 5);

  const parsed = parseCsvSection(csvPart);
  if (!parsed) return null;
  const { headers, dataRows } = parsed;

  const colIndices = columns.map((c) => headers.indexOf(c)).filter((i) => i >= 0);
  const validColumns = colIndices.map((i) => headers[i]);
  if (validColumns.length === 0) return null;

  const rowIdIdx = headers.indexOf('_row_id');
  const rows: Record<string, Record<string, string>> = {};

  for (const row of dataRows) {
    const rowId = rowIdIdx >= 0 ? (row[rowIdIdx] ?? '').trim() : '';
    if (!rowId) continue;
    const projected: Record<string, string> = {};
    for (let j = 0; j < colIndices.length; j++) {
      projected[validColumns[j]] = (row[colIndices[j]] ?? '').trim();
    }
    rows[rowId] = projected;
  }

  return { columns: validColumns.sort(), rows };
}

// ---------------------------------------------------------------------------
// Y.XmlFragment recursive walker
// ---------------------------------------------------------------------------

/**
 * Depth-first generator over all Y.XmlElement descendants of a fragment or element.
 */
function* walkXmlElements(
  node: Y.XmlFragment | Y.XmlElement,
): Generator<Y.XmlElement> {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlElement) {
      yield child;
      yield* walkXmlElements(child);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a page Y.Doc for datatable blocks and return a map of
 * `blockId → BlockRegistryEntry` for every datatable found.
 *
 * Returns an empty map when the document has no datatable nodes or when the
 * Yjs document does not yet have a `'default'` XML fragment.
 *
 * @param ydoc      The page Y.Doc (Hocuspocus `Document` instance).
 * @param pageDocId The document ID to record as `documentId` in each entry.
 */
export function extractDatatableBlocks(
  ydoc: Y.Doc,
  pageDocId: string,
): Map<string, BlockRegistryEntry> {
  const result = new Map<string, BlockRegistryEntry>();
  const now = Date.now();

  const fragment = ydoc.getXmlFragment('default');
  for (const elem of walkXmlElements(fragment)) {
    if (elem.nodeName !== 'datatable') continue;

    // y-prosemirror stores ProseMirror attr names → attribute values.
    // DatatableNode's ProseMirror attr `content` holds the YAML+CSV string.
    const raw = elem.getAttribute('content');
    if (typeof raw !== 'string' || !raw) continue;

    const parsed = parseDatatableContent(raw);
    if (!parsed || !parsed.blockId) continue;

    result.set(parsed.blockId, {
      documentId: pageDocId,
      label: parsed.label,
      type: 'datatable',
      relations: parsed.relations,
      updatedAt: now,
    });
  }

  return result;
}

/**
 * Find the raw content string for a datatable with the given `blockId` in a
 * page Y.Doc. Returns null if the block is not found.
 */
export function findDatatableContentByBlockId(
  ydoc: Y.Doc,
  blockId: string,
): string | null {
  const fragment = ydoc.getXmlFragment('default');
  for (const elem of walkXmlElements(fragment)) {
    if (elem.nodeName !== 'datatable') continue;
    const raw = elem.getAttribute('content');
    if (typeof raw !== 'string' || !raw) continue;
    // Quick check before full YAML parse.
    if (!raw.includes(blockId)) continue;
    const parsed = parseDatatableContent(raw);
    if (parsed?.blockId === blockId) return raw;
  }
  return null;
}

/**
 * Rebuild projections for all datatable blocks located on `pageDoc` that are
 * referenced as targets by consumers elsewhere in the registry.
 *
 * Called inside the registry-doc `conn.transact()` callback after upserts and
 * deletes have been applied, so the `blocks` map reflects fully settled state.
 *
 * The function is a no-op when no block on this page is a target, or when no
 * consumer has declared any `projectedColumns` for a target on this page.
 *
 * @param pageDoc    The page Y.Doc that was just saved (the onChange `document`).
 * @param pageDocId  The Hocuspocus document name for `pageDoc`.
 * @param blocks     The `blocks` Y.Map from the workspace's registry Y.Doc.
 */
export function rebuildPageProjections(
  pageDoc: Y.Doc,
  pageDocId: string,
  blocks: Y.Map<BlockRegistryEntry>,
): void {
  // 1. Collect the union of projectedColumns for every block on this page
  //    that is referenced as a target by any consumer in the registry.
  const targetCols = new Map<string, Set<string>>();

  blocks.forEach((entry) => {
    for (const rel of entry.relations ?? []) {
      // Only rebuild projections for target blocks that live on the current page.
      // (We know the target's documentId from its own registry entry.)
      const targetEntry = blocks.get(rel.targetBlockId);
      if (!targetEntry || targetEntry.documentId !== pageDocId) continue;

      if (!targetCols.has(rel.targetBlockId)) {
        targetCols.set(rel.targetBlockId, new Set());
      }
      for (const col of rel.projectedColumns) {
        targetCols.get(rel.targetBlockId)!.add(col);
      }
    }
  });

  if (targetCols.size === 0) return;

  // 2. For each target on this page, extract its current CSV and build the projection.
  for (const [targetBlockId, colSet] of targetCols) {
    if (colSet.size === 0) continue;

    const rawContent = findDatatableContentByBlockId(pageDoc, targetBlockId);
    if (!rawContent) continue;

    const columns = [...colSet].sort();
    const projection = buildProjectionFromContent(rawContent, columns);
    if (!projection) continue;

    const existing = blocks.get(targetBlockId);
    if (existing) {
      blocks.set(targetBlockId, { ...existing, projection });
    }
  }
}
