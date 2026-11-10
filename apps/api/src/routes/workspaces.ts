/**
 * Workspace key management endpoints (docs/ATTACHMENT-ENCRYPTION.md 5-7).
 *
 * GET    /api/workspaces/:id/key           → the caller's wrapped key, with its version
 * PUT    /api/workspaces/:id/key/:userId   → write a wrapped key for a member (the Space's owner only)
 * GET    /api/workspaces/:id/keychain      → the chain that walks older keys down from the current one
 * GET    /api/workspaces/:id/members       → who holds a key for the Space, with their public keys (to seal a new key for)
 * POST   /api/workspaces/:id/rotate        → the owner moves the Space to a new key version, removing members
 * DELETE /api/workspaces/:id/members/me    → a non-owner member leaves; the owner's client then rotates
 *
 * Bootstrap rule: if no workspace_keys rows exist at all for a workspace, any
 * authenticated user may create the first key entry for themselves (self-only).
 * This lets Tauri clients that created a workspace locally upload their sealed
 * content key the first time they connect to the cloud, without needing a
 * pre-existing row to satisfy the normal ownership check. That user becomes the owner.
 *
 * The server never sees a key: it checks who may write, that a rotation names exactly the remaining
 * members, and that versions only move forward by one.
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireEntitlement } from '../middleware/entitlement';
import { registryStmts, withRegistryTransaction } from '../db/registry';
import type { WorkspaceKeyChainRow, WorkspaceKeyRow, WorkspaceKeyStateRow } from '../db/registry';
import { WRAPPED_KEY_CHARS } from '../lib/attachments';
import { broadcastKeyRotated, broadcastRotationPending } from '../lib/documentEvents';

export const workspacesRouter = Router();

workspacesRouter.use(requireAuth);
workspacesRouter.use(requireEntitlement);

/** A sealed Space key is a few hundred base64 characters at most; this only stops absurd bodies. */
const MAX_SEALED_KEY_CHARS = 1024;

const isSealedKey = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_SEALED_KEY_CHARS;

// ---------------------------------------------------------------------------
// GET /api/workspaces/:id/key
// ---------------------------------------------------------------------------
workspacesRouter.get('/:id/key', (req: Request, res: Response) => {
  const row = registryStmts.getWorkspaceKeyForUser.get(req.params.id, req.userId) as WorkspaceKeyRow | undefined;
  if (!row) {
    res.status(403).json({ error: 'No key for this space' });
    return;
  }
  const state = registryStmts.getKeyState.get(req.params.id) as WorkspaceKeyStateRow | undefined;
  res.json({
    workspace_id: row.workspace_id,
    wrapped_key: row.wrapped_key,
    key_version: row.key_version,
    current_version: state?.current_version ?? 1,
    rotation_pending: state?.rotation_pending === 1,
  });
});

