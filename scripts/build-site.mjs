import { cp, mkdir } from 'node:fs/promises';

// Generate shared policy and artwork locally. Deployment is a separate, explicit action.
await mkdir('docs/assets', { recursive: true });
await cp('src/privacy.html', 'docs/privacy.html');
await cp('src/privacy.css', 'docs/privacy.css');
await cp('assets/logo.svg', 'docs/assets/logo.svg');
console.log('Prepared docs/ for static hosting. Nothing was deployed.');
