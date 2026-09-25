# Durum — aktas-mail

Güncelleme: 2026-09-25 08:30 | Son araç: claude

## Hedef

Telefonda "beni hatırla", aynı tarayıcıda çoklu hesap + geçiş, hızlı
çıkışların giderilmesi. **Canlıda, ama commit'lenmedi** (main'de, kirli ağaç).

## Yapıldı

- [x] Kök neden: oturum çerezlerinde `maxAge` yoktu → tarayıcı/uygulama
      kapanınca çerez siliniyordu. DB'deki oturumlar 30 gün geçerliydi,
      hiçbiri iptal edilmemişti (2026-09-25 sorgusu).
- [x] `sessions.remember` sütunu (`backend/sql/2026-09-25-beni-hatirla.sql`,
      canlı DB'ye uygulandı). Hatırlananlar kalıcı çerez + `/api/auth/me`'de
      kayan 30 gün (`extendSessions`).
- [x] Çoklu hesap: etkin hesap `am_session`'da, diğerleri `am_hesaplar`
      çerezinde (`routes/auth.ts`: `oturumuYerlestir`, `/api/auth/switch`,
      logout `{tumu}`; `/me` `hesaplar` döner). Arayüz: kenar çubuğunda
      hesap listesi, "Hesap ekle", "Tümünden çık".
- [x] "Tümünü okundu işaretle" artık klasörün okunmamış sayısına bakıyor;
      bildirim deneme düğmeleri herkese açık.
- [x] Canlıya çıktı; yedek `/root/aktas-mail-yedek-2026-09-25.tgz`.

## Sıradaki adım

Eymen onaylarsa commit + push (main'de: önce dal aç). Canlı, HEAD'in önünde —
HEAD'den derleyip atma, bu değişiklikler geri gider.

## Bilinen tuzaklar

- Dağıtım elle: yerelde `npm run build` (backend) + `npx vite build` (frontend),
  `rsync -rc` ile `/opt/aktas-mail/{backend,frontend}/dist/`, sonra
  `chown -R aktasmail:aktasmail backend/dist` ve `pm2 restart aktas-mail`.
  macOS rsync'i `--chown` tanımıyor. `pm2 update` çalıştırma.
- Sunucudaki `/opt/aktas-mail` git geçmişi eski (force-push öncesi SHA'lar);
  oradaki git'e güvenme, dist'i karşılaştır (`rsync -rcn`).
- Yerel `.env` canlı DB'ye tünelle bağlanıyor. Test verisi için geçici PGlite
  (`@electric-sql/pglite-socket`) + `pg_dump -s` şeması kullanıldı.
- Browser pane ekran görüntüsü bir tur geride kalabiliyor; DOM'u JS ile ölç.
