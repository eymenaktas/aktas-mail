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

/* ── Web push ──────────────────────────────────────────────
   Bildirim, mail teslim edildiği ANDA Dovecot tarafından tetikleniyor
   (yoklama yok, gecikme yok). Yükte yalnızca gönderen ve konu var —
   gövde gönderilmiyor, kilit ekranında tüm mail görünmesin diye. */

self.addEventListener("push", (event) => {
  let veri = { baslik: "Aktaş Mail", govde: "Yeni mail", url: "/" };
  try {
    if (event.data) veri = { ...veri, ...event.data.json() };
  } catch {
    // Bozuk yük gelirse varsayılanla göster; bildirimi hiç göstermemek
    // "yeni mail var" bilgisini tamamen kaybettirir.
  }

  event.waitUntil(
    self.registration.showNotification(veri.baslik, {
      body: veri.govde,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // Aynı etiket: arka arkaya gelen mailler bildirimi yığmıyor,
      // sonuncusu öncekinin yerini alıyor.
      tag: "aktas-mail",
      renotify: true,
      data: { url: veri.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const hedef = (event.notification.data && event.notification.data.url) || "/";

  // Uygulama zaten açıksa yeni sekme açma, o pencereye odaklan.
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((pencereler) => {
      for (const p of pencereler) {
        if (p.url.includes(self.location.origin) && "focus" in p) return p.focus();
      }
      return self.clients.openWindow(hedef);
    }),
  );
});
