import { expect, test } from '@playwright/test';

// Signing in with an API URL typed into the form, as a first visit does: nothing stored, the app
// served from somewhere other than the API (vite here, so the fallback URL is this origin).
const API = 'http://api.test';

test('the first sign-in goes to the API URL just typed', async ({ page }) => {
  const logins: string[] = [];
  // Anything sent to the app's own origin (the old fallback URL) is a sign-in to the wrong server.
  await page.route('**/api/admin/login', async (route) => {
    logins.push(new URL(route.request().url()).origin);
    if (!route.request().url().startsWith(API)) return route.fulfill({ status: 404, json: {} });
    return route.fulfill({ json: { token: 'test-token' } });
  });
  await page.route(`${API}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/admin/login') return route.fallback();
    if (pathname === '/api/admin/users' || pathname === '/api/admin/invitations') return route.fulfill({ json: [] });
    if (pathname === '/api/admin/billing') return route.fulfill({ json: { enabled: false } });
    return route.fulfill({ status: 404, json: {} });
  });

  await page.goto('/');
  await page.getByLabel('API URL').fill(`${API}/`);
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('button', { name: 'Send invitation' })).toBeVisible();
  expect(logins).toEqual([API]);
});
