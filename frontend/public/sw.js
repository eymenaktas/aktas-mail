/**
 * Aktaş Mail — service worker.
 *
 * TEK İŞİ: uygulama kabuğunu (HTML/JS/CSS) önbelleğe alıp çevrimdışı
 * açılabilmesini sağlamak.
 *
 * POSTA İÇERİĞİ ASLA ÖNBELLEĞE ALINMAZ. `/api/` altındaki hiçbir cevap
 * saklanmıyor: mail gövdeleri, adresler ve oturum bilgileri cihazda
 * kalıcı bir kopya bırakmamalı. Telefon kaybolursa tarayıcı önbelleğinden
 * posta okunabilmesi kabul edilemez.
 */
const CACHE = "aktas-mail-kabuk-v1";
const KABUK = ["/", "/icon-192.png", "/icon-512.png", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(KABUK)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((adlar) => Promise.all(adlar.filter((a) => a !== CACHE).map((a) => caches.delete(a))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // API: dokunma. Önbellek yok, kopya yok.
  if (url.pathname.startsWith("/api/")) return;
  if (e.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  // Hash'li build dosyaları değişmez → önbellekten
  if (url.pathname.startsWith("/assets/")) {
    e.respondWith(
      caches.match(e.request).then(
        (v) =>
          v ??
          fetch(e.request).then((r) => {
            const kopya = r.clone();
            caches.open(CACHE).then((c) => c.put(e.request, kopya));
            return r;
          }),
      ),
    );
    return;
  }

  // Gezinme: önce ağ, olmazsa önbellekteki kabuk (çevrimdışı açılış)
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match("/")));
  }
});
