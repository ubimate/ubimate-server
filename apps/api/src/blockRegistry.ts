/**
 * blockRegistry.ts — server-side helpers for the block-registry Yjs document.
 *
 * The block registry is a special Yjs document (one per workspace) that holds
 * workspace-wide block metadata: labelled block instances (`blocks` Y.Map) and
 * workspace-level tag schemas (`tagDefs` Y.Map).
 *
 * The document is named `block-registry:<workspaceId>` and persisted through the
 * normal Hocuspocus / yjs_updates pipeline just like any page document.
 *
 * These helpers are called from the Hocuspocus event hooks and can also be imported
 * by any server module that needs to read or write registry state.
 */

import * as Y from 'yjs';
import type { BlockRegistryEntry, TagDefinition } from '@notefinity/types';

// ---------------------------------------------------------------------------
// Naming convention
// ---------------------------------------------------------------------------

/** Returns the Hocuspocus document name for a workspace's block registry. */
export function blockRegistryDocName(workspaceId: string): string {
  return `block-registry:${workspaceId}`;
}

/** Returns true when `documentName` is a block-registry document. */
export function isBlockRegistryDoc(documentName: string): boolean {
  return documentName.startsWith('block-registry:');
}

// ---------------------------------------------------------------------------
// Map accessors
// ---------------------------------------------------------------------------

/**
 * Extract the two top-level shared maps from a block-registry Y.Doc.
 * Safe to call on any Y.Doc — the maps are created lazily if they don't exist.
 */
export function getBlockRegistryMaps(ydoc: Y.Doc): {
  blocks: Y.Map<BlockRegistryEntry>;
  tagDefs: Y.Map<TagDefinition>;
} {
  return {
    blocks: ydoc.getMap<BlockRegistryEntry>('blocks'),
    tagDefs: ydoc.getMap<TagDefinition>('tagDefs'),
  };
}

// ---------------------------------------------------------------------------
// Block entry mutations
// ---------------------------------------------------------------------------

/**
 * Upsert a block entry in the registry.
 * Should be called from the Hocuspocus `onChange` hook (wrapped in Y.transact).
 */
export function registerBlock(
  blocks: Y.Map<BlockRegistryEntry>,
  blockId: string,
  entry: BlockRegistryEntry,
): void {
  blocks.set(blockId, entry);
}

/**
 * Remove a block entry and run the projection GC scan.
 * Must be called AFTER Yjs converges (i.e. in a debounced `afterTransaction` callback),
 * not inside the raw `onChange` delta — mid-merge state can be inconsistent.
 */
export function unregisterBlock(
  blocks: Y.Map<BlockRegistryEntry>,
  blockId: string,
): void {
  blocks.delete(blockId);
  collectUnusedProjection(blocks, blockId);
}

// ---------------------------------------------------------------------------
// Projection garbage collection
// ---------------------------------------------------------------------------

/**
 * Scan the remaining registry entries and drop or narrow the `projection` field
 * from any target block that no longer has active consumers.
 *
 * Called after `blocks.delete(deletedBlockId)` has converged so the map reflects
 * settled post-deletion state. All writes are batched into one Yjs transaction by
 * the caller.
 *
 * Rationale: the `projection` field is owned by TARGET blocks; its `columns` array
 * is the union of all CONSUMER blocks' `projectedColumns` declarations for that target.
 * After a consumer is removed, some projected columns may no longer be needed.
 *
 * @param blocks        The `blocks` Y.Map from the registry Y.Doc.
 * @param deletedBlockId The ID that was just removed (used only for logical scoping;
 *                       the implementation always performs a full scan to ensure
 *                       correctness under concurrent edits).
 */
export function collectUnusedProjection(
  blocks: Y.Map<BlockRegistryEntry>,
  _deletedBlockId: string,
): void {
  // 1. Build the set of target IDs that still have at least one active consumer,
  //    and for each target collect the union of all consumers' projectedColumns.
  const targetConsumerCols = new Map<string, Set<string>>();

  blocks.forEach((entry) => {
    for (const rel of entry.relations ?? []) {
      if (!targetConsumerCols.has(rel.targetBlockId)) {
        targetConsumerCols.set(rel.targetBlockId, new Set());
      }
      for (const col of rel.projectedColumns) {
        targetConsumerCols.get(rel.targetBlockId)!.add(col);
      }
    }
  });

  // 2. For every block that carries a projection, either drop it (no consumers)
  //    or narrow its columns to the current union. Collect updates first to avoid
  //    mutating the map while iterating.
  const updates: Array<[string, BlockRegistryEntry]> = [];

  blocks.forEach((entry, id) => {
    if (!entry.projection) return;

    const neededCols = targetConsumerCols.get(id);

    if (!neededCols || neededCols.size === 0) {
      // No active consumers — drop the projection entirely.
      const { projection: _, ...rest } = entry;
      updates.push([id, rest as BlockRegistryEntry]);
    } else {
      const newCols = [...neededCols].sort();
      const colsChanged =
        entry.projection.columns.length !== newCols.length ||
        entry.projection.columns.some((c, i) => c !== newCols[i]);

      if (colsChanged) {
        // Narrow existing rows to the new column set.
        const newRows: Record<string, Record<string, string>> = {};
        for (const [rowId, rowData] of Object.entries(entry.projection.rows)) {
          const narrowed: Record<string, string> = {};
          for (const col of newCols) {
            if (col in rowData) narrowed[col] = rowData[col];
          }
          newRows[rowId] = narrowed;
        }
        updates.push([id, { ...entry, projection: { columns: newCols, rows: newRows } }]);
      }
    }
  });

  // 3. Apply all updates outside the forEach to avoid concurrent modification.
  for (const [id, updated] of updates) {
    blocks.set(id, updated);
  }
}
