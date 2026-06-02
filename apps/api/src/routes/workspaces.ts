/**
 * Workspace key management endpoints.
 *
 * GET  /api/workspaces/:id/key           → return caller's wrapped workspace key
 * PUT  /api/workspaces/:id/key/:userId   → upsert a wrapped key for a target user (owner/admin)
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { registryStmts } from '../db/registry';
import type { WorkspaceKeyRow } from '../db/registry';

export const workspacesRouter = Router();

workspacesRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// GET /api/workspaces/:id/key
// ---------------------------------------------------------------------------
workspacesRouter.get('/:id/key', (req: Request, res: Response) => {
  const row = registryStmts.getWorkspaceKeyForUser.get(req.params.id, req.userId) as WorkspaceKeyRow | undefined;
  if (!row) {
    res.status(403).json({ error: 'No key for this workspace' });
    return;
  }
  res.json({ workspace_id: row.workspace_id, wrapped_key: row.wrapped_key });
});

// ---------------------------------------------------------------------------
// PUT /api/workspaces/:id/key/:userId
// Body: { wrapped_key: string }
//
// Upserts a workspace key row for the given target userId.
// The caller must already hold a key for this workspace (i.e. be a member/owner).
// ---------------------------------------------------------------------------
workspacesRouter.put('/:id/key/:userId', (req: Request, res: Response) => {
  // Verify the caller has access to this workspace.
  const callerKey = registryStmts.getWorkspaceKeyForUser.get(req.params.id, req.userId) as WorkspaceKeyRow | undefined;
  if (!callerKey) {
    res.status(403).json({ error: 'Not authorised to manage keys for this workspace' });
    return;
  }

  const { wrapped_key } = req.body as { wrapped_key?: string };
  if (!wrapped_key || typeof wrapped_key !== 'string') {
    res.status(400).json({ error: 'wrapped_key is required' });
    return;
  }

  registryStmts.upsertWorkspaceKey.run({
    workspace_id: req.params.id,
    user_id: req.params.userId,
    wrapped_key,
    granted_at: Date.now(),
  });

  res.status(204).send();
});
