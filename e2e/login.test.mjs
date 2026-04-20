/**
 * End-to-end: drive the real browser through Keycloak SSO and send a chat
 * message, verifying streaming + persistence. Uses the nix-installed
 * chromium so Playwright's bundled one isn't needed (apt-get unavailable
 * on NixOS).
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Use `localhost` throughout — middleware+Next.js normalise to localhost for
// the redirect, so cookies get set on `localhost` host. If we start on
// 127.0.0.1 then get bounced to localhost, PKCE cookies won't make it back.
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const USERNAME = process.env.E2E_USERNAME ?? 'alice';
const PASSWORD = process.env.E2E_PASSWORD ?? 'alice';
const CHROMIUM = process.env.CHROMIUM_PATH ?? '/home/robert/.nix-profile/bin/chromium';

const browser = await chromium.launch({
  headless: true,
  executablePath: CHROMIUM,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext();
const page = await ctx.newPage();

// Log everything for debug
page.on('console', (msg) => console.log(`[console:${msg.type()}] ${msg.text()}`));
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

try {
  console.log('→ GET', BASE);
  await page.goto(BASE, { waitUntil: 'networkidle' });

  // Should be on /api/auth/signin after middleware redirect
  await page.waitForURL(/\/api\/auth\/signin/, { timeout: 10000 });
  console.log('✓ redirected to built-in signin');

  // Built-in Auth.js signin page has a "Sign in with <Provider>" button.
  await page.getByRole('button', { name: /keycloak/i }).click();

  // Keycloak login form
  await page.waitForURL(/\/realms\/ted\/protocol\/openid-connect\//, { timeout: 15000 });
  console.log('✓ on Keycloak login page');

  await page.locator('#username').fill(USERNAME);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('#kc-login').click();

  // Back to app, land on /chat/<uuid>
  await page.waitForURL(/\/chat\//, { timeout: 20000 });
  console.log('✓ logged in, landed at', page.url());

  // Listen for responses from /api/chat so we can see the server error
  page.on('response', async (resp) => {
    const u = resp.url();
    if (u.includes('/api/chat') || u.includes('/sessions/')) {
      let body = '';
      try {
        const r = await resp.text();
        body = r.slice(0, 300);
      } catch {}
      console.log(`[resp] ${resp.status()} ${u}${body ? ' body=' + body : ''}`);
    }
  });

  // Send a message
  const input = page.getByPlaceholder('Message Ted');
  await input.fill("Say 'ok' and nothing else.");
  await page.getByRole('button', { name: 'Send' }).click();

  // Wait for an assistant bubble containing text
  const assistantBubble = page
    .locator('div.self-start.bg-zinc-800')
    .last();
  await assistantBubble.waitFor({ state: 'visible', timeout: 60000 });
  // Wait for content to finish streaming (simple heuristic: content stabilises)
  let last = '';
  for (let i = 0; i < 30; i++) {
    const now = (await assistantBubble.textContent()) ?? '';
    if (now && now === last) break;
    last = now;
    await page.waitForTimeout(500);
  }
  console.log(`✓ assistant reply: ${JSON.stringify(last)}`);
  assert.ok(last.length > 0, 'expected non-empty assistant reply');
  assert.ok(/ok/i.test(last), 'expected "ok" in reply');

  // Sidebar polls /api/sessions every 5s; poll up to 10s for the new entry.
  let sidebarLinks = [];
  for (let i = 0; i < 15; i++) {
    sidebarLinks = await page.locator('aside a').allTextContents();
    if (sidebarLinks.some((t) => t !== '+ New chat')) break;
    await page.waitForTimeout(1000);
  }
  console.log('✓ sidebar links:', sidebarLinks);
  assert.ok(sidebarLinks.some((t) => t !== '+ New chat'), 'expected a session in sidebar');

  // Wait for Haiku-generated title (not equal to UUID prefix and not "Untitled chat").
  // The header shows "Untitled chat" until the title lands.
  const header = page.getByRole('button', { name: /.+/, exact: false }).filter({
    has: page.locator('span'),
  }).first();
  let titleText = '';
  for (let i = 0; i < 30; i++) {
    // Prefer the actual header text inside the chat area.
    const h = await page.locator('header button span').first().textContent();
    titleText = (h ?? '').trim();
    if (titleText && !/^untitled chat$/i.test(titleText)) break;
    await page.waitForTimeout(1000);
  }
  console.log('✓ auto-generated title:', JSON.stringify(titleText));
  assert.ok(titleText.length > 0, 'expected a non-empty title');
  assert.ok(!/^untitled/i.test(titleText), 'expected non-default title');

  // Rename via UI: click header, type new title, Enter.
  await page.locator('header button').first().click();
  const titleInput = page.locator('header input');
  await titleInput.fill('Renamed by test');
  await titleInput.press('Enter');
  // Wait for the header to re-render with new title.
  await page.waitForFunction(
    () => {
      const span = document.querySelector('header button span');
      return span?.textContent?.trim() === 'Renamed by test';
    },
    { timeout: 10000 },
  );
  console.log('✓ rename committed via header');

  // Reload; the PATCH should have persisted.
  await page.reload();
  await page.waitForFunction(
    () => {
      const span = document.querySelector('header button span');
      return span?.textContent?.trim() === 'Renamed by test';
    },
    { timeout: 10000 },
  );
  console.log('✓ rename persisted after reload');

  // Reload and confirm history persists
  const url = page.url();
  await page.goto(url);
  const bubbles = await page.locator('div.rounded-xl').allTextContents();
  console.log('✓ after reload, bubbles:', bubbles);
  assert.ok(bubbles.length >= 2, 'expected at least user + assistant bubbles after reload');

  // --- Archive flow ---
  // Seed a second chat to archive so we still have an active session left.
  const prevUrl = page.url();
  await page.getByRole('link', { name: /new chat/i }).click();
  await page.waitForURL((u) => u.toString() !== prevUrl && /\/chat\//.test(u.toString()));
  await page.getByPlaceholder('Message Ted').waitFor();
  await page.getByPlaceholder('Message Ted').fill("Say 'one' only.");
  await page.getByRole('button', { name: 'Send' }).click();
  await page.locator('div.self-start.bg-zinc-800').last().waitFor();

  // Sidebar polls /api/sessions every 5s — wait until both sessions appear.
  await page.waitForFunction(
    () =>
      document.querySelectorAll('aside li').length >= 2,
    { timeout: 15000 },
  );

  // Find a row that isn't the currently-active one, hover to reveal menu.
  const activePath = new URL(page.url()).pathname;
  const rowToArchive = page.locator('aside li').filter({
    hasNot: page.locator(`a[href="${activePath}"]`),
  }).first();
  await rowToArchive.hover();
  await rowToArchive.getByRole('button', { name: /chat options/i }).click();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  // Poll until only one non-archived session remains.
  await page.waitForFunction(
    () =>
      document.querySelectorAll('aside li').length === 1,
    { timeout: 15000 },
  );
  const afterArchive = await page.locator('aside li a').allTextContents();
  console.log('✓ sidebar after archive:', afterArchive);

  // --- Delete flow ---
  page.on('dialog', (d) => d.accept());
  const remaining = page.locator('aside li').first();
  await remaining.hover();
  await remaining.getByRole('button', { name: /chat options/i }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('aside li').length === 0,
    { timeout: 15000 },
  );
  console.log('✓ sidebar after delete: empty');

  console.log('\n✅ E2E PASS');
} catch (err) {
  console.error('\n❌ E2E FAIL:', err.message);
  await page.screenshot({ path: '/tmp/ted-e2e-fail.png', fullPage: true }).catch(() => {});
  console.error('  screenshot: /tmp/ted-e2e-fail.png');
  console.error('  current url:', page.url());
  console.error('  page html head:', (await page.content()).slice(0, 1000));
  process.exitCode = 1;
} finally {
  await browser.close();
}