// ---------------------------------------------------------------------------
// PUT /api/workspaces/:id/key/:userId
// Body: { wrapped_key: string }
//
// Upserts a workspace key row for the given target userId, at the Space's current version.
// Only the Space's owner may write keys for others (or for themselves); the bootstrap case above is the exception.
// ---------------------------------------------------------------------------
workspacesRouter.put('/:id/key/:userId', (req: Request, res: Response) => {
  const callerKey = registryStmts.getWorkspaceKeyForUser.get(req.params.id, req.userId) as WorkspaceKeyRow | undefined;
  if (!callerKey) {
    // Bootstrap exception: allow self-only key creation when no key rows exist
    // for this workspace (first-time upload from a locally-created workspace).
    const isSelf = req.params.userId === req.userId;
    const { count } = registryStmts.countWorkspaceKeys.get(req.params.id) as { count: number };
    if (!isSelf || count > 0) {
      res.status(403).json({ error: 'Not authorised to manage keys for this space' });
      return;
    }
  } else if (!isOwner(req.params.id, req.userId)) {
    res.status(403).json({ error: 'Only the owner of a space may write its keys' });
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
  // The bootstrap case above is the Space's first key: whoever puts it there owns the Space.
  if (!callerKey) registryStmts.recordSpaceOwner.run({ workspace_id: req.params.id, owner_user_id: req.userId });

  res.status(204).send();
});

function isOwner(workspaceId: string, userId: string): boolean {
  const owner = registryStmts.getSpaceOwner.get(workspaceId) as { owner_user_id: string } | undefined;
  return owner?.owner_user_id === userId;
}

// ---------------------------------------------------------------------------
// GET /api/workspaces/:id/keychain
// A member reads the chain to open content written under an older version of the key.
// ---------------------------------------------------------------------------
workspacesRouter.get('/:id/keychain', (req: Request, res: Response) => {
  const row = registryStmts.getWorkspaceKeyForUser.get(req.params.id, req.userId) as WorkspaceKeyRow | undefined;
  if (!row) {
    res.status(403).json({ error: 'No key for this space' });
    return;
  }
  const state = registryStmts.getKeyState.get(req.params.id) as WorkspaceKeyStateRow | undefined;
  const chain = (registryStmts.listKeyChain.all(req.params.id) as WorkspaceKeyChainRow[]).map((e) => ({
    key_version: e.key_version,
    wrapped_previous: e.wrapped_previous,
  }));
  res.json({ workspace_id: req.params.id, current_version: state?.current_version ?? 1, chain });
});

// ---------------------------------------------------------------------------
// GET /api/workspaces/:id/members
// Whoever holds a key for the Space, with the public key to seal the next version for. Any member may
// ask: the owner needs it to rotate, and the list is what a member's own key is shared with.
// ---------------------------------------------------------------------------
workspacesRouter.get('/:id/members', (req: Request, res: Response) => {
  const row = registryStmts.getWorkspaceKeyForUser.get(req.params.id, req.userId) as WorkspaceKeyRow | undefined;
  if (!row) {
    res.status(403).json({ error: 'No key for this space' });
    return;
  }
  const owner = (registryStmts.getSpaceOwner.get(req.params.id) as { owner_user_id: string } | undefined)?.owner_user_id ?? null;
  const members = (registryStmts.listWorkspaceMembers.all(req.params.id) as { user_id: string }[]).map(({ user_id }) => {
    const user = registryStmts.getUserById.get(user_id) as { public_key: string | null } | undefined;
    return { user_id, public_key: user?.public_key ?? null, is_owner: user_id === owner };
  });
  res.json({ workspace_id: req.params.id, members });
});

// ---------------------------------------------------------------------------
// POST /api/workspaces/:id/rotate
// Body: { fromVersion, remove: string[], wrappedPrevious, keys: [{ userId, wrappedKey }] }
// ---------------------------------------------------------------------------
workspacesRouter.post('/:id/rotate', (req: Request, res: Response) => {
  const workspaceId = req.params.id;
  const state = registryStmts.getKeyState.get(workspaceId) as WorkspaceKeyStateRow | undefined;
  if (!state || state.owner_user_id !== req.userId) {
    res.status(403).json({ error: 'Only the owner of a space may rotate its key' });
    return;
  }

  const { fromVersion, remove, wrappedPrevious, keys } = req.body as {
    fromVersion?: unknown;
    remove?: unknown;
    wrappedPrevious?: unknown;
    keys?: unknown;
  };
  if (!Number.isInteger(fromVersion) || (fromVersion as number) < 1) {
    res.status(400).json({ error: 'fromVersion must be a positive integer' });
    return;
  }
  if (!Array.isArray(remove) || !remove.every((u) => typeof u === 'string')) {
    res.status(400).json({ error: 'remove must be a list of user ids' });
    return;
  }
  if (typeof wrappedPrevious !== 'string' || wrappedPrevious.length !== WRAPPED_KEY_CHARS) {
    res.status(400).json({ error: `wrappedPrevious must be ${WRAPPED_KEY_CHARS} characters` });
    return;
  }
  if (!Array.isArray(keys) || !keys.every((k) => k && typeof k.userId === 'string' && isSealedKey(k.wrappedKey))) {
    res.status(400).json({ error: 'keys must be a list of { userId, wrappedKey }' });
    return;
  }
  const entries = keys as { userId: string; wrappedKey: string }[];

  type Outcome = { status: number; body: object } | { version: number; members: string[] };
  const outcome = withRegistryTransaction((): Outcome => {
    // Read again inside the transaction: two rotations from the same version must not both succeed.
    const current = registryStmts.getKeyState.get(workspaceId) as WorkspaceKeyStateRow;
    if (current.current_version !== fromVersion) {
      return { status: 409, body: { error: 'key_rotated', currentVersion: current.current_version } };
    }
    const members = (registryStmts.listWorkspaceMembers.all(workspaceId) as { user_id: string }[]).map((m) => m.user_id);
    const removed = new Set(remove as string[]);
    if (removed.has(req.userId!)) return { status: 400, body: { error: 'The owner cannot be removed' } };
    for (const id of removed) {
      if (!members.includes(id)) return { status: 400, body: { error: `${id} is not a member` } };
    }
    // `keys` names exactly the members who remain: the server cannot check a sealed key's contents,
    // but it can stop a rotation from silently leaving someone out or adding someone.
    const remaining = members.filter((m) => !removed.has(m)).sort();
    const named = entries.map((k) => k.userId).sort();
    if (remaining.length !== named.length || remaining.some((m, i) => m !== named[i])) {
      return { status: 400, body: { error: 'keys must name exactly the remaining members' } };
    }

    const version = current.current_version + 1;
    const now = Date.now();
    for (const id of removed) registryStmts.deleteWorkspaceKeyForUser.run(workspaceId, id);
    for (const k of entries) {
      registryStmts.rewriteWorkspaceKey.run({
        workspace_id: workspaceId,
        user_id: k.userId,
        wrapped_key: k.wrappedKey,
        granted_at: now,
        key_version: version,
      });
    }
    registryStmts.insertKeyChainEntry.run({
      workspace_id: workspaceId,
      key_version: version,
      wrapped_previous: wrappedPrevious,
      created_at: now,
    });
    registryStmts.setKeyVersion.run({ workspace_id: workspaceId, version });
    return { version, members: remaining };
  });

  if ('status' in outcome) {
    res.status(outcome.status).json(outcome.body);
    return;
  }
  for (const member of outcome.members) broadcastKeyRotated(member, workspaceId, outcome.version);
  res.json({ current_version: outcome.version });
});

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/:id/members/me
// A member who leaves cannot rotate: they would know the new key. Their row goes and the owner's
// client is told (rotation_pending in /api/auth/me) to rotate before it writes anything else.
// ---------------------------------------------------------------------------
workspacesRouter.delete('/:id/members/me', (req: Request, res: Response) => {
  const row = registryStmts.getWorkspaceKeyForUser.get(req.params.id, req.userId) as WorkspaceKeyRow | undefined;
  if (!row) {
    res.status(403).json({ error: 'Not a member of this space' });
    return;
  }
  if (isOwner(req.params.id, req.userId!)) {
    res.status(400).json({ error: 'The owner cannot leave a space' });
    return;
  }
  withRegistryTransaction(() => {
    registryStmts.deleteWorkspaceKeyForUser.run(req.params.id, req.userId);
    registryStmts.setRotationPending.run(req.params.id);
  });
  const owner = registryStmts.getSpaceOwner.get(req.params.id) as { owner_user_id: string } | undefined;
  if (owner) broadcastRotationPending(owner.owner_user_id, req.params.id);
  res.status(204).send();
});
