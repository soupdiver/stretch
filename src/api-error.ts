export async function apiError(response: Response, apiKey: string): Promise<Error> {
  let detail = '';
  try {
    const body: unknown = JSON.parse(await response.text());
    if (body && typeof body === 'object' && 'error' in body) {
      const error = body.error;
      if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
        detail = error.message;
      }
    }
  } catch { /* Empty or non-JSON error bodies contain no trusted provider message. */ }

  if (apiKey) detail = detail.split(apiKey).join('[redacted]');
  detail = detail.replace(/sk-ant-[\w-]+/g, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, 600);
  const reason = detail || 'No error detail was returned. Check the configured model and Anthropic API billing/credits.';
  return new Error(`Anthropic request failed (${response.status}): ${reason}`);
}
