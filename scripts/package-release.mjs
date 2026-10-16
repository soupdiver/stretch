import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (manifest.name !== 'Stretch' || manifest.version !== pkg.version) throw new Error('Release name/version mismatch.');
const versionParts = typeof manifest.version === 'string' ? manifest.version.split('.') : [];
if (!versionParts.length || versionParts.length > 4 || !versionParts.every((part) => /^(0|[1-9]\d*)$/.test(part) && Number(part) <= 65535) || !versionParts.some((part) => Number(part) > 0)) throw new Error('Invalid numeric extension version.');
if (manifest.host_permissions.some((host) => host.includes('127.0.0.1') || host.includes('localhost'))) throw new Error('Local test host permission found.');
const files = ['manifest.json', 'LICENSE', 'background.js', 'content.js', 'options.js', 'options.html', 'options.css', 'privacy.html', 'privacy.css', 'assets/logo.svg', ...Object.keys(manifest.icons).map((size) => manifest.icons[size])];
for (const path of files) await readFile(`dist/${path}`);
const background = await readFile('dist/background.js', 'utf8');
if (/__stretchtextTest(?:Action|Selection)/.test(background) || background.includes('127.0.0.1')) throw new Error('Test-only code found in production build.');
for (const path of files.filter((name) => name.endsWith('.png'))) {
  const png = await readFile(`dist/${path}`);
  const size = Number(path.match(/icon-(\d+)/)?.[1]);
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) throw new Error(`Invalid icon PNG: ${path}`);
}
await mkdir('releases', { recursive: true });
const zipPath = `releases/stretch-${manifest.version}.zip`;
const zip = spawnSync('zip', ['-q', resolve(zipPath), ...files], { cwd: 'dist', encoding: 'utf8' });
if (zip.status !== 0) throw new Error(zip.stderr || 'zip command failed.');
const hash = createHash('sha256').update(await readFile(zipPath)).digest('hex');
await writeFile(`${zipPath}.sha256`, `${hash}  stretch-${manifest.version}.zip\n`);
const listing = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
const entries = listing.stdout.trim().split('\n').sort();
if (listing.status !== 0 || entries.join('\n') !== [...files].sort().join('\n')) throw new Error('ZIP entry set differs from the release allowlist.');
const integrity = spawnSync('unzip', ['-tqq', zipPath], { encoding: 'utf8' });
if (integrity.status !== 0) throw new Error(integrity.stdout || integrity.stderr || 'ZIP integrity check failed.');
console.log(`Created ${zipPath}\nSHA256 ${hash}`);
