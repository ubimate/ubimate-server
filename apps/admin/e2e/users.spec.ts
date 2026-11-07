import { expect, test, type Page } from '@playwright/test';

// The admin app talks to whatever API URL is stored; this one is never reached, every request
// to it is answered by the route below.
const API = 'http://api.test';

const USER = {
  id: 'u1',
  email: 'delete-me@example.com',
  properties: {},
  status: 'active',
  created_at: Date.UTC(2026, 9, 1),
  is_demo: false,
  demo_expires_at: null,
  has_freetrial: false,
  user_type: 'paid',
  disk_usage_bytes: 0,
  quota_bytes: null,
  attachments_used_bytes: null,
  sync_used_bytes: null,
};

/** Fakes the admin API with one user, signs in, and records every DELETE it receives. */
async function openUsers(page: Page) {
  const deletes: { path: string; auth: string | undefined }[] = [];
  let users = [USER];
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const { pathname } = new URL(req.url());
    if (req.method() === 'DELETE' && pathname.startsWith('/api/admin/users/')) {
      deletes.push({ path: pathname, auth: req.headers()['authorization'] });
      users = users.filter((u) => `/api/admin/users/${u.id}` !== pathname);
      return route.fulfill({ status: 204 });
    }
    if (req.method() === 'GET' && pathname === '/api/admin/users') return route.fulfill({ json: users });
    if (req.method() === 'GET' && pathname === '/api/admin/invitations') return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { error: `unexpected ${req.method()} ${pathname}` } });
  });
  await page.addInitScript((api) => {
    localStorage.setItem('ubimate_admin_url', api);
    sessionStorage.setItem('ubimate_admin_token', 'test-token');
  }, API);
  await page.goto('/');
  await expect(page.getByRole('cell', { name: USER.email })).toBeVisible();
  return deletes;
}

test.describe('Users: Delete', () => {
  // The confirm dialog once came from the static Modal.confirm, which antd 5 cannot render under
  // React 19: clicking Delete showed nothing and sent nothing.
  test('asks for confirmation, then deletes the user and drops the row', async ({ page }) => {
    const deletes = await openUsers(page);

    await page.getByRole('row', { name: new RegExp(USER.email) }).getByRole('button', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(`Are you sure you want to delete ${USER.email}?`);
    await dialog.getByRole('button', { name: 'Delete' }).click();

    await expect(page.getByText(`User ${USER.email} deleted`)).toBeVisible();
    expect(deletes).toEqual([{ path: `/api/admin/users/${USER.id}`, auth: 'Bearer test-token' }]);
    await expect(page.getByRole('cell', { name: USER.email })).toHaveCount(0);
  });

  test('Cancel sends nothing and keeps the user', async ({ page }) => {
    const deletes = await openUsers(page);

    await page.getByRole('row', { name: new RegExp(USER.email) }).getByRole('button', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    await expect(dialog).toBeHidden();
    expect(deletes).toEqual([]);
    await expect(page.getByRole('cell', { name: USER.email })).toBeVisible();
  });
});
