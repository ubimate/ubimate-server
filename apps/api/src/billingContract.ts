/**
 * What the rest of the server may use from billing (docs/CREEM.md §4.9). Two modules implement it:
 * `billing/index.ts` (Creem, the hosted service) and `billing-selfhost/index.ts`, which the
 * ubimate-server sync puts in its place: the self-host extract has no billing code at all.
 * Nothing outside `billing/` may import from inside it except through `billing/index.ts`.
 */
import type { Router } from 'express';

/** Complimentary access an admin gives (docs/CREEM.md §4.10): a plan, free, until `endsAt` (null: no end). */
export interface BillingGrant {
  plan: 'personal' | 'pro';
  endsAt: number | null;
}

export interface BillingModule {
  /** One line for the startup log. Throws when billing is half-configured. */
  describeBilling(): string;
  /** Whether `userId` may use the service (sync, workspaces, uploads, link previews). */
  isEntitled(userId: string): boolean;
  /** Ends what an account being deleted would otherwise keep paying for; on an error, delete nothing. */
  cancelSubscriptionsForDeletion(userId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Mounted at /api/billing. `GET /` answers on every server, so clients can tell billing is off. */
  billingRouter: Router;
  /** Mounted at /api/billing/webhook before the JSON parser. Answers 404 where nothing bills. */
  billingWebhookRouter: Router;
  /**
   * Mounted at /api/admin/billing, behind the admin's sign-in: grants and each account's plan.
   * `GET /` says whether this server bills; everything else answers 404 where nothing bills.
   */
  billingAdminRouter: Router;
  /** An invitation request's `grant` as a grant, or why it cannot be given (one where nothing bills). */
  checkGrant(body: unknown): { ok: true; grant: BillingGrant } | { ok: false; error: string };
  /** Makes a checked grant wait on a new invitation. */
  setInvitationGrant(invitationId: string, grant: BillingGrant): void;
  /** Called once an account registered with an invitation exists: the grant waiting on it becomes the account's. */
  grantFromInvitation(invitationId: string, userId: string): void;
  /** Called once the server listens: what billing runs on a schedule (the reconcile, docs/CREEM.md §5.4). */
  startBackgroundJobs(): void;
}
