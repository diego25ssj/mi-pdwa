const CACHE_STATIC_NAME = 'pitwall-static-v4';
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './dato.json',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png'
];
const SYNC_TAG = 'pitwall-message-sync';
const MESSAGE_DB_NAME = 'pitwall-messages';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_STATIC_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith('pitwall-static-') && key !== CACHE_STATIC_NAME)
        .map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      return await fetch(request);
    } catch (error) {
      if (request.mode === 'navigate') {
        const fallback = await caches.match('./index.html');
        if (fallback) return fallback;
      }
      throw error;
    }
  })());
});

function openMessageDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MESSAGE_DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('messages', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readPendingMessages(db) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('messages', 'readonly');
    const request = transaction.objectStore('messages').getAll();
    request.onsuccess = () => resolve(request.result.filter((message) => message.status !== 'sent'));
    request.onerror = () => reject(request.error);
  });
}

function saveMessage(db, message) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('messages', 'readwrite');
    transaction.objectStore('messages').put(message);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function notifyClients(type, message) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  windows.forEach((client) => client.postMessage({ type, message }));
}

async function syncPendingMessages() {
  const db = await openMessageDB();
  try {
    if (!self.navigator.onLine) throw new Error('El dispositivo sigue sin conexión.');
    const pending = await readPendingMessages(db);

    for (const message of pending) {
      await saveMessage(db, { ...message, status: 'sent' });
    }

    await notifyClients('SYNC_COMPLETE', pending.length ? 'Mensajes sincronizados en este dispositivo.' : 'No hay mensajes pendientes.');
    if (pending.length && Notification.permission === 'granted') {
      await self.registration.showNotification('Pitwall · sincronización', {
        body: `${pending.length} mensaje(s) sincronizado(s) en este dispositivo.`,
        icon: './icon.svg',
        badge: './icon.svg',
        tag: 'pitwall-sync'
      });
    }
  } finally {
    db.close();
  }
}

self.addEventListener('sync', (event) => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(syncPendingMessages().catch(async (error) => {
      console.warn('La sincronización queda pendiente:', error);
      await notifyClients('SYNC_FAILED', 'El servidor no respondió; se volverá a intentar.');
      throw error;
    }));
  }
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'MESSAGE_QUEUED') {
    const teamName = String(event.data.teamName || 'tu equipo');
    const body = String(event.data.body || 'Tu mensaje quedó guardado.');
    event.waitUntil(self.registration.showNotification(`Mensaje para ${teamName}`, {
      body: `${body.slice(0, 100)}${body.length > 100 ? '…' : ''} · Guardado en este dispositivo.`,
      icon: './icon.svg',
      badge: './icon.svg',
      tag: `pitwall-message-${String(event.data.id || Date.now())}`,
      data: { url: './' }
    }));
  }

  if (event.data?.type === 'SYNC_MESSAGES') {
    event.waitUntil(syncPendingMessages().catch(async (error) => {
      console.warn('No se pudieron sincronizar los mensajes:', error);
      await notifyClients('SYNC_FAILED', 'El servidor no respondió; se volverá a intentar.');
      if ('sync' in self.registration) {
        try {
          await self.registration.sync.register(SYNC_TAG);
        } catch (registrationError) {
          console.warn('No se pudo programar el reintento de sincronización:', registrationError);
        }
      }
    }));
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch { data = { body: event.data?.text() || '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Pitwall · Fórmula 1', {
    body: data.body || 'Hay una nueva actualización del paddock.',
    icon: data.icon || './icon.svg',
    badge: './icon.svg',
    data: { url: data.url || './' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const destination = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((client) => client.url.startsWith(self.registration.scope));
    return existing ? existing.focus() : self.clients.openWindow(destination);
  }));
});