/* Noon FM service worker: offline shell, background sync, reminders, push */
const V = 'fm-v1';
const CORE = ['./', './index.html', './manifest.webmanifest', './auth.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];
const XLSX = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
const FONTS = 'https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&family=Cairo:wght@400;600;700&display=swap';

/* ---------- tiny IndexedDB key/value (shared with the page) ---------- */
function idb() {
  return new Promise((res, rej) => {
    const q = indexedDB.open('fm-sync', 1);
    q.onupgradeneeded = () => q.result.createObjectStore('kv');
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
async function idbGet(k) {
  const d = await idb();
  return new Promise(r => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => r(q.result); q.onerror = () => r(null); });
}
async function idbSet(k, v) {
  const d = await idb();
  return new Promise(r => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => r(); t.onerror = () => r(); });
}

/* ---------- install: precache shell + CDN lib + fonts ---------- */
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(V);
    await Promise.all(CORE.map(u => c.add(u).catch(() => {})));
    try { await c.put(XLSX, await fetch(new Request(XLSX, { mode: 'no-cors' }))); } catch (_) {}
    try {
      const css = await fetch(FONTS);
      const txt = await css.clone().text();
      await c.put(FONTS, css);
      const urls = [...new Set((txt.match(/https:\/\/fonts\.gstatic\.com[^)'"\s]+/g) || []))];
      await Promise.all(urls.map(async u => { try { await c.put(u, await fetch(u)); } catch (_) {} }));
    } catch (_) {}
    self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== V) await caches.delete(k);
    await self.clients.claim();
  })());
});

/* ---------- fetch strategies ---------- */
async function navigate(req) {
  const c = await caches.open(V);
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 3500);
    const r = await fetch(req, { signal: ctl.signal }); clearTimeout(t);
    if (r.ok) c.put('./index.html', r.clone());
    return r;
  } catch (_) {
    return (await c.match('./index.html')) || (await c.match('./')) || new Response('Offline', { status: 503 });
  }
}
async function swr(req) {
  const c = await caches.open(V);
  const hit = await c.match(req, { ignoreSearch: true });
  const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
  return hit || (await net) || new Response('', { status: 504 });
}
async function cacheFirst(req) {
  const c = await caches.open(V);
  const hit = await c.match(req);
  if (hit) return hit;
  try { const r = await fetch(req); c.put(req, r.clone()); return r; } catch (_) { return new Response('', { status: 504 }); }
}
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (r.mode === 'navigate') return e.respondWith(navigate(r));
  if (u.origin === location.origin) return e.respondWith(swr(r));
  if (/(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com)$/.test(u.host)) e.respondWith(cacheFirst(r));
});

/* ---------- background sync: send the outbox when the connection is back ---------- */
async function flush() {
  const o = await idbGet('outbox');
  if (!o || !o.url || !o.entries || !o.entries.length) return;
  const res = await fetch(o.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ device: o.device, user: o.user, role: o.role, sentAt: Date.now(), entries: o.entries }) });
  if (!res.ok) throw new Error('sync ' + res.status);
  const keys = {}; o.entries.forEach(x => keys[x.store] = x.ts);
  const prev = (await idbGet('synced')) || {}; Object.assign(prev, keys); await idbSet('synced', prev);
  const cur = await idbGet('outbox');
  if (cur) { cur.entries = cur.entries.filter(x => !(keys[x.store] >= x.ts)); await idbSet('outbox', cur); }
  const cs = await self.clients.matchAll({ includeUncontrolled: true });
  cs.forEach(c => c.postMessage({ type: 'synced', keys }));
  if (!cs.some(c => c.visibilityState === 'visible')) {
    const n = o.entries.length;
    await self.registration.showNotification('Noon FM', {
      body: 'تم تسجيل ' + n + ' تحديث بعد رجوع النت', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'synced', dir: 'auto', data: { url: './' } });
  }
}
self.addEventListener('sync', e => { if (e.tag === 'fm-sync') e.waitUntil(flush()); });

/* ---------- periodic reminders (installed app, Chromium) ---------- */
self.addEventListener('periodicsync', e => {
  if (e.tag !== 'fm-remind') return;
  e.waitUntil((async () => {
    const list = (await idbGet('reminders')) || [], last = (await idbGet('ntlast')) || {};
    for (const r of list) {
      if (last[r.tag] && Date.now() - last[r.tag] < 216e5) continue;
      last[r.tag] = Date.now();
      await self.registration.showNotification(r.title, { body: r.body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: r.tag, dir: 'auto', data: { url: './' } });
    }
    await idbSet('ntlast', last);
  })());
});

/* ---------- web push (needs a server that sends pushes) + clicks ---------- */
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Noon FM', {
    body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: d.tag, dir: 'auto', data: { url: d.url || './' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  })());
});
