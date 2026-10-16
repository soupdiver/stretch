import { test, expect, chromium } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

test('bundled extension injects into a real page and reports missing setup without changing it', async () => {
  await mkdir('.browser-profile', { recursive: true });
  const profile = await mkdtemp(resolve('.browser-profile', 'run-'));
  const extension = resolve('dist');
  let context;
  let providerRequests = 0;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    await context.route('https://api.anthropic.com/v1/messages', async (route) => { providerRequests++; await route.abort(); });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:4173');
    await page.evaluate(() => {
      const orphan = document.createElement('div');
      orphan.dataset.stretchtext = 'status';
      orphan.textContent = 'Anthropic request failed (400).';
      document.documentElement.append(orphan);
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const options = await context.newPage(); await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
    await options.locator('#apiKey').fill('mock-key-without-consent'); await options.getByRole('button', { name: 'Save settings' }).click(); await expect(options.locator('#status')).toHaveText('Settings saved.'); await options.close();
    await page.bringToFront();
    await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:4173/*' });
      await (globalThis as typeof globalThis & { __stretchtextTestAction: (tab: chrome.tabs.Tab) => Promise<void> }).__stretchtextTestAction(tab!);
    });
    await expect(page.locator('[data-stretchtext="status"]')).toContainText('Allow sending eligible website text');
    expect(providerRequests).toBe(0);
    await expect(page.locator('[data-stretchtext="status"]')).toHaveCount(1);
    await expect(page.locator('#rich')).toContainText('a useful link');
    await expect(page.locator('#story-link')).toHaveAttribute('href', '#story');
    await expect(page.locator('input')).toHaveValue('must not be sent');
    await expect(page.locator('[data-stretchtext="status"]')).toHaveCount(0, { timeout: 6500 });
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('mocked API shortens in place, expands the original nodes, and preserves site mutations', async () => {
  await mkdir('.browser-profile', { recursive: true });
  const profile = await mkdtemp(resolve('.browser-profile', 'success-'));
  let context;
  let apiRequestSeen!: () => void;
  const firstRequestSeen = new Promise<void>((resolveSeen) => { apiRequestSeen = resolveSeen; });
  let requestCount = 0;
  let requestedText = '';
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`]
    });
    await context.route('https://api.anthropic.com/v1/messages', async (route) => {
      requestCount++;
      expect(route.request().headers()['anthropic-workspace-id']).toBe('wrkspc_TestWorkspace');
      if (requestCount === 1) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      }
      const request = JSON.parse(route.request().postData()!) as { messages: Array<{ content: string }> };
      const input = JSON.parse(request.messages[0]!.content) as { blocks: Array<{ id: string; text: string }> };
      requestedText += input.blocks.map((block) => block.text).join('\n');
      if (requestCount === 1) apiRequestSeen();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify({ summaries: input.blocks.map(({ id }) => ({ id, text: 'Short <b>summary</b>.' })) }) }],
        stop_reason: 'end_turn'
      }) });
    });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:4173');
    await page.evaluate(() => {
      const target = window as Window & { originalLink?: Node; originalMarkup?: string };
      target.originalLink = document.querySelector('#story-link')!;
      target.originalMarkup = document.querySelector('#rich')!.innerHTML;
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const options = await context.newPage();
    await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
    await options.locator('#apiKey').fill('mock-test-key');
    await options.locator('#model').fill('claude-haiku-4-5');
    await options.locator('#workspaceId').fill('wrkspc_TestWorkspace');
    await options.locator('#websiteTextConsent').check();
    await options.getByRole('button', { name: 'Save settings' }).click();
    await expect(options.locator('#status')).toHaveText('Settings saved.');
    await options.reload();
    await expect(options.locator('#apiKey')).toHaveValue('');
    await expect(options.locator('#apiKey')).toHaveAttribute('placeholder', 'Saved API key (leave blank to keep)');
    await expect(options.locator('#workspaceId')).toHaveValue('wrkspc_TestWorkspace');
    await options.close();
    await page.bringToFront();
    await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:4173/*' });
      await (globalThis as typeof globalThis & { __stretchtextTestAction: (tab: chrome.tabs.Tab) => Promise<void> }).__stretchtextTestAction(tab!);
    });
    await firstRequestSeen;
    expect(requestedText).toContain('below the viewport');
    expect(requestedText).not.toContain('Hidden prose');
    expect(requestedText).not.toContain('Media fallback');
    expect(requestedText).not.toContain('Navigation should remain');
    expect(requestedText).not.toContain('must not be sent');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.evaluate(() => { document.querySelector('#mutation')!.textContent = 'Updated while the request was pending.'; });
    await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:4173/*' });
      await (globalThis as typeof globalThis & { __stretchtextTestAction: (tab: chrome.tabs.Tab) => Promise<void> }).__stretchtextTestAction(tab!);
    });
    await page.waitForTimeout(600);
    await expect(page.locator('#mutation')).toHaveText('Updated while the request was pending.');
    await expect(page.locator('#rich')).toContainText('This paragraph contains');
    await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:4173/*' });
      await (globalThis as typeof globalThis & { __stretchtextTestAction: (tab: chrome.tabs.Tab) => Promise<void> }).__stretchtextTestAction(tab!);
    });
    await page.waitForFunction(() => document.querySelector('#rich')?.textContent === 'Short <b>summary</b>.');
    await expect(page.locator('#rich b')).toHaveCount(0);
    await page.mouse.move(0, 0);
    await expect(page.locator('#rich button.stretchtext-summary')).toHaveCSS('text-decoration-line', 'none');
    await page.locator('#rich button.stretchtext-summary').hover();
    await expect(page.locator('#rich button.stretchtext-summary')).toHaveCSS('text-decoration-line', 'underline');
    await expect(page.locator('[data-stretchtext="status"]')).toHaveCount(0, { timeout: 6500 });
    await page.locator('#rich button.stretchtext-summary').click();
    await expect(page.locator('#story-link')).toBeVisible();
    expect(await page.evaluate(() => document.querySelector('#story-link') === (window as Window & { originalLink?: Node }).originalLink)).toBe(true);
    await page.locator('#listener').click();
    await expect(page.locator('body')).toHaveAttribute('data-listener', 'fired');
    await page.locator('#rich button.stretchtext-collapse').click();
    await expect(page.locator('#rich')).toContainText('Short <b>summary</b>.');
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.locator('#rich button.stretchtext-summary').press('Enter');
      await expect(page.locator('#story-link')).toBeVisible();
      await page.locator('#rich button.stretchtext-collapse').click();
      await expect(page.locator('#rich')).toContainText('Short <b>summary</b>.');
    }
    await page.evaluate(() => { document.querySelector('#mutation')!.textContent = 'New content from the site renderer.'; });
    await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:4173/*' });
      await (globalThis as typeof globalThis & { __stretchtextTestAction: (tab: chrome.tabs.Tab) => Promise<void> }).__stretchtextTestAction(tab!);
    });
    await expect(page.locator('#mutation')).toHaveText('New content from the site renderer.');
    await expect(page.locator('#rich')).toContainText('This paragraph contains');
    expect(await page.evaluate(() => document.querySelector('#rich')!.innerHTML === (window as Window & { originalMarkup?: string }).originalMarkup)).toBe(true);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('Chromium options and page flow work with mocked APIs for all three providers', async () => {
  await mkdir('.browser-profile', { recursive: true });
  const profile = await mkdtemp(resolve('.browser-profile', 'providers-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`] });
    const providers = [
      { name: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-haiku-5-5' },
      { name: 'openai', endpoint: 'https://api.openai.com/v1/responses', model: 'gpt-5-mini' },
      { name: 'openrouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions', model: 'anthropic/claude-haiku-5.5' }
    ];
    await context.route(/https:\/\/(api\.anthropic\.com\/v1|api\.openai\.com\/v1|openrouter\.ai\/api\/v1)\/models(?:\?.*)?$/, async (route) => {
      const provider = providers.find((item) => route.request().url().startsWith(new URL(item.endpoint).origin))!;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: provider.model, name: 'Selected text model' }], has_more: false }) });
    });
    for (const provider of providers) {
      let truncateOnce = true;
      await context.route(provider.endpoint, async (route) => {
        const body = JSON.parse(route.request().postData()!) as { messages?: Array<{ content: string }>; input?: string };
        if (truncateOnce) {
          truncateOnce = false;
          const truncated = provider.name === 'anthropic' ? { stop_reason: 'max_tokens' }
            : provider.name === 'openai' ? { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
              : { choices: [{ finish_reason: 'length' }] };
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(truncated) });
          return;
        }
        const blocks = body.input ? JSON.parse(body.input).blocks : JSON.parse(body.messages![provider.name === 'openrouter' ? 1 : 0]!.content).blocks;
        const json = JSON.stringify({ summaries: blocks.map(({ id }: { id: string }) => ({ id, text: 'A short provider summary.' })) });
        const payload = provider.name === 'anthropic' ? { content: [{ type: 'text', text: json }], stop_reason: 'end_turn' }
          : provider.name === 'openai' ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: json }] }] }
            : { choices: [{ finish_reason: 'stop', message: { content: json } }] };
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
      });
    }
    const page = await context.newPage(); await page.goto('http://127.0.0.1:4173');
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const options = await context.newPage(); await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
    const action = () => worker.evaluate(async () => { const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:4173/*' }); await (globalThis as typeof globalThis & { __stretchtextTestAction: (tab: chrome.tabs.Tab) => Promise<void> }).__stretchtextTestAction(tab!); });
    for (const provider of providers) {
      await options.locator('#websiteTextConsent').check();
      await options.locator('#provider').selectOption(provider.name);
      await options.locator('#apiKey').fill(`fake-${provider.name}-key`);
      await options.getByRole('button', { name: 'Refresh models' }).click();
      await expect(options.locator('#modelSelect')).toBeEnabled();
      await options.locator('#modelSelect').selectOption(provider.model);
      await expect(options.locator('#model')).toHaveValue(provider.model);
      await options.getByRole('button', { name: 'Save settings' }).click();
      await expect(options.locator('#status')).toHaveText('Settings saved.');
      await page.bringToFront(); await action();
      await expect(page.locator('#rich button.stretchtext-summary')).toBeVisible();
      await action();
      await expect(page.locator('#rich')).toContainText('This paragraph contains');
      await options.bringToFront();
    }
    await page.bringToFront();
    const interrupted = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:4173/*' });
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab!.id! }, func: async () => chrome.runtime.sendMessage({ type: 'summarize', runId: crypto.randomUUID(), requestId: crypto.randomUUID(), blocks: [{ id: 'a', text: 'This must never go to a provider without an established run.' }] }) });
      return result!.result;
    });
    expect(interrupted.error).toContain('page run was interrupted');
  } finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }
});

test('restore safely preserves synchronous site changes to collapsed and expanded controls', async () => {
  await mkdir('.browser-profile', { recursive: true });
  const profile = await mkdtemp(resolve('.browser-profile', 'release-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`] });
    await context.route('https://api.anthropic.com/v1/messages', async (route) => {
      const request = JSON.parse(route.request().postData()!) as { messages: Array<{ content: string }> };
      const input = JSON.parse(request.messages[0]!.content) as { blocks: Array<{ id: string }> };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ summaries: input.blocks.map(({ id }) => ({ id, text: 'Short summary.' })) }) }], stop_reason: 'end_turn' }) });
    });
    const page = await context.newPage(); await page.goto('http://127.0.0.1:4173');
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
     const options = await context.newPage(); await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`); await options.locator('#apiKey').fill('mock-test-key'); await options.locator('#websiteTextConsent').check(); await options.getByRole('button', { name: 'Save settings' }).click(); await expect(options.locator('#status')).toHaveText('Settings saved.'); await options.close(); await page.bringToFront();
    const action = () => worker.evaluate(async () => { const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:4173/*' }); await (globalThis as typeof globalThis & { __stretchtextTestAction: (tab: chrome.tabs.Tab) => Promise<void> }).__stretchtextTestAction(tab!); });
    await action(); await expect(page.locator('#rich button.stretchtext-summary')).toBeVisible();
    await page.evaluate(() => { const host = document.querySelector('#rich')!; const added = document.createElement('span'); added.id = 'site-added'; added.textContent = 'site node'; host.append(added); });
    await action();
    await expect(page.locator('#site-added')).toHaveText('site node'); await expect(page.locator('#story-link')).toBeAttached();
    await action(); await expect(page.locator('#rich button.stretchtext-summary')).toBeVisible();
    await page.locator('#rich button.stretchtext-summary').press('Enter');
    await page.locator('#story-link').evaluate((link) => link.setAttribute('href', '#site-updated'));
    await action();
    await expect(page.locator('#story-link')).toHaveAttribute('href', '#site-updated');
    await expect(page.locator('#rich button.stretchtext-collapse')).toHaveCount(0);
    await action(); await expect(page.locator('#rich button.stretchtext-summary')).toBeVisible();
    await page.locator('#rich button.stretchtext-summary').evaluate((button) => { button.textContent = 'site changed control'; });
    await action();
    await expect(page.locator('#rich')).toContainText('site changed control');
    await expect(page.locator('#story-link')).toHaveCount(0);
    await action();
    const list = page.locator('#list-item button.stretchtext-summary');
    await expect(list).toBeVisible();
    await list.evaluate((button) => { const replacement = document.createElement('span'); replacement.id = 'replacement-control'; replacement.textContent = 'renderer replacement'; button.replaceWith(replacement); });
    await action();
    await expect(page.locator('#replacement-control')).toHaveText('renderer replacement');
  } finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }
});

test('HTTP errors and malformed JSON keep original page content intact', async () => {
  await mkdir('.browser-profile', { recursive: true });
  const profile = await mkdtemp(resolve('.browser-profile', 'errors-'));
  let context;
  let request = 0;
  try {
    context = await chromium.launchPersistentContext(profile, { headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`] });
    await context.route('https://api.anthropic.com/v1/messages', async (route) => {
      request++;
      expect(route.request().headers()).not.toHaveProperty('anthropic-workspace-id');
      if (request === 1) await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }) });
      else await route.fulfill({ status: 200, contentType: 'application/json', body: '{bad json' });
    });
    const page = await context.newPage(); await page.goto('http://127.0.0.1:4173');
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
     const options = await context.newPage(); await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`); await options.locator('#apiKey').fill('mock-test-key'); await options.locator('#websiteTextConsent').check(); await options.getByRole('button', { name: 'Save settings' }).click(); await expect(options.locator('#status')).toHaveText('Settings saved.'); await options.close(); await page.bringToFront();
    const action = () => worker.evaluate(async () => { const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:4173/*' }); await (globalThis as typeof globalThis & { __stretchtextTestAction: (tab: chrome.tabs.Tab) => Promise<void> }).__stretchtextTestAction(tab!); });
    const original = await page.locator('#rich').innerHTML();
    await action(); await expect(page.locator('[data-stretchtext="status"]')).toContainText('400'); await expect(page.locator('[data-stretchtext="status"]')).toContainText('Your credit balance is too low'); await expect(page.locator('#rich')).toHaveJSProperty('innerHTML', original);
    await action(); await expect(page.locator('[data-stretchtext="status"]')).toContainText('invalid JSON'); await expect(page.locator('#rich')).toHaveJSProperty('innerHTML', original);
  } finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }
});

test('selection mode sends only the selected text and restores the exact surrounding passage', async () => {
  await mkdir('.browser-profile', { recursive: true });
  const profile = await mkdtemp(resolve('.browser-profile', 'selection-'));
  let context;
  let submitted = '';
  try {
    context = await chromium.launchPersistentContext(profile, { headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`] });
    await context.route('https://api.anthropic.com/v1/messages', async (route) => {
      const request = JSON.parse(route.request().postData()!) as { messages: Array<{ content: string }> };
      const input = JSON.parse(request.messages[0]!.content) as { blocks: Array<{ id: string; text: string }> };
      submitted = input.blocks[0]!.text;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ summaries: input.blocks.map(({ id }) => ({ id, text: 'A concise selected passage.' })) }) }], stop_reason: 'end_turn' }) });
    });
    const page = await context.newPage(); await page.goto('http://127.0.0.1:4173');
    await page.locator('#rich').evaluate((element) => { element.innerHTML = '<p id="selection">Before selected words: This passage contains enough meaningful words to shorten independently. After selected words.</p>'; });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const options = await context.newPage(); await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
    await options.locator('#apiKey').fill('mock-selection-key'); await options.locator('#websiteTextConsent').check(); await options.getByRole('button', { name: 'Save settings' }).click(); await expect(options.locator('#status')).toHaveText('Settings saved.'); await options.close(); await page.bringToFront();
    const expected = 'This passage contains enough meaningful words to shorten independently.';
    await page.locator('#selection').evaluate((element, selected) => {
      const text = element.firstChild!; const start = text.textContent!.indexOf(selected);
      const range = document.createRange(); range.setStart(text, start); range.setEnd(text, start + selected.length);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    }, expected);
    await worker.evaluate(async (selectionText) => { const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:4173/*' }); await (globalThis as typeof globalThis & { __stretchtextTestSelection: (info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab) => Promise<void> }).__stretchtextTestSelection({ menuItemId: 'stretch-selection', selectionText, frameId: 0, editable: false }, tab!); }, expected);
    await expect(page.locator('[data-stretchtext="status"]')).toBeAttached();
    await expect(page.locator('#selection')).toContainText('A concise selected passage.');
    expect(submitted).toBe(expected);
    await page.getByRole('button', { name: 'A concise selected passage.' }).click();
    await expect(page.locator('#selection')).toHaveText('Before selected words: This passage contains enough meaningful words to shorten independently. Collapse After selected words.');
    await worker.evaluate(async () => { const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:4173/*' }); await (globalThis as typeof globalThis & { __stretchtextTestAction: (tab: chrome.tabs.Tab) => Promise<void> }).__stretchtextTestAction(tab!); });
    await expect(page.locator('#selection [data-stretch-selection]')).toHaveCount(0);
    await expect(page.locator('#selection')).toHaveText('Before selected words: This passage contains enough meaningful words to shorten independently. After selected words.');
  } finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }
});
