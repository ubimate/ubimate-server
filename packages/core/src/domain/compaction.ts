import { COMPACT_THRESHOLD } from '../storage/schema';

/**
 * Yjs update-log compaction policy. Once a document has accumulated at least
 * {@link COMPACT_THRESHOLD} update rows, the sync layer squashes them into a
 * single snapshot blob. Kept here so the cloud relay and the local backend
 * apply an identical threshold.
 */
export function shouldCompact(updateCount: number): boolean {
  return updateCount >= COMPACT_THRESHOLD;
}
