/**
 * GET /api/usage — what the caller has stored and what they may store (docs/DISK-QUOTAS.md §7).
 * A limit of null is no limit. Sync usage is measured but not capped in the first release.
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { registryStmts } from '../db/registry';
import type { UserRow } from '../db/registry';
import { attachmentsUsed, getQuotaBytes } from '../lib/quota';

export const usageRouter = Router();

usageRouter.use(requireAuth);

usageRouter.get('/', (req: Request, res: Response) => {
  const user = registryStmts.getUserById.get(req.userId) as UserRow | undefined;
  const sync = registryStmts.getUsageRow.get(req.userId, 'sync') as { used_bytes: number } | undefined;
  res.json({
    attachments: { used: attachmentsUsed(req.userId), limit: user ? getQuotaBytes(user) : null },
    sync: { used: sync?.used_bytes ?? 0, limit: null },
  });
});
