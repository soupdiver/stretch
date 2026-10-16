export const DEFAULT_MODEL = 'claude-haiku-4-5';
export const MAX_BLOCKS = 12;
export const MAX_TEXT_LENGTH = 2400;
export const MAX_BATCH_CHARS = 6000;
export const MAX_TOTAL_BLOCKS = 120;
export const MAX_TOTAL_CHARS = 48000;

export interface TextBlock {
  id: string;
  text: string;
}

export interface Summary {
  id: string;
  text: string;
}

export function validateSummaries(value: unknown, requested: TextBlock[]): Summary[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { summaries?: unknown }).summaries)) {
    throw new Error('The model response did not contain summaries.');
  }
  const originals = new Map(requested.map((block) => [block.id, block.text]));
  const seen = new Set<string>();
  const result: Summary[] = [];
  for (const item of (value as { summaries: unknown[] }).summaries) {
    if (!item || typeof item !== 'object') throw new Error('Invalid summary item.');
    const { id, text } = item as { id?: unknown; text?: unknown };
    if (typeof id !== 'string' || !originals.has(id) || seen.has(id) || typeof text !== 'string') throw new Error('Invalid summary ID or text.');
    seen.add(id);
    const original = originals.get(id)!;
    if (!text.trim() || text.length > MAX_TEXT_LENGTH || text.length > original.length) throw new Error('Summary was empty, too long, or longer than its source.');
    result.push({ id, text });
  }
  if (seen.size !== requested.length) throw new Error('The model omitted one or more summaries.');
  return result;
}
