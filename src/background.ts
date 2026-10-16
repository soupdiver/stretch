import { complete, isProvider, listModels, normalizeSettings, testConnection, type Provider, type ProviderSettings } from './providers';
declare const __TEST_BUILD__: boolean;

const storageAccessReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const requests = new Map<string, AbortController>();
const runSettings = new Map<string, { provider: Provider; config: ReturnType<typeof normalizeSettings>['providers'][Provider] }>();
const selectionMenuId = 'stretch-selection';

async function registerSelectionMenu(): Promise<void> {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: selectionMenuId, title: 'Stretch selection', contexts: ['selection'] });
}
chrome.runtime.onInstalled.addListener((details) => {
  void registerSelectionMenu();
  if (details.reason === 'install') void chrome.runtime.openOptionsPage();
});
chrome.contextMenus.onClicked.addListener(onSelectionClicked);

async function onSelectionClicked(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  if (info.menuItemId !== selectionMenuId || tab?.id === undefined) return;
  const tabId = tab.id;
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tabId, { type: 'stretch-selection', selectionText: info.selectionText, unsupportedFrame: (info.frameId ?? 0) !== 0 }, { frameId: 0 });
  } catch { /* Unsupported browser pages cannot receive extension scripts. */ }
}

function requestKey(tabId: number | undefined, requestId: unknown): string | undefined {
  return tabId !== undefined && typeof requestId === 'string' && /^[0-9a-f-]{36}$/i.test(requestId) ? `${tabId}:${requestId}` : undefined;
}

