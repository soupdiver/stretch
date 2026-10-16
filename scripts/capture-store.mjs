import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

// Run against build:test; the final release command must restore the production bundle.
await mkdir('.browser-profile', { recursive: true });
await mkdir('store/assets', { recursive: true });
const profile = await mkdtemp(resolve('.browser-profile', 'store-capture-'));
const article = await readFile('store/demo.html');
const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(article); });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
let context;
try {
  const extension = resolve('dist');
  context = await chromium.launchPersistentContext(profile, {
    headless: true, viewport: { width: 1280, height: 800 },
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  await context.route(/https:\/\/(api\.anthropic\.com|api\.openai\.com|openrouter\.ai)\//, async (route) => {
    if (route.request().url() !== 'https://api.anthropic.com/v1/messages') return route.abort();
    const blocks = JSON.parse(route.request().postDataJSON().messages[0].content).blocks;
    const summaries = blocks.map(({ id, text }) => ({ id, text: text.startsWith('Attention')
      ? 'Make the main ideas easy to find, without throwing the source away.'
      : text.startsWith('Good interfaces') ? 'Let readers choose their depth. Shorter should not mean less trustworthy.'
        : 'Preserve conditions and exceptions. Expand the original whenever the stakes are high.' }));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ summaries }) }] }) });
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 10000 });
  const options = await context.newPage();
  await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  await options.locator('#status').filter({ hasText: 'Settings loaded.' }).waitFor();
  await options.screenshot({ path: 'store/assets/01-settings.png' });
  await worker.evaluate(async () => chrome.storage.local.set({ selectedProvider: 'anthropic', providers: { anthropic: { apiKey: 'mock-store-capture-key', model: 'claude-haiku-5-5' } }, websiteTextConsent: true }));
  const page = await context.newPage();
  await page.clock.install();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.screenshot({ path: 'store/assets/02-original.png' });
  await page.bringToFront();
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await globalThis.__stretchtextTestAction(tab);
  });
  await page.locator('#attention button.stretchtext-summary').waitFor();
  await page.locator('[data-stretchtext="status"]').filter({ hasText: 'blocks shortened' }).waitFor();
  await page.clock.fastForward(5001);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: 'store/assets/03-shortened.png' });
  await page.locator('#attention button.stretchtext-summary').click();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: 'store/assets/04-expanded.png' });
  console.log('Captured four 1280×800 screenshots; article output is a labeled deterministic demo, not live inference.');
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
  await new Promise((done) => server.close(done));
}
