// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * Deleting an account and everything the server holds for it (docs/ADMIN.md §2.7), for the admin's Delete.
 *
 * Order matters. Bucket objects go first: their only record is the `attachments` ledger, whose rows cascade
 * away with the user, so an object left behind then could never be found again. If one cannot be removed
 * nothing else is touched and the caller can try again. Then the registry rows in one transaction, then the
 * live connections (a subscribed relay socket or a request in flight would recreate the database through
 * getUserDb), then the files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { registryStmts, withRegistryTransaction } from '../db/registry';
import type { AttachmentRow } from '../db/registry';
import { closeUserDb } from '../db/userDb';
import { relay } from '../relay';
import { closeDocumentEventClients } from './documentEvents';
import { getObjectStore } from './objectStore';
import { removeObject } from './attachments';
import { releaseReservation } from './quota';

const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, '../../data');

export type PurgeResult = { ok: true } | { ok: false; error: string };

export async function purgeUser(userId: string): Promise<PurgeResult> {
  const attachments = registryStmts.listAttachmentsOwnedBy.all(userId) as AttachmentRow[];

  // 1. Bucket objects, while the ledger still lists them.
  const inBucket = attachments.filter((a) => a.storage === 's3');
  if (inBucket.length > 0) {
    const store = getObjectStore();
    if (!store?.delete) {
      return { ok: false, error: `${inBucket.length} attachment(s) are in object storage, which is not configured for deletes` };
    }
    for (const row of inBucket) {
      try {
        await store.delete(row.storage_key);
      } catch (err) {
        console.warn(`[purge] could not remove ${row.storage_key}:`, err);
        return { ok: false, error: `Could not remove an attachment from object storage (${row.attachment_id}); nothing was deleted, try again` };
      }
    }
  }
  // Local files can live outside uploads/<userId>/ only if someone else uploaded them; remove them by row.
  for (const row of attachments) if (row.storage === 'local') removeObject(row);
  for (const row of attachments) releaseReservation(row.attachment_id);

  // 2. Registry rows. The user row cascades to usage, attachments and credential reset tokens. A Space the user
  //    created loses its key state and chain once nobody else holds a key for it.
  withRegistryTransaction(() => {
    const owned = (registryStmts.listSpacesOwnedBy.all(userId) as { workspace_id: string }[]).map((r) => r.workspace_id);
    registryStmts.deleteAllWorkspaceKeysForUser.run(userId);
    for (const workspaceId of owned) {
      const { count } = registryStmts.countWorkspaceKeys.get(workspaceId) as { count: number };
      if (count > 0) continue;
      registryStmts.deleteKeyChain.run(workspaceId);
      registryStmts.deleteKeyState.run(workspaceId);
    }
    registryStmts.deleteUser.run(userId);
  });

  // 3. Live connections.
  relay.disconnectUser(userId);
  closeDocumentEventClients(userId);
  closeUserDb(userId);

  // 4. Files: the database (with its WAL and shared-memory files) and the uploads directory.
  const dbPath = path.join(DATA_DIR, 'users', `${userId}.db`);
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.unlinkSync(file); } catch { /* not there */ }
  }
  fs.rmSync(path.join(DATA_DIR, 'uploads', userId), { recursive: true, force: true });

  return { ok: true };
}
