import { chromium } from 'playwright';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

await mkdir('.browser-profile', { recursive: true });
const profile = await mkdtemp(resolve('.browser-profile', 'icons-'));
const svg = await readFile('assets/logo.svg', 'utf8');
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
  });
  const page = await context.newPage();
  for (const size of [16, 32, 48, 128, 512]) {
    const data = await page.evaluate(async ({ svg, size }) => {
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.getContext('2d').drawImage(image, 0, 0, size, size);
      return canvas.toDataURL('image/png').split(',')[1];
    }, { svg, size });
    await writeFile(`assets/icon-${size}.png`, Buffer.from(data, 'base64'));
  }
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
