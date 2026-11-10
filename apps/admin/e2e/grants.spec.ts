import { expect, test, type Page } from '@playwright/test';

// Complimentary access (docs/CREEM.md §4.10) in the admin app, against a faked admin API: an
// invitation sent with a grant, an account granted and its grant ended, and nothing of it on a
// server that does not bill.
const API = 'http://api.test';

const USER = {
  id: 'u1',
  email: 'friend@example.com',
  properties: {},
  status: 'active',
  created_at: Date.UTC(2026, 9, 1),
  user_type: 'regular',
  disk_usage_bytes: 0,
  quota_bytes: null,
  attachments_used_bytes: null,
  sync_used_bytes: null,
};

interface Sent { method: string; path: string; body: unknown }

/** Fakes the admin API, billing on or off, signs in, and records every write it receives. */
async function open(page: Page, { billing }: { billing: boolean }) {
  const sent: Sent[] = [];
  let grant: { plan: string; endsAt: number | null; active: boolean } | null = null;
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const { pathname } = new URL(req.url());
    const method = req.method();
    if (method !== 'GET') sent.push({ method, path: pathname, body: req.postData() ? JSON.parse(req.postData()!) : null });
    if (method === 'GET' && pathname === '/api/admin/users') return route.fulfill({ json: [USER] });
    if (method === 'GET' && pathname === '/api/admin/invitations') return route.fulfill({ json: [] });
    if (pathname.startsWith('/api/admin/billing') && !billing) {
      return pathname === '/api/admin/billing'
        ? route.fulfill({ json: { enabled: false } })
        : route.fulfill({ status: 404, json: { error: 'Billing is not enabled on this server' } });
    }
    if (method === 'GET' && pathname === '/api/admin/billing') return route.fulfill({ json: { enabled: true } });
    if (method === 'GET' && pathname === '/api/admin/billing/accounts') {
      return route.fulfill({ json: grant ? [{ userId: USER.id, plan: grant.active ? grant.plan : null, status: null, grant }] : [] });
    }
    if (method === 'GET' && pathname === '/api/admin/billing/invitation-grants') return route.fulfill({ json: [] });
    if (method === 'PUT' && pathname === `/api/admin/billing/grants/${USER.id}`) {
      grant = { ...(JSON.parse(req.postData()!) as { plan: string; endsAt: number | null }), active: true };
      return route.fulfill({ json: { grant } });
    }
    if (method === 'DELETE' && pathname === `/api/admin/billing/grants/${USER.id}`) {
      grant = null;
      return route.fulfill({ status: 204 });
    }
    if (method === 'POST' && pathname === '/api/admin/invitations') {
      const body = JSON.parse(req.postData()!) as { email: string; token: string };
      return route.fulfill({ status: 201, json: { id: 'inv1', email: body.email, token: body.token, status: 'pending', created_at: Date.now(), accepted_at: null } });
    }
    return route.fulfill({ status: 404, json: { error: `unexpected ${method} ${pathname}` } });
  });
  await page.addInitScript((api) => {
    localStorage.setItem('ubimate_admin_url', api);
    sessionStorage.setItem('ubimate_admin_token', 'test-token');
  }, API);
  await page.goto('/');
  await expect(page.getByRole('cell', { name: USER.email })).toBeVisible();
  return sent;
}

test('sends an invitation with complimentary Pro until a day', async ({ page }) => {
  const sent = await open(page, { billing: true });
  await page.getByRole('button', { name: 'Send invitation' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send invitation' });
  await dialog.getByLabel('Email address').fill('new@example.com');
  // antd's Select covers its input with the chosen value: click the box.
  await dialog.locator('.ant-select', { has: page.getByLabel('Complimentary access') }).click();
  // Its options are drawn as items; the role=option elements are an empty list for screen readers.
  await page.locator('.ant-select-item-option', { hasText: 'Pro' }).click();
  await dialog.getByLabel('Until').fill('2030-01-31');
  await dialog.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('Invitation sent to new@example.com')).toBeVisible();
  const post = sent.find((s) => s.path === '/api/admin/invitations')!;
  // The end of that day, in the admin's time zone.
  expect(post.body).toMatchObject({ email: 'new@example.com', grant: { plan: 'pro', endsAt: new Date(2030, 0, 31, 23, 59, 59, 999).getTime() } });
});

test('an invitation left at None sends no grant', async ({ page }) => {
  const sent = await open(page, { billing: true });
  await page.getByRole('button', { name: 'Send invitation' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send invitation' });
  await dialog.getByLabel('Email address').fill('payer@example.com');
  await expect(dialog.getByLabel('Until')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Invitation sent to payer@example.com')).toBeVisible();
  expect(sent.find((s) => s.path === '/api/admin/invitations')!.body).not.toHaveProperty('grant');
});

test('grants an account Personal with no end, then ends the grant', async ({ page }) => {
  const sent = await open(page, { billing: true });
  const row = page.getByRole('row', { name: new RegExp(USER.email) });
  await expect(row.getByText('none')).toBeVisible();

  await row.getByRole('button', { name: 'Grant…' }).click();
  const dialog = page.getByRole('dialog', { name: `Complimentary access: ${USER.email}` });
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(`${USER.email} has Personal, no end`)).toBeVisible();
  expect(sent.at(-1)).toEqual({ method: 'PUT', path: `/api/admin/billing/grants/${USER.id}`, body: { plan: 'personal', endsAt: null } });
  await expect(row.getByText('complimentary')).toBeVisible();
  await expect(row.getByText('Personal')).toBeVisible();

  await row.getByRole('button', { name: 'Grant…' }).click();
  await dialog.getByRole('button', { name: 'End grant' }).click();
  // antd's confirm dialog has no accessible name: found by what it asks.
  const confirm = page.getByRole('dialog').filter({ hasText: `End ${USER.email}'s complimentary access now?` });
  await confirm.getByRole('button', { name: 'End it' }).click();
  await expect(page.getByText(`${USER.email}'s complimentary access ended`)).toBeVisible();
  expect(sent.at(-1)).toEqual({ method: 'DELETE', path: `/api/admin/billing/grants/${USER.id}`, body: null });
  await expect(row.getByText('none')).toBeVisible();
});

test('shows no plans or grants where the server does not bill', async ({ page }) => {
  await open(page, { billing: false });
  await expect(page.getByRole('columnheader', { name: 'Plan' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Grant…' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('dialog', { name: 'Send invitation' }).getByLabel('Complimentary access')).toHaveCount(0);
});
