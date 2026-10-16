import { afterEach, describe, expect, it, vi } from 'vitest';
import { complete, DEFAULT_MODELS, listModels, normalizeSettings, type Provider } from '../src/providers';

const block = [{ id: 'one', text: 'A sufficiently complete sentence that needs a shorter summary for this test.' }];
const summaries = JSON.stringify({ summaries: [{ id: 'one', text: 'A short sentence.' }] });
const response = (provider: Provider) => provider === 'anthropic'
  ? { content: [{ type: 'text', text: summaries }], stop_reason: 'end_turn' }
  : provider === 'openai'
    ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: summaries }] }] }
    : { choices: [{ finish_reason: 'stop', message: { content: summaries } }] };

afterEach(() => vi.unstubAllGlobals());

describe('provider adapters', () => {
  it.each(['anthropic', 'openai', 'openrouter'] as Provider[])('sends structured requests to fixed %s endpoints', async (provider) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response(provider)), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(complete(provider, { apiKey: 'provider-secret', model: DEFAULT_MODELS[provider], workspaceId: 'wrkspc_test' }, block, new AbortController().signal)).resolves.toEqual([{ id: 'one', text: 'A short sentence.' }]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe(provider === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : provider === 'openai' ? 'https://api.openai.com/v1/responses' : 'https://openrouter.ai/api/v1/chat/completions');
    expect(String(init.body)).not.toContain('wrkspc_test');
    expect(String(init.body)).not.toContain('provider-secret');
    if (provider === 'anthropic') {
      expect(headers['x-api-key']).toBe('provider-secret');
      expect(headers['anthropic-workspace-id']).toBe('wrkspc_test');
      expect(JSON.parse(String(init.body))).toHaveProperty('output_config.format.type', 'json_schema');
    } else {
      expect(headers.authorization).toBe('Bearer provider-secret');
      expect(headers['anthropic-workspace-id']).toBeUndefined();
      const body = JSON.parse(String(init.body));
      if (provider === 'openai') expect(body).toHaveProperty('text.format.type', 'json_schema');
      else {
        expect(body).toHaveProperty('response_format.type', 'json_schema');
        expect(body.provider.require_parameters).toBe(true);
      }
    }
  });

  it('migrates only the legacy Anthropic profile and preserves its model', () => {
    expect(normalizeSettings({ apiKey: 'legacy-key', model: 'claude-custom', workspaceId: 'wrkspc_legacy' })).toEqual({
      selectedProvider: 'anthropic', providers: {
        anthropic: { apiKey: 'legacy-key', model: 'claude-custom', workspaceId: 'wrkspc_legacy' }, openai: {}, openrouter: {}
      }
    });
  });

  it('limits Anthropic discovery pagination and carries the optional workspace', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'a', display_name: 'A' }], has_more: true, last_id: 'a' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'b' }], has_more: false }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listModels('anthropic', { apiKey: 'a-key', workspaceId: 'wrkspc_test' })).resolves.toEqual([{ id: 'a', name: 'A' }, { id: 'b', name: 'b' }]);
    expect(fetchMock.mock.calls[1]?.[0]).toContain('after_id=a');
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toHaveProperty('anthropic-workspace-id', 'wrkspc_test');
  });

  it('bounds OpenRouter model discovery with explicit offset pagination', async () => {
    const page = (start: number) => Array.from({ length: 100 }, (_, index) => ({ id: `model-${start + index}`, name: `Model ${start + index}` }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: page(0) }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'model-100', name: 'Model 100' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const models = await listModels('openrouter', { apiKey: 'or-key' });
    expect(models).toHaveLength(101);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://openrouter.ai/api/v1/models?limit=100&offset=0&output_modalities=text',
      'https://openrouter.ai/api/v1/models?limit=100&offset=100&output_modalities=text'
    ]);
  });

  it('rejects malformed, truncated, unknown and refused output without fallback', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: summaries } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: summaries } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{bad' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(complete('openrouter', { apiKey: 'or-key', model: 'unavailable/model' }, block, new AbortController().signal)).rejects.toThrow('truncated');
    await expect(complete('openrouter', { apiKey: 'or-key', model: 'unavailable/model' }, block, new AbortController().signal)).rejects.toThrow('invalid JSON');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(['anthropic', 'openai', 'openrouter'] as Provider[])('recovers a truncated %s single block with a larger budget', async (provider) => {
    const truncated = provider === 'anthropic' ? { stop_reason: 'max_tokens' }
      : provider === 'openai' ? { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
        : { choices: [{ finish_reason: 'length' }] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(truncated), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(response(provider)), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(complete(provider, { apiKey: 'secret', model: DEFAULT_MODELS[provider] }, block, new AbortController().signal)).resolves.toHaveLength(1);
    const first = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    const second = JSON.parse(String(fetchMock.mock.calls[1]![1].body));
    const budget = provider === 'openai' ? 'max_output_tokens' : 'max_tokens';
    expect(first[budget]).toBeGreaterThan(4096);
    expect(second[budget]).toBeGreaterThan(first[budget]);
    expect(second[budget]).toBeLessThanOrEqual(16384);
    expect(second.model).toBe(first.model);
    expect(fetchMock.mock.calls[1]![0]).toBe(fetchMock.mock.calls[0]![0]);
  });

  it('splits a truncated batch into two bounded recovery requests', async () => {
    const blocks = [...block, { ...block[0]!, id: 'two' }];
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      if (fetchMock.mock.calls.length === 1) return new Response(JSON.stringify({ stop_reason: 'max_tokens' }));
      const sent = JSON.parse(JSON.parse(init.body).messages[0].content).blocks;
      return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ summaries: sent.map((item: { id: string }) => ({ id: item.id, text: 'Short.' })) }) }] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(complete('anthropic', { apiKey: 'secret', model: DEFAULT_MODELS.anthropic }, blocks, new AbortController().signal)).resolves.toEqual([{ id: 'one', text: 'Short.' }, { id: 'two', text: 'Short.' }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry incomplete responses caused by a non-token limit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(complete('openai', { apiKey: 'secret', model: DEFAULT_MODELS.openai }, block, new AbortController().signal)).rejects.toThrow('incomplete');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('redacts the configured key from provider error details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Invalid key secret-value' } }), { status: 401 })));
    await expect(listModels('openai', { apiKey: 'secret-value' })).rejects.toThrow('redacted');
  });
});
