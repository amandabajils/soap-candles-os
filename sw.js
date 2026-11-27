// Service worker mínimo para que el OS se pueda instalar como app.
// No guarda nada en caché: todas las peticiones van a la red, así los datos siempre son los actuales.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
