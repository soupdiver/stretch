import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

// Run against build:test; the final release command must restore the production bundle.
await mkdir('.browser-profile', { recursive: true });
await mkdir('store/assets', { recursive: true });
const profile = await mkdtemp(resolve('.browser-profile', 'store-capture-'));
const article = await readFile('store/demo.html');
const comparisonArticle = await readFile('store/comparison-demo.html');
const server = createServer((request, response) => { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(request.url === '/comparison' ? comparisonArticle : article); });
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

  await page.setViewportSize({ width: 592, height: 620 });
  await page.goto(`http://127.0.0.1:${server.address().port}/comparison`);
  const normal = await page.screenshot();
  await page.bringToFront();
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await globalThis.__stretchtextTestAction(tab);
  });
  await page.locator('button.stretchtext-summary').first().waitFor();
  await page.locator('[data-stretchtext="status"]').waitFor({ state: 'detached', timeout: 10000 });
  await page.mouse.move(0, 0);
  const shortened = await page.screenshot();
  await compose(context, 'ORIGINAL → SHORTENED', 'ORIGINAL', 'SHORTENED', normal, shortened, 'store/assets/screenshot-reading.png', 'Same demo page. Actual extension rendering; simulated AI responses.');

  await options.setViewportSize({ width: 592, height: 620 });
  await options.reload();
  await options.locator('#status').filter({ hasText: 'Settings loaded.' }).waitFor();
  await options.locator('#provider').selectOption('openrouter');
  await options.getByRole('button', { name: 'Save settings' }).click();
  await options.locator('#status').filter({ hasText: 'Settings saved.' }).waitFor();
  await options.locator('#providerHeading').evaluate(element => element.closest('section').scrollIntoView());
  await options.mouse.move(0, 0);
  const providerBottom = await options.locator('#modelHeading').evaluate(element => element.closest('section').getBoundingClientRect().top);
  const providerSettings = await options.screenshot({ clip: { x: 0, y: 0, width: 592, height: Math.min(620, Math.floor(providerBottom)) } });
  await options.locator('#modelHeading').evaluate(element => element.closest('section').scrollIntoView());
  const credentialsBottom = await options.locator('#clearKey').evaluate(element => element.getBoundingClientRect().top);
  const modelSettings = await options.screenshot({ clip: { x: 0, y: 0, width: 592, height: Math.min(620, Math.floor(credentialsBottom)) } });
  await compose(context, 'SETTINGS', 'PROVIDER + PRIVACY', 'MODEL + API KEY', providerSettings, modelSettings, 'store/assets/screenshot-settings.png', 'Two scroll positions from the actual settings page. No credentials shown.');
  console.log('Captured listing screenshots: screenshot-reading.png and screenshot-settings.png (1280×800).');
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
  await new Promise((done) => server.close(done));
}

async function compose(context, title, leftLabel, rightLabel, leftImage, rightImage, path, note) {
  const frame = await context.newPage();
  try {
    await frame.setViewportSize({ width: 1280, height: 800 });
    const logo = (await readFile('assets/logo.svg')).toString('base64');
    await frame.setContent(`<!doctype html><html><head><style>
      *{box-sizing:border-box}body{margin:0;padding:24px 32px;background:#080b11;color:#e4eaf2;font:14px/1.5 ui-monospace,monospace}
      header{height:66px;display:flex;align-items:center;gap:14px}header img{width:42px;height:42px}strong{font-size:23px;letter-spacing:-.04em}header span{margin-left:auto;color:#64fff1;font-size:16px}
      main{display:grid;grid-template-columns:592px 592px;gap:24px}figure{margin:0}figcaption{height:26px;color:#8a95a9;font-size:12px;letter-spacing:.12em}figure img{display:block;width:592px;height:620px;object-fit:none;object-position:top;background:#f6f4ef;border:1px solid #263149}footer{margin-top:16px;color:#8a95a9;font-size:12px}
    </style></head><body><header><img src="data:image/svg+xml;base64,${logo}" alt=""><strong>STRETCH_</strong><span>${title}</span></header><main><figure><figcaption>${leftLabel}</figcaption><img src="data:image/png;base64,${leftImage.toString('base64')}" alt=""></figure><figure><figcaption>${rightLabel}</figcaption><img src="data:image/png;base64,${rightImage.toString('base64')}" alt=""></figure></main><footer>${note}</footer></body></html>`);
    await frame.screenshot({ path });
  } finally { await frame.close(); }
}
