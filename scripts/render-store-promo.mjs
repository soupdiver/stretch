import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('store/assets', { recursive: true });
const logo = await readFile('assets/logo.svg', 'utf8');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 440, height: 280 }, deviceScaleFactor: 1 });
  const png = await page.evaluate(async (svg) => {
    const image = new Image(); image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 440; canvas.height = 280;
    const ctx = canvas.getContext('2d');
    const bg = ctx.createLinearGradient(0, 0, 440, 280); bg.addColorStop(0, '#101b19'); bg.addColorStop(1, '#263b31'); ctx.fillStyle = bg; ctx.fillRect(0, 0, 440, 280);
    ctx.globalAlpha = .09; ctx.strokeStyle = '#a9e6b5';
    for (let x = 0; x < 440; x += 24) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 280); ctx.stroke(); }
    for (let y = 0; y < 280; y += 24) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(440, y); ctx.stroke(); }
    ctx.globalAlpha = 1; ctx.drawImage(image, 32, 42, 72, 72);
    ctx.fillStyle = '#d9f3df'; ctx.font = '700 38px system-ui'; ctx.fillText('STRETCH', 126, 88);
    ctx.fillStyle = '#a9e6b5'; ctx.font = '500 18px system-ui'; ctx.fillText('LESS NOISE. SAME SIGNAL.', 128, 119);
    ctx.fillStyle = '#f5f7f1'; ctx.font = '500 21px system-ui'; ctx.fillText('Shorten the passage.', 32, 190); ctx.fillText('Keep the original.', 32, 221);
    ctx.fillStyle = '#91a99a'; ctx.font = '13px system-ui'; ctx.fillText('YOUR TEXT. YOUR PROVIDER. YOUR CHOICE.', 32, 255);
    return canvas.toDataURL('image/png').split(',')[1];
  }, logo);
  await writeFile('store/assets/promo-440x280.png', Buffer.from(png, 'base64'));
} finally { await browser.close(); }
