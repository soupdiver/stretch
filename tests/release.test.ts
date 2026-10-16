import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const zipPath = 'releases/stretch-0.1.0.zip';
function packageRelease() { return spawnSync(process.execPath, ['scripts/package-release.mjs'], { encoding: 'utf8', timeout: 10000 }); }

describe('production release invariants', () => {
  beforeAll(() => {
    const build = spawnSync(process.execPath, ['esbuild.config.mjs'], { env: { ...process.env, TEST_BUILD: '0' }, encoding: 'utf8', timeout: 10000 });
    expect(build.status, build.stderr).toBe(0);
    const release = packageRelease();
    expect(release.status, release.stderr).toBe(0);
  });

  it('packages only production files, correct manifest/icons, and a valid checksummed ZIP', () => {
    const manifest = JSON.parse(readFileSync('dist/manifest.json', 'utf8'));
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    expect(manifest.version).toBe(pkg.version);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
    expect(manifest.name).toBe('Stretch');
    expect(manifest.permissions).toEqual(['activeTab', 'storage', 'scripting', 'contextMenus']);
    expect(manifest.host_permissions).toEqual(['https://api.anthropic.com/*', 'https://api.openai.com/*', 'https://openrouter.ai/api/*']);
    expect(manifest.content_scripts).toBeUndefined();
    const files = ['manifest.json', 'LICENSE', 'background.js', 'content.js', 'options.js', 'options.html', 'options.css', 'privacy.html', 'privacy.css', 'assets/logo.svg', 'assets/icon-16.png', 'assets/icon-32.png', 'assets/icon-48.png', 'assets/icon-128.png'];
    const entries = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8', timeout: 10000 });
    expect(entries.status).toBe(0);
    expect(entries.stdout.trim().split('\n').sort()).toEqual(files.sort());
    expect(spawnSync('unzip', ['-tqq', zipPath], { timeout: 10000 }).status).toBe(0);
    for (const file of files) {
      const packaged = spawnSync('unzip', ['-p', zipPath, file], { timeout: 10000 });
      expect(packaged.status).toBe(0);
      expect(packaged.stdout.equals(readFileSync(`dist/${file}`))).toBe(true);
      if (!file.endsWith('.png')) expect(packaged.stdout.toString()).not.toMatch(/__stretchtextTest|127\.0\.0\.1|mock-.*-key|sk-ant-[\w-]+|sk-or-v1-[\da-f]+|wrkspc_[A-Za-z0-9]+/);
    }
    for (const [size, file] of Object.entries(manifest.icons)) {
      const png = readFileSync(`dist/${file}`);
      expect(png.readUInt32BE(16)).toBe(Number(size));
      expect(png.readUInt32BE(20)).toBe(Number(size));
    }
    const hash = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
    expect(readFileSync(`${zipPath}.sha256`, 'utf8')).toBe(`${hash}  stretch-0.1.0.zip\n`);
  });

  it('refuses either test-only handler hook in production', () => {
    const path = 'dist/background.js';
    const original = readFileSync(path);
    try {
      for (const hook of ['__stretchtextTestAction', '__stretchtextTestSelection']) {
        writeFileSync(path, `${original}\n${hook}`);
        const result = packageRelease();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Test-only code');
      }
    } finally { writeFileSync(path, original); }
  });

  it('refuses local test host permissions', () => {
    const path = 'dist/manifest.json';
    const original = readFileSync(path);
    try {
      const manifest = JSON.parse(original.toString());
      manifest.host_permissions.push('http://127.0.0.1/*');
      writeFileSync(path, JSON.stringify(manifest));
      const result = packageRelease();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Local test host permission');
    } finally { writeFileSync(path, original); }
  });
});
