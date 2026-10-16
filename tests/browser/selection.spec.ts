import { test, expect, chromium, type Page, type Worker } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const passage = 'This passage contains enough meaningful words to shorten independently without losing important details.';
const summary = 'A concise selected passage.';

async function select(page: Page, selector = '#target', text?: string): Promise<string> {
  return page.locator(selector).evaluate((element, substring) => {
    const range = document.createRange();
    if (substring !== undefined) {
      const node = element.firstChild!;
      const offset = node.textContent!.indexOf(substring);
      range.setStart(node, offset); range.setEnd(node, offset + substring.length);
    } else range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    return range.toString();
  }, text);
}

async function menu(worker: Worker, selectionText: string, frameId = 0): Promise<void> {
  await worker.evaluate(async ({ selectionText, frameId }) => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:4173/*' });
    await (globalThis as typeof globalThis & { __stretchtextTestSelection: (info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab) => Promise<void> }).__stretchtextTestSelection({ menuItemId: 'stretch-selection', selectionText, frameId, editable: false }, tab!);
  }, { selectionText, frameId });
}

async function action(worker: Worker): Promise<void> {
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:4173/*' });
    await (globalThis as typeof globalThis & { __stretchtextTestAction: (tab: chrome.tabs.Tab) => Promise<void> }).__stretchtextTestAction(tab!);
  });
}

async function harness(run: (state: Awaited<ReturnType<typeof setup>>) => Promise<void>): Promise<void> {
  const state = await setup();
  try { await run(state); }
  finally { state.releaseAll(); await state.context.close(); await rm(state.profile, { recursive: true, force: true }); }
}

async function setup() {
  await mkdir('.browser-profile', { recursive: true });
  const profile = await mkdtemp(resolve('.browser-profile', 'selection-safety-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`]
  });
  const state = { held: false, response: 'success' as 'success' | 'error' | 'long' | 'truncate', requests: [] as Array<{ text: string; model: string; release: () => void }> };
  await context.route('https://api.anthropic.com/v1/messages', async (route) => {
    const body = route.request().postDataJSON();
    const input = JSON.parse(body.messages[0].content) as { blocks: Array<{ id: string; text: string }> };
    let release!: () => void;
    const wait = new Promise<void>((resolveWait) => { release = resolveWait; });
    state.requests.push({ text: input.blocks.map((block) => block.text).join('\n'), model: body.model, release });
    if (state.held) await wait;
    try {
      if (state.response === 'error') await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Mock selection failure.' } }) });
      else if (state.response === 'truncate') {
        state.response = 'success';
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ stop_reason: 'max_tokens' }) });
      } else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ summaries: input.blocks.map(({ id, text }) => ({ id, text: state.response === 'long' ? text : summary })) }) }], stop_reason: 'end_turn' }) });
    } catch (error) { if (!route.request().failure()) throw error; }
  });
  // Block unexpected providers: these tests must never use live inference.
  await context.route(/https:\/\/(api\.openai\.com|openrouter\.ai)\//, (route) => route.abort());
  const page = await context.newPage(); await page.goto('http://127.0.0.1:4173');
  await page.evaluate((text) => { document.body.innerHTML = `<div id="comments"><p id="target">${text}</p><p id="other">Unrelated paragraph remains exactly as the website wrote it.</p></div>`; }, passage);
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ selectedProvider: 'anthropic', providers: { anthropic: { apiKey: 'mock-selection-key', model: 'claude-haiku-4-5' } }, websiteTextConsent: true });
  });
  await page.bringToFront();
  return { context, page, worker, profile, state, releaseAll: () => state.requests.forEach((request) => request.release()) };
}

test('selection supports no siblings and nested inline parents without widening text', async () => {
  await harness(async ({ page, worker, state }) => {
    for (const nested of [false, true]) {
      await page.locator('#target').evaluate((element, { nested, passage }) => { element.innerHTML = nested ? `Prefix <em id="em">${passage}</em> suffix.` : passage; }, { nested, passage });
      const original = await page.locator('#comments').innerHTML();
      const text = await select(page, nested ? '#em' : '#target');
      await menu(worker, text);
      await expect(page.locator('#target .stretchtext-summary')).toHaveText(summary);
      expect(state.requests.at(-1)!.text).toBe(passage);
      if (nested) await expect(page.locator('#target')).toHaveText(`Prefix ${summary} suffix.`);
      await page.locator('#target .stretchtext-summary').press('Enter');
      await expect(page.locator('#target .stretchtext-collapse')).toBeVisible();
      await action(worker);
      await expect(page.locator('[data-stretch-selection]')).toHaveCount(0);
      expect(await page.locator('#comments').innerHTML()).toBe(original);
    }
  });
});

test('revoking consent cancels pending inference and blocks subsequent page requests', async () => {
  await harness(async ({ context, page, worker, state }) => {
    state.held = true;
    await menu(worker, await select(page));
    await expect.poll(() => state.requests.length).toBe(1);
    const options = await context.newPage();
    await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
    await options.locator('#status').filter({ hasText: 'Settings loaded.' }).waitFor();
    const response = await options.evaluate(async () => chrome.runtime.sendMessage({ type: 'provider-settings', provider: 'anthropic', websiteTextConsent: false }));
    expect(response.saved).toBe(true);
    await expect(page.locator('[data-stretch-selection]')).toHaveCount(0);
    await page.bringToFront();
    await menu(worker, await select(page));
    await expect(page.locator('[data-stretchtext="status"]')).toContainText('Allow sending');
    expect(state.requests).toHaveLength(1);
    await options.close();
  });
});

test('whole inline links and emphasis retain identities and listeners on expand and restore', async () => {
  await harness(async ({ page, worker, state }) => {
    await page.locator('#target').evaluate((element) => {
      element.innerHTML = 'This meaningful paragraph has <a id="link" href="#story">a useful link</a> and <em id="em">important emphasis</em> alongside enough original details to shorten.';
      const link = element.querySelector('#link')!;
      link.addEventListener('click', (event) => { event.preventDefault(); document.body.dataset.listener = 'fired'; });
      (window as Window & { selectedNodes?: Node[] }).selectedNodes = Array.from(element.childNodes);
    });
    const original = await page.locator('#target').innerHTML();
    const text = await select(page);
    await menu(worker, text);
    await expect(page.locator('#target .stretchtext-summary')).toHaveText(summary);
    expect(state.requests[0]!.text).toBe(text);
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.locator('#target .stretchtext-summary').press('Enter');
      expect(await page.locator('[data-stretch-selection]').evaluate((element) => (window as Window & { selectedNodes?: Node[] }).selectedNodes!.every((node, index) => element.childNodes[index] === node))).toBe(true);
      await page.locator('#link').click(); await expect(page.locator('body')).toHaveAttribute('data-listener', 'fired');
      await page.locator('#target .stretchtext-collapse').press('Space');
    }
    await action(worker);
    await expect(page.locator('[data-stretch-selection]')).toHaveCount(0);
    expect(await page.locator('#target').innerHTML()).toBe(original);
    expect(await page.locator('#target').evaluate((element) => (window as Window & { selectedNodes?: Node[] }).selectedNodes!.every((node, index) => element.childNodes[index] === node))).toBe(true);
  });
});

test('invalid and unsafe selections reject before wrapping or inference', async () => {
  await harness(async ({ page, worker, state }) => {
    const rejected = async (text: string, frameId = 0) => {
      const original = await page.locator('#comments').innerHTML();
      await menu(worker, text, frameId);
      await expect(page.locator('[data-stretchtext="status"]')).toBeVisible();
      await expect(page.locator('[data-stretch-selection]')).toHaveCount(0);
      expect(await page.locator('#comments').innerHTML()).toBe(original);
      expect(state.requests).toHaveLength(0);
    };
    await rejected('');
    await rejected(await select(page), 7);
    await rejected('Stale menu text different from the selected passage.');
    await page.locator('#target').evaluate((element) => { element.textContent = 'Too short.'; });
    await rejected(await select(page));
    await page.locator('#target').evaluate((element, text) => { element.textContent = text.repeat(200); }, passage);
    await rejected(await select(page));
    await page.locator('#target').evaluate((element, text) => { element.textContent = text; }, passage);
    const crossBlock = await page.evaluate(() => { const range = document.createRange(); range.setStart(document.querySelector('#target')!, 0); range.setEndAfter(document.querySelector('#other')!); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); return range.toString(); });
    await rejected(crossBlock);
    for (const markup of [
      `<a id="unsafe" href="#">${passage}</a>`, `<span id="unsafe" contenteditable>${passage}</span>`,
      `<button id="unsafe">${passage}</button>`, `<code id="unsafe">${passage}</code>`,
      `<span id="unsafe" style="display:none">${passage}</span>`, `<span id="unsafe" hidden>${passage}</span>`,
      `<span id="unsafe" role="button">${passage}</span>`, `<img src="data:,">${passage}`,
      `<table><tbody><tr><td id="unsafe">${passage}</td></tr></tbody></table>`
    ]) {
      await page.locator('#target').evaluate((element, markup) => { element.innerHTML = markup; }, markup);
      await rejected(await select(page, await page.locator('#unsafe').count() ? '#unsafe' : '#target'));
    }
    await page.locator('#target').evaluate((element, text) => { element.innerHTML = `<em>${text}</em> trailing original words.`; }, passage);
    const partial = await page.evaluate(() => { const range = document.createRange(); range.setStart(document.querySelector('#target em')!.firstChild!, 2); range.setEnd(document.querySelector('#target')!.lastChild!, 15); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); return range.toString(); });
    await rejected(partial);
  });
});

test('pending source mutations and identity replacement abandon safely without losing site changes', async () => {
  await harness(async ({ page, worker, state }) => {
    state.held = true;
    for (const mutation of ['source', 'sibling', 'identity', 'ancestor', 'detached', 'visibility'] as const) {
      await page.evaluate((text) => { document.querySelector('#comments')!.innerHTML = `<p id="target">${text}</p><p id="other">Other original text.</p>`; }, passage);
      const count = state.requests.length;
      await menu(worker, await select(page));
      await expect.poll(() => state.requests.length).toBe(count + 1);
      await page.evaluate((mutation) => {
        const wrapper = document.querySelector('[data-stretch-selection]')!;
        if (mutation === 'source') wrapper.textContent = 'New source from the website renderer.';
        if (mutation === 'sibling') { const added = document.createElement('b'); added.id = 'added'; added.textContent = 'Site-added text.'; wrapper.after(added); }
        if (mutation === 'identity') wrapper.firstChild!.replaceWith(wrapper.firstChild!.cloneNode(true));
        if (mutation === 'ancestor') { const container = document.createElement('div'); document.querySelector('#comments')!.append(container); container.append(document.querySelector('#target')!); }
        if (mutation === 'detached') document.querySelector('#target')!.remove();
        if (mutation === 'visibility') { const style = document.createElement('style'); style.id = 'site-visibility'; style.textContent = '[data-stretch-selection] { visibility: hidden; }'; document.head.append(style); }
      }, mutation);
      const before = await page.locator('#comments').textContent();
      state.requests.at(-1)!.release();
      await expect(page.locator('[data-stretchtext="status"]')).toContainText('selected text changed');
      await expect(page.locator('[data-stretch-selection]')).toHaveCount(0);
      expect(await page.locator('#comments').textContent()).toBe(before);
      await expect(page.locator('.stretchtext-summary')).toHaveCount(0);
      await page.evaluate(() => document.querySelector('#site-visibility')?.remove());
    }
  });
});

test('canceling pending selection cleans wrapper immediately and cannot overwrite a reactivated run', async () => {
  await harness(async ({ page, worker, state }) => {
    state.held = true;
    const text = await select(page);
    await menu(worker, text);
    await expect.poll(() => state.requests.length).toBe(1);
    await expect(page.locator('[data-stretchtext="status"]')).toHaveText('Shortening selected text…');
    await action(worker);
    await expect(page.locator('[data-stretch-selection]')).toHaveCount(0);
    await expect(page.locator('[data-stretchtext="status"]')).toHaveCount(0);
    await menu(worker, await select(page));
    await expect.poll(() => state.requests.length).toBe(2);
    state.requests[0]!.release();
    await expect(page.locator('[data-stretchtext="status"]')).toHaveText('Shortening selected text…');
    state.requests[1]!.release();
    await expect(page.locator('.stretchtext-summary')).toHaveText(summary);
    await expect(page.locator('[data-stretchtext="status"]')).toContainText('Selected text shortened');
    await action(worker);
    await expect(page.locator('#target')).toHaveText(passage);
    await expect(page.locator('[data-stretch-selection]')).toHaveCount(0);
  });
});

test('menu reentry restores pending and completed runs first with a clear notice', async () => {
  await harness(async ({ page, worker, state }) => {
    state.held = true;
    await menu(worker, await select(page));
    await expect.poll(() => state.requests.length).toBe(1);
    await menu(worker, passage);
    await expect(page.locator('[data-stretchtext="status"]')).toContainText('Restored the active Stretch run');
    await expect(page.locator('[data-stretch-selection]')).toHaveCount(0);
    state.requests[0]!.release(); state.held = false;
    await menu(worker, await select(page));
    await expect(page.locator('.stretchtext-summary')).toHaveText(summary);
    await menu(worker, passage);
    await expect(page.locator('[data-stretchtext="status"]')).toContainText('Restored the active Stretch run');
    await expect(page.locator('#target')).toHaveText(passage);
    await expect(page.locator('[data-stretch-selection]')).toHaveCount(0);
    expect(state.requests).toHaveLength(2);
  });
});

test('selection processing persists, completion expires, and error/no-op/consent clean wrappers', async () => {
  await harness(async ({ page, worker, state }) => {
    state.held = true;
    await menu(worker, await select(page));
    await expect.poll(() => state.requests.length).toBe(1);
    // Content scripts use an isolated world, outside Playwright's page-clock shim.
    await page.waitForTimeout(5200);
    await expect(page.locator('[data-stretchtext="status"]')).toHaveText('Shortening selected text…');
    state.requests[0]!.release();
    await expect(page.locator('.stretchtext-summary')).toHaveText(summary);
    await expect(page.locator('[data-stretchtext="status"]')).toHaveCount(0, { timeout: 6500 });
    await action(worker); state.held = false;
    for (const response of ['error', 'long'] as const) {
      state.response = response;
      await menu(worker, await select(page));
      await expect(page.locator('[data-stretchtext="status"]')).toContainText(response === 'error' ? 'Mock selection failure' : 'could not be shortened');
      await expect(page.locator('[data-stretch-selection]')).toHaveCount(0);
      await expect(page.locator('#target')).toHaveText(passage);
      await expect(page.locator('[data-stretchtext="status"]')).toHaveCount(0, { timeout: 6500 });
    }
    const count = state.requests.length;
    await worker.evaluate(() => chrome.storage.local.set({ websiteTextConsent: false }));
    await menu(worker, await select(page));
    await expect(page.locator('[data-stretchtext="status"]')).toContainText('Allow sending eligible website text');
    await expect(page.locator('[data-stretch-selection]')).toHaveCount(0);
    expect(state.requests).toHaveLength(count);
  });
});

test('selection truncation recovery keeps the provider/model pinned despite settings changes', async () => {
  await harness(async ({ page, worker, state }) => {
    state.held = true; state.response = 'truncate';
    await menu(worker, await select(page));
    await expect.poll(() => state.requests.length).toBe(1);
    await worker.evaluate(() => chrome.storage.local.set({ selectedProvider: 'openai', providers: { openai: { apiKey: 'mock-other-key', model: 'different-model' }, anthropic: { apiKey: 'mock-changed-key', model: 'different-model' } } }));
    state.requests[0]!.release();
    await expect.poll(() => state.requests.length).toBe(2);
    expect(state.requests.map(({ model }) => model)).toEqual(['claude-haiku-4-5', 'claude-haiku-4-5']);
    expect(state.requests.map(({ text }) => text)).toEqual([passage, passage]);
    state.requests[1]!.release();
    await expect(page.locator('.stretchtext-summary')).toHaveText(summary);
  });
});

test('selection restores website additions and changed expanded source without overwriting them', async () => {
  await harness(async ({ page, worker }) => {
    await menu(worker, await select(page));
    await expect(page.locator('.stretchtext-summary')).toHaveText(summary);
    await page.locator('[data-stretch-selection]').evaluate((wrapper) => {
      const added = document.createElement('b'); added.id = 'site-added'; added.textContent = ' Site-added text.'; wrapper.append(added);
    });
    await action(worker);
    await expect(page.locator('[data-stretch-selection]')).toHaveCount(0);
    await expect(page.locator('#target')).toHaveText(`${passage} Site-added text.`);
    await expect(page.locator('#site-added')).toBeAttached();
    await menu(worker, await select(page));
    await expect(page.locator('.stretchtext-summary')).toHaveText(summary);
    await page.locator('.stretchtext-summary').press('Enter');
    await page.locator('[data-stretch-selection]').evaluate((wrapper) => { wrapper.firstChild!.textContent = 'New source from the site.'; });
    await action(worker);
    await expect(page.locator('[data-stretch-selection]')).toHaveCount(0);
    await expect(page.locator('#target')).toHaveText('New source from the site. Site-added text.');
  });
});

test('selection menu restores a pending full-page run instead of losing its managed state', async () => {
  await harness(async ({ page, worker, state }) => {
    state.held = true;
    await action(worker);
    await expect.poll(() => state.requests.length).toBe(1);
    await menu(worker, await select(page));
    await expect(page.locator('[data-stretchtext="status"]')).toContainText('Restored the active Stretch run');
    await expect(page.locator('#target')).toHaveText(passage);
    state.requests[0]!.release(); state.held = false;
    await menu(worker, await select(page));
    await expect(page.locator('#target .stretchtext-summary')).toHaveText(summary);
    await expect(page.locator('#other')).toHaveText('Unrelated paragraph remains exactly as the website wrote it.');
    await action(worker);
    await expect(page.locator('[data-stretch-selection]')).toHaveCount(0);
    await expect(page.locator('#target')).toHaveText(passage);
  });
});
