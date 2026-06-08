// ─────────────────────────────────────────────────────────────────────────────
// sw.js — Service Worker para Iteratio PWA
// Estrategia: Cache-first para assets estáticos, Network-first para el resto.
// Incrementa CACHE_VERSION cada vez que despliegues cambios.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_NAME    = 'iteratio-v6';
const CACHE_VERSION = 6;

// Assets que se pre-cachean al instalar el SW (app shell completo).
// IMPORTANTE: script.js se excluye del precache para que siempre se
// sirva la versión más reciente de Netlify y nunca una copia corrupta.
const PRECACHE_URLS = [
  '/index.html',
  '/styles.css',
  '/manifest.json',
  '/logo-iteratio.svg',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png'
];

// ── Instalación ───────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())   // toma control sin esperar cierre de pestañas
  );
});

// ── Activación ────────────────────────────────────────────────────────────────
// Elimina TODOS los cachés anteriores (cineteca-v1, iteratio-v1, etc.)
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Eliminando caché antigua:', key);
            return caches.delete(key);
          })
      ))
      .then(() => self.clients.claim())  // toma control de todos los clientes abiertos
  );
});

// ── Mensaje desde el cliente ──────────────────────────────────────────────────
// Permite forzar la activación inmediata desde el script de registro
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
// Cache-first para el app shell; Network-first para el resto.
// Las APIs externas y dinámicas NUNCA se cachean.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Ignorar peticiones no-GET
  if (event.request.method !== 'GET') return;

  // script.js siempre desde la red — nunca desde caché.
  // Esto evita servir versiones corruptas o antiguas del código JS principal.
  if (url.pathname === '/script.js') return;

  // Nunca interceptar recursos externos o dinámicos
  if (url.hostname.includes('supabase.co'))           return;  // API dinámica
  if (url.hostname.includes('drive.google.com'))      return;  // videos
  if (url.hostname.includes('docs.google.com'))       return;
  if (url.hostname.includes('fonts.googleapis.com'))  return;
  if (url.hostname.includes('fonts.gstatic.com'))     return;
  if (url.hostname.includes('images.unsplash.com'))   return;

  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) return cached;  // Cache-first: devolver si existe

        return fetch(event.request)
          .then(response => {
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }
            const responseToCache = response.clone();
            caches.open(CACHE_NAME)
              .then(cache => cache.put(event.request, responseToCache));
            return response;
          })
          .catch(() => {
            // Fallback offline: devolver index.html para navegación
            if (event.request.destination === 'document') {
              return caches.match('/index.html');
            }
          });
      })
  );
});