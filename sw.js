// Service worker: guarda a casca do app para abrir rápido e instalar no celular.
// Rede primeiro, cache como reserva — assim uma versão nova nunca fica presa.
const CACHE = "fluencia-v2";
const CASCA = ["./", "index.html", "css/styles.css", "js/app.js", "js/firebase.js", "js/ia.js",
  "js/ia-pedidos.js", "js/selecao.js", "js/voz.js", "manifest.webmanifest", "assets/icone.svg", "assets/icone-192.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CASCA)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // Só a casca do próprio site; banco, login e IA vão direto para a rede.
  if(e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(r => { const copia = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copia)); return r; })
      .catch(() => caches.match(e.request))
  );
});
