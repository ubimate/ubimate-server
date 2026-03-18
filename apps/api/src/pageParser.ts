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
import type { BlockRegistryEntry } from '@notefinity/types';

// ---------------------------------------------------------------------------
// Minimal YAML front-matter parser
// ---------------------------------------------------------------------------

/**
 * Extract `label` and `blockId` from the YAML front-matter of a datatable
 * content string, without requiring a full YAML parser.
 *
 * Datatable content format:
 * ```
 * label: My Table
 * blockId: <uuid>
 * columns:
 *   - name: Name
 *     type: string
 * ---
 * Name,_row_id
 * Alice,<uuid>
 * ```
 */
function parseDatatableContent(raw: string): { label: string; blockId: string } | null {
  // Everything before the first `\n---\n` separator is the YAML front-matter.
  const sepIdx = raw.indexOf('\n---\n');
  const yamlPart = sepIdx >= 0 ? raw.slice(0, sepIdx) : raw;

  const blockIdMatch = yamlPart.match(/^blockId:[ \t]*(\S+)/m);
  if (!blockIdMatch) return null;

  // Use [ \t]* (not \s*) so we do not consume the newline and accidentally
  // capture the following line when the label value is empty.
  const labelMatch = yamlPart.match(/^label:[ \t]*(.+)/m);
  return {
    blockId: blockIdMatch[1].trim(),
    label: labelMatch ? labelMatch[1].trim() : '',
  };
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
      // `relations` will be populated when datatable relation columns are wired
      // (client-side write helpers — Gap #3 in the implementation roadmap).
      relations: [],
      updatedAt: now,
    });
  }

  return result;
}
