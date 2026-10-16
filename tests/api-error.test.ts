import { describe, expect, it } from 'vitest';
import { apiError } from '../src/api-error';

describe('Anthropic rejection details', () => {
  it('reads the response body and preserves the actual 400 reason', async () => {
    const response = new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }), { status: 400 });
    const error = await apiError(response, 'test-key');
    expect(response.bodyUsed).toBe(true);
    expect(error.message).toContain('400');
    expect(error.message).toContain('Your credit balance is too low');
  });

  it('redacts the configured key and other Anthropic keys', async () => {
    const response = new Response(JSON.stringify({ error: { message: 'Invalid key test-secret or sk-ant-another-secret' } }), { status: 401 });
    const error = await apiError(response, 'test-secret');
    expect(error.message).not.toContain('test-secret');
    expect(error.message).not.toContain('sk-ant-');
  });

  it.each(['', '<html>proxy failure</html>', '{broken', '{"error":null}'])('handles empty or invalid error bodies without hiding the status', async (body) => {
    const error = await apiError(new Response(body, { status: 400 }), 'test-key');
    expect(error.message).toContain('400');
    expect(error.message).toContain('No error detail was returned');
    expect(error.message).not.toContain('<html>');
  });
});