async function onActionClicked(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
    } catch { /* Unsupported browser pages cannot receive extension scripts. */ }
  }
}
chrome.action.onClicked.addListener(onActionClicked);
if (__TEST_BUILD__) {
  (globalThis as typeof globalThis & { __stretchtextTestAction?: typeof onActionClicked }).__stretchtextTestAction = onActionClicked;
  (globalThis as typeof globalThis & { __stretchtextTestSelection?: typeof onSelectionClicked }).__stretchtextTestSelection = onSelectionClicked;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'provider-load' || message?.type === 'provider-settings' || message?.type === 'provider-models' || message?.type === 'provider-test') {
    if (_sender.id !== chrome.runtime.id || !_sender.url?.startsWith(chrome.runtime.getURL(''))) { sendResponse({ error: 'Unauthorized request.' }); return; }
    void (async () => {
      await storageAccessReady;
       const raw = await chrome.storage.local.get(['providers', 'selectedProvider', 'apiKey', 'model', 'workspaceId', 'websiteTextConsent']) as ProviderSettings & { websiteTextConsent?: boolean };
      const settings = normalizeSettings(raw);
      if (message.type === 'provider-load') {
        if (raw.apiKey && !raw.providers?.anthropic?.apiKey) {
          await chrome.storage.local.set({ providers: settings.providers, selectedProvider: settings.selectedProvider });
          await chrome.storage.local.remove(['apiKey', 'model', 'workspaceId']);
        }
         sendResponse({ selectedProvider: settings.selectedProvider, websiteTextConsent: raw.websiteTextConsent === true, providers: Object.fromEntries(Object.entries(settings.providers).map(([provider, config]) => [provider, { model: config.model ?? '', workspaceId: provider === 'anthropic' ? config.workspaceId ?? '' : '', hasKey: Boolean(config.apiKey) }])) }); return;
      }
      if (message.type === 'provider-settings') {
        const provider = message.provider;
        if (!isProvider(provider)) throw new Error('Unknown provider.');
        const current = settings.providers[provider];
        const apiKey = typeof message.apiKey === 'string' && message.apiKey.trim() ? message.apiKey.trim() : current.apiKey;
        if (message.clearKey === true) delete current.apiKey;
        else if (apiKey) current.apiKey = apiKey;
        if (typeof message.model === 'string') current.model = message.model.trim();
        if (provider === 'anthropic' && typeof message.workspaceId === 'string') current.workspaceId = message.workspaceId.trim();
        settings.selectedProvider = provider;
         await chrome.storage.local.set({ providers: settings.providers, selectedProvider: provider });
          if (typeof message.websiteTextConsent === 'boolean') {
            await chrome.storage.local.set({ websiteTextConsent: message.websiteTextConsent });
            if (!message.websiteTextConsent) {
              for (const controller of requests.values()) controller.abort();
              runSettings.clear();
            }
          }
        await chrome.storage.local.remove(['apiKey', 'model', 'workspaceId']);
        sendResponse({ saved: true, hasKey: Boolean(current.apiKey) }); return;
      }
      const provider: Provider | undefined = isProvider(message.provider) ? message.provider : undefined;
      if (!provider) throw new Error('Unknown provider.');
      const config = { ...settings.providers[provider] };
      if (typeof message.apiKey === 'string' && message.apiKey.trim()) config.apiKey = message.apiKey.trim();
      if (typeof message.model === 'string') config.model = message.model.trim();
      if (provider === 'anthropic' && typeof message.workspaceId === 'string') config.workspaceId = message.workspaceId.trim();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 24000);
      try {
        if (message.type === 'provider-models') sendResponse({ models: await listModels(provider, config, controller.signal) });
        else { await testConnection(provider, config, controller.signal); sendResponse({ ok: true }); }
      } finally { clearTimeout(timer); }
    })().catch((error: unknown) => sendResponse({ error: error instanceof Error ? error.message : 'Provider request failed.' }));
    return true;
  }
  if (message?.type === 'finish-run') {
    const runKey = requestKey(_sender.tab?.id, message.runId);
    if (runKey) runSettings.delete(runKey);
    sendResponse({ finished: true }); return;
  }
  if (message?.type === 'begin-run') {
    const runKey = requestKey(_sender.tab?.id, message.runId);
    if (!runKey) { sendResponse({ error: 'Invalid run.' }); return; }
    void (async () => {
      await storageAccessReady;
       const raw = await chrome.storage.local.get(['providers', 'selectedProvider', 'apiKey', 'model', 'workspaceId']) as ProviderSettings;
       const selected = normalizeSettings(raw);
       const consent = await chrome.storage.local.get('websiteTextConsent');
       if (consent.websiteTextConsent !== true) throw new Error('Allow sending eligible website text to your selected provider in Stretch settings first.');
      runSettings.set(runKey, { provider: selected.selectedProvider, config: { ...selected.providers[selected.selectedProvider] } });
      if (!runSettings.get(runKey)?.config.apiKey) {
        runSettings.delete(runKey);
        const label = selected.selectedProvider === 'openrouter' ? 'OpenRouter' : selected.selectedProvider === 'openai' ? 'OpenAI' : 'Anthropic';
        throw new Error(`Add an ${label} API key in extension options first.`);
      }
      sendResponse({ ready: true });
    })().catch((error: unknown) => sendResponse({ error: error instanceof Error ? error.message : 'Could not load provider settings.' }));
    return true;
  }
  if (message?.type === 'cancel') {
    const key = requestKey(_sender.tab?.id, message.requestId);
    if (key) requests.get(key)?.abort();
    sendResponse({ cancelled: true });
    return;
  }
  if (message?.type !== 'summarize') return;
  const key = requestKey(_sender.tab?.id, message.requestId);
  if (!key || requests.has(key)) { sendResponse({ error: 'Invalid request.' }); return; }
  const runId = typeof message.runId === 'string' ? message.runId : message.requestId;
  const runKey = requestKey(_sender.tab?.id, runId);
  if (!runKey) { sendResponse({ error: 'Invalid run.' }); return; }
  const controller = new AbortController();
  requests.set(key, controller);
  summarize(message.blocks, controller, runKey).then((summaries) => sendResponse({ summaries })).catch((error: unknown) => {
    sendResponse({ error: error instanceof Error ? error.message : 'Request failed.' });
  }).finally(() => {
    if (requests.get(key) === controller) requests.delete(key);
  });
  return true;
});

async function summarize(input: unknown, controller: AbortController, runKey: string): Promise<unknown> {
  await storageAccessReady;
  const pinned = runSettings.get(runKey);
  if (!pinned) throw new Error('This page run was interrupted. Activate Stretchtext again to start a new run.');
  const timer = setTimeout(() => controller.abort(), 24000);
  try { return await complete(pinned.provider, pinned.config, input as never[], controller.signal); }
  finally { clearTimeout(timer); }
}
