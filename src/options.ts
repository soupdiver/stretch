import { DEFAULT_MODELS, PROVIDERS, type Provider } from './providers';

type Profile = { model: string; workspaceId: string; hasKey: boolean };
type State = { selectedProvider: Provider; websiteTextConsent: boolean; providers: Record<Provider, Profile> };
const form = document.querySelector<HTMLFormElement>('#settings')!;
const providerSelect = document.querySelector<HTMLSelectElement>('#provider')!;
const model = document.querySelector<HTMLInputElement>('#model')!;
const key = document.querySelector<HTMLInputElement>('#apiKey')!;
const workspace = document.querySelector<HTMLInputElement>('#workspaceId')!;
const workspaceField = document.querySelector<HTMLElement>('#workspaceField')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const modelSelect = document.querySelector<HTMLSelectElement>('#modelSelect')!;
const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-action]'));
let state: State;
let revision = 0;
let busy = false;
let saved = true;
let modelIds = new Set<string>();

async function request<T>(message: unknown): Promise<T> {
  const response = await chrome.runtime.sendMessage(message) as T & { error?: string };
  if (response?.error) throw new Error(response.error);
  return response;
}

function provider(): Provider { return providerSelect.value as Provider; }
function updateStatus(text: string, kind = ''): void { status.textContent = text; status.dataset.kind = kind; }
function markDirty(): void { if (!busy) { saved = false; updateStatus('Unsaved changes'); } }
function render(): void {
  if (!state) return;
  const selected = provider();
  const profile = state.providers[selected];
  model.value = profile.model || DEFAULT_MODELS[selected];
  workspace.value = profile.workspaceId;
  workspaceField.hidden = selected !== 'anthropic';
  key.value = '';
  key.placeholder = profile.hasKey ? 'Saved API key (leave blank to keep)' : 'Paste an API key';
  document.querySelector<HTMLButtonElement>('#clearKey')!.disabled = !profile.hasKey;
  modelSelect.replaceChildren(new Option('Choose a discovered model…', ''));
  modelSelect.disabled = true;
  modelIds = new Set();
}

async function load(): Promise<void> {
  const loaded = await request<State>({ type: 'provider-load' });
  state = loaded;
  providerSelect.value = state.selectedProvider;
  document.querySelector<HTMLInputElement>('#websiteTextConsent')!.checked = state.websiteTextConsent;
  saved = true;
  render();
  updateStatus('Settings loaded.', 'success');
}

async function save(): Promise<void> {
  const selected = provider();
  const result = await request<{ saved: true; hasKey: boolean }>({ type: 'provider-settings', provider: selected, apiKey: key.value, model: model.value.trim() || DEFAULT_MODELS[selected], workspaceId: workspace.value.trim(), websiteTextConsent: document.querySelector<HTMLInputElement>('#websiteTextConsent')!.checked });
  state.providers[selected] = { model: model.value.trim() || DEFAULT_MODELS[selected], workspaceId: selected === 'anthropic' ? workspace.value.trim() : '', hasKey: result.hasKey };
  state.selectedProvider = selected;
  key.value = '';
  saved = true;
  render();
  updateStatus('Settings saved.', 'success');
}

async function withBusy(action: () => Promise<void>, message: string): Promise<void> {
  if (busy) return;
  busy = true;
  const operation = ++revision;
  form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button').forEach((control) => { control.disabled = true; });
  updateStatus(message, 'working');
  try { await action(); }
  catch (error) { if (operation === revision) updateStatus(error instanceof Error ? error.message : 'Request failed.', 'error'); }
  finally {
    if (operation === revision) {
      busy = false;
      form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button').forEach((control) => { control.disabled = false; });
      modelSelect.disabled = modelIds.size === 0;
      document.querySelector<HTMLButtonElement>('#clearKey')!.disabled = !state.providers[provider()].hasKey;
    }
  }
}

providerSelect.addEventListener('change', () => { revision++; render(); markDirty(); });
form.addEventListener('input', markDirty);
model.addEventListener('input', () => {
  const option = Array.from(modelSelect.options).find((item) => item.value === model.value);
  if (option && modelIds.has(option.value)) modelSelect.value = option.value;
  else modelSelect.value = '';
});
modelSelect.addEventListener('change', () => { if (modelSelect.value) model.value = modelSelect.value; markDirty(); });
form.addEventListener('submit', (event) => { event.preventDefault(); void withBusy(save, 'Saving settings…'); });
document.querySelector<HTMLButtonElement>('#clearKey')!.addEventListener('click', () => {
  void withBusy(async () => {
    const selected = provider();
    await request({ type: 'provider-settings', provider: selected, clearKey: true, model: model.value.trim(), workspaceId: workspace.value.trim() });
    state.providers[selected].hasKey = false;
    key.value = '';
    render();
    saved = true;
    updateStatus('API key removed.', 'success');
  }, 'Removing API key…');
});

document.querySelector<HTMLButtonElement>('#refreshModels')!.addEventListener('click', () => {
  const selected = provider();
  void withBusy(async () => {
    const result = await request<{ models: Array<{ id: string; name: string }> }>({ type: 'provider-models', provider: selected, apiKey: key.value, workspaceId: workspace.value.trim() });
    if (provider() !== selected) return;
    modelSelect.replaceChildren(new Option('Choose a discovered model…', ''));
    modelIds = new Set();
    for (const item of result.models) {
      modelIds.add(item.id);
      modelSelect.add(new Option(`${item.name} — ${item.id}`, item.id));
    }
    modelSelect.disabled = false;
    modelSelect.value = modelIds.has(model.value) ? model.value : '';
    updateStatus(`${result.models.length} models loaded. A listed model may still be unavailable to your account.`, 'success');
  }, 'Loading models…');
});

document.querySelector<HTMLButtonElement>('#testConnection')!.addEventListener('click', () => {
  const selected = provider();
  void withBusy(async () => {
    await request({ type: 'provider-test', provider: selected, apiKey: key.value, model: model.value.trim() || DEFAULT_MODELS[selected], workspaceId: workspace.value.trim() });
    if (provider() === selected) updateStatus('Connection and structured output verified with a small billable request.', 'success');
  }, 'Testing connection…');
});

void load().catch((error: unknown) => updateStatus(error instanceof Error ? error.message : 'Could not load settings.', 'error'));
