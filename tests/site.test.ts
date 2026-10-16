import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('local publication preparation', () => {
  beforeAll(() => {
    const result = spawnSync(process.execPath, ['scripts/build-site.mjs'], { encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
  });

  it('keeps the public and bundled privacy notices identical', () => {
    expect(readFileSync('docs/privacy.html', 'utf8')).toBe(readFileSync('src/privacy.html', 'utf8'));
    expect(readFileSync('docs/privacy.css', 'utf8')).toBe(readFileSync('src/privacy.css', 'utf8'));
    expect(readFileSync('docs/privacy.html', 'utf8')).toContain('soupdiver/stretch/issues');
    expect(readFileSync('docs/privacy.html', 'utf8')).toContain('mailto:stretch@rainbowfab.org');
  });

  it('has no broken local resources or remote executable scripts', () => {
    for (const file of ['index.html', 'privacy.html']) {
      const html = readFileSync(`docs/${file}`, 'utf8');
      expect(html).not.toMatch(/<script\b/i);
      for (const match of html.matchAll(/(?:src|href)="([^"]*)"/g)) {
        const url = match[1]!;
        if (/^(https?:|mailto:|#)/.test(url)) continue;
        expect(existsSync(resolve('docs', url)), `${file}: ${url}`).toBe(true);
      }
    }
  });

  it('declares the approved MIT license', () => {
    expect(JSON.parse(readFileSync('package.json', 'utf8')).license).toBe('MIT');
    expect(readFileSync('LICENSE', 'utf8')).toContain('Copyright (c) 2026 soupdiver');
  });
});
