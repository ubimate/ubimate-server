import { Request, Response, NextFunction } from 'express';
import billing from '../billing';

/** The body of every refusal for want of a subscription (docs/CREEM.md §4.8). Clients branch on `code`. */
export const SUBSCRIPTION_REQUIRED = {
  error: 'An active subscription is required',
  code: 'subscription_required',
} as const;

/** Whether `userId` may use the service now. Always true when this server does not bill. */
export function isEntitled(userId: string): boolean {
  return billing.isEntitled(userId);
}

/**
 * Refuses the request with 402 unless the caller's subscriptions entitle them (docs/CREEM.md §3,
 * §4.3). Goes after requireAuth, on every router that is the service rather than the account:
 * documents, attachments, workspaces, link previews.
 */
export function requireEntitlement(req: Request, res: Response, next: NextFunction): void {
  if (isEntitled(req.userId)) { next(); return; }
  res.status(402).json(SUBSCRIPTION_REQUIRED);
}
