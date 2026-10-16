import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/background.ts'], bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', minify: process.env.TEST_BUILD !== '1', define: { __TEST_BUILD__: process.env.TEST_BUILD === '1' ? 'true' : 'false' }, outfile: 'dist/background.js' });
await build({ entryPoints: ['src/content.ts'], bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', outfile: 'dist/content.js' });
await build({ entryPoints: ['src/options.ts'], bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', outfile: 'dist/options.js' });
await cp('manifest.json', 'dist/manifest.json');
await cp('LICENSE', 'dist/LICENSE');
await cp('assets', 'dist/assets', { recursive: true });
if (process.env.TEST_BUILD === '1') {
  const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
  manifest.host_permissions.push('http://127.0.0.1/*');
  await writeFile('dist/manifest.json', JSON.stringify(manifest, null, 2));
}
await cp('src/options.html', 'dist/options.html');
await cp('src/options.css', 'dist/options.css');
await cp('src/privacy.html', 'dist/privacy.html');
await cp('src/privacy.css', 'dist/privacy.css');
