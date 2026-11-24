import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const publicFiles = readdirSync('public', { recursive: true, withFileTypes: true })
  .filter(file => file.isFile()).map(file => `${file.parentPath}/${file.name}`.replace(/^public\//, '/'));
export default defineConfig({
  build: { target: 'es2022' },
  plugins: [{
    name: 'sot-offline',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const cache = createHash('sha256');
        const resources = ['/', ...Object.keys(bundle).filter(name => name !== 'index.html').map(name => `/${name}`), ...publicFiles].sort();
        for (const item of Object.values(bundle)) cache.update(item.type === 'asset' ? item.source : item.code);
        for (const name of publicFiles.sort()) cache.update(readFileSync(`public${name}`));
        this.emitFile({ type: 'asset', fileName: 'sw.js', source: `
const KEY = ${JSON.stringify('sot-' + cache.digest('hex').slice(0, 20))};
const resources = ${JSON.stringify(resources)};
const paths = new Set(resources);
self.addEventListener('install', event => event.waitUntil(caches.open(KEY).then(cache => cache.addAll(resources)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== KEY && key.startsWith('sot-')).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !paths.has(url.pathname)) return;
  event.respondWith(caches.open(KEY).then(cache => cache.match(url.pathname)).then(response => response || fetch(event.request)));
});
` });
      },
    },
  }],
});
