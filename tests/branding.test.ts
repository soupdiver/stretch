import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Stretch branding', () => {
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));

  it('ships correctly sized PNG toolbar and extension icons', () => {
    expect(manifest.name).toBe('Stretch');
    const entries = { ...manifest.icons, ...manifest.action.default_icon };
    for (const [size, path] of Object.entries(entries)) {
      const png = readFileSync(path as string);
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(png.readUInt32BE(16)).toBe(Number(size));
      expect(png.readUInt32BE(20)).toBe(Number(size));
    }
  });

  it('provides two 1280×800 listing screenshots', () => {
    for (const name of ['screenshot-reading.png', 'screenshot-settings.png']) {
      const png = readFileSync(`store/assets/${name}`);
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(png.readUInt32BE(16)).toBe(1280);
      expect(png.readUInt32BE(20)).toBe(800);
    }
  });
});
