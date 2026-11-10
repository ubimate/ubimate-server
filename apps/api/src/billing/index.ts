/**
 * Billing on a self-hosted server: there is none (docs/CREEM.md §4.9). The ubimate-server sync
 * copies this file to `billing/index.ts` and leaves the real `billing/` directory out, so the
 * extract carries no payment code. Every account is entitled, nothing is cancelled on deletion or
 * granted, and the routes answer as the hosted server's do when it runs without CREEM_API_KEY — `GET /api/billing`
 * says billing is off, the webhook is 404 — so clients and tests need one contract.
 *
 * Its imports must work from `billing/` too: it is compiled there in the extract.
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import type { BillingModule } from '../billingContract';

const billingRouter = Router();
billingRouter.use(requireAuth);
billingRouter.get('/', (_req: Request, res: Response) => {
  res.json({ enabled: false, plan: null, entitled: true, status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, plansOnSale: [], grant: null });
});

const NOT_ENABLED = { error: 'Billing is not enabled on this server' };

const billingWebhookRouter = Router();
billingWebhookRouter.post('/', (_req: Request, res: Response) => { res.status(404).json(NOT_ENABLED); });

// The admin app asks whether the server bills, and offers no grants when it does not.
const billingAdminRouter = Router();
billingAdminRouter.get('/', (_req: Request, res: Response) => { res.json({ enabled: false }); });
billingAdminRouter.use((_req: Request, res: Response) => { res.status(404).json(NOT_ENABLED); });

const billing: BillingModule = {
  describeBilling() {
    if (Object.keys(process.env).some((k) => k.startsWith('CREEM_'))) {
      console.warn('[billing] CREEM_* variables are set, but this server is built without billing; they are ignored');
    }
    return 'off (self-hosted build)';
  },
  isEntitled: () => true,
  cancelSubscriptionsForDeletion: async () => ({ ok: true }),
  billingRouter,
  billingWebhookRouter,
  billingAdminRouter,
  // Every account has full access: there is nothing to grant.
  checkGrant: () => ({ ok: false, error: 'This server does not bill: every account has full access already' }),
  setInvitationGrant: () => {},
  grantFromInvitation: () => {},
  startBackgroundJobs: () => {},
};

export default billing;
