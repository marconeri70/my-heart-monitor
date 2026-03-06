const CACHE_NAME = 'heart-monitor-v1';

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll([
                '/my-heart-monitor/',
                '/my-heart-monitor/index.html',
                '/my-heart-monitor/icona.png',
                '/my-heart-monitor/manifest.json'
            ]);
        })
    );
});

self.addEventListener('fetch', (event) => {
    event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request))
    );
});
