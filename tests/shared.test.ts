import { describe, expect, it } from 'vitest';
import { validateSummaries } from '../src/shared';

describe('summary validation', () => {
  const blocks = [{ id: 'a', text: 'A complete original prose sentence with more words.' }];
  it('accepts only a shorter summary for each requested ID', () => {
    expect(validateSummaries({ summaries: [{ id: 'a', text: 'Short summary.' }] }, blocks)).toEqual([{ id: 'a', text: 'Short summary.' }]);
  });
  it('accepts unchanged blocks so the content script can leave them intact', () => {
    expect(validateSummaries({ summaries: [{ id: 'a', text: blocks[0]!.text }] }, blocks)).toEqual([{ id: 'a', text: blocks[0]!.text }]);
  });
  it.each([
    [{ summaries: [{ id: 'b', text: 'Short summary.' }] }, 'Invalid summary ID'],
    [{ summaries: [{ id: 'a', text: 'Short summary.' }, { id: 'a', text: 'Again.' }] }, 'Invalid summary ID'],
    [{ summaries: [{ id: 'a', text: `${blocks[0]!.text} extra` }] }, 'longer'],
    [{ summaries: [] }, 'omitted'],
    [{ refusal: true }, 'did not contain summaries']
  ])('rejects invalid model output', (value, message) => {
    expect(() => validateSummaries(value, blocks)).toThrow(message as string);
  });
});
