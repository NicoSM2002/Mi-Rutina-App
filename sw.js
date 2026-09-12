const CACHE = 'rutina-v4-r1';

/* El index.html se pide siempre con mode:'navigate', y la versión anterior
   solo guardaba lo que NO fuera navigate — así que nunca llegaba al caché y
   el fallback offline apuntaba a un recurso inexistente: sin señal, la app
   no abría. Ahora se precarga en la instalación y se refresca en cada visita
   con red, que es lo que hace falta en un gimnasio en sótano. */
const FILES = ['./', './index.html', './manifest.json', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      // Si alguno falla (un icono que no está), no debe tumbar la instalación
      Promise.allSettled(FILES.map(f => c.add(f)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // La app: red primero (para traer el código nuevo), pero guardando una
  // copia cada vez, de modo que siempre haya una versión que servir sin red.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copia = res.clone();
            caches.open(CACHE).then(c => c.put('./index.html', copia));
          }
          return res;
        })
        .catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // El resto: del caché al instante y refresco en segundo plano.
  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(req).then(cached => {
        const red = fetch(req).then(res => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(() => cached);
        return cached || red;
      })
    )
  );
});
