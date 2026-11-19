#!/usr/bin/env node
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
const assets = {};
async function collect(directory = '') {
  for (const entry of (await readdir(resolve(root, 'site', directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile() && (types[extname(path)] || entry.name === 'LICENSE')) {
      const bytes = await readFile(resolve(root, 'site', path));
      assets[`/${path}`] = { type: types[extname(path)] ?? 'text/plain; charset=utf-8', base64: bytes.toString('base64') };
    } else throw new Error(`Unshippable site asset: ${path}`);
  }
}
await collect();
const policy = await readFile(resolve(root, 'server/rpc-policy.js'), 'utf8');
const source = await readFile(resolve(root, 'worker/index.js'), 'utf8');
const importLine = "import { METHODS, SECURITY_HEADERS, MAX_BODY_BYTES, UPSTREAM_TIMEOUT_MS } from '../server/rpc-policy.js';";
if (!source.startsWith(importLine)) throw new Error('Worker import changed; update the deterministic build.');
const manifest = JSON.parse(await readFile(resolve(root, '.openai/hosting.json'), 'utf8'));
if (typeof manifest.project_id !== 'string' || !manifest.project_id.startsWith('appgprj_') || manifest.static) throw new Error('Expected Worker hosting manifest.');
await mkdir(resolve(root, 'dist/server'), { recursive: true });
await mkdir(resolve(root, 'dist/.openai'), { recursive: true });
await writeFile(resolve(root, 'dist/server/index.js'), `${policy}\n${source.slice(importLine.length)}\nconst ASSETS = ${JSON.stringify(assets)};\nexport default createWorker({ assets: ASSETS });\n`);
await writeFile(resolve(root, 'dist/.openai/hosting.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built public Worker with ${Object.keys(assets).length} original site assets.`);
