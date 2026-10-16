import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const fixture = resolve('tests/fixtures/article.html');
createServer(async (_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(await readFile(fixture));
}).listen(4173, '127.0.0.1');
