# Jarvis mail erişimi

Jarvis'in posta kutusunu okuyabilmesi için gereken kurulum.
**Canlı sunucuda çalışılıyor — her adım geri alınabilir.**

## Neden ayrı bir kimlik

Uygulamanın kendi oturum modeli IMAP parolasını oturum anahtarıyla
şifreliyor ve **anahtar yalnızca istemcide** duruyor (`auth/session.ts`).
Bu kasıtlı bir güvenlik tasarımı ve bozulmayacak. Sonucu şu: başsız bir
ajan mevcut oturum sistemini kullanamaz.

Çözüm Dovecot'un **master user** özelliği. Jarvis kendi parolasıyla
`eymen@akts.tr` kutusuna giriyor:

- Eymen'in parolası hiçbir aşamada işin içine girmiyor
- Erişim tek satırla iptal edilebiliyor
- Denetim izi ayrı: her çağrı `audit_log`'a `jarvis.*` olarak düşüyor

## Yetki sınırı

| İşlem | Durum |
|---|---|
| Okuma, arama, sayaç | ✅ |
| Gönderme | ❌ yok |
| Silme, taşıma | ❌ yok |

Uçlar: `GET /api/jarvis/ozet`, `/api/jarvis/mail/:uid`, `/api/jarvis/ara`.
Kimlik: `Authorization: Bearer <token>`. Token düz metin saklanmıyor,
`.env`'de yalnızca SHA-256 özeti var.

## Kurulum

```bash
scp scripts/jarvis-erisim-kur.sh akts:/root/
ssh -t akts /root/jarvis-erisim-kur.sh
```

Betik parolayı **sana sorar** — argüman olarak almaz, ekrana yazmaz,
kabuk geçmişine düşürmez. Sonunda bir token gösterir; **o token bir daha
gösterilmez**, hemen kopyala.

Ardından sunucuda:

```bash
nano /opt/aktas-mail/backend/.env        # JARVIS_IMAP_PASS satırını doldur
doveconf -n >/dev/null            # sözdizimi kontrolü — hata verirse DURDUR
systemctl reload dovecot
pm2 restart aktas-mail
```

## Doğrulama

```bash
curl -s -H "Authorization: Bearer <token>" https://mail.akts.tr/api/jarvis/ozet | head -c 300
```

- **200 + JSON** → kurulum tamam
- **401** → token yanlış
- **503** → `.env` eksik, servis yeniden başlatılmamış olabilir
- **500** → IMAP girişi başarısız; `JARVIS_IMAP_PASS` yanlış ya da master
  user tanımlanmamış. Kontrol: `journalctl -u dovecot -n 50`

Yetki sınırını da doğrula — bu uçların olmadığını gör:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  -H "Authorization: Bearer <token>" https://mail.akts.tr/api/jarvis/gonder
# 404 beklenir: gönderme ucu YOK
```

## Geri alma

Üç adım, hepsi bağımsız:

```bash
# 1. Dovecot yapılandırmasını geri al
cp /etc/dovecot/local.conf.yedek-<damga> /etc/dovecot/local.conf
systemctl reload dovecot

# 2. Master user'ı sil (erişimi anında keser)
> /etc/dovecot/master-users

# 3. Uygulama ayarlarını geri al
cp /opt/aktas-mail/backend/.env.yedek-<damga> /opt/aktas-mail/backend/.env
pm2 restart aktas-mail
```

Yalnızca erişimi kesmek yeterliyse **2. adım tek başına yeter** —
master-users dosyasını boşaltmak Jarvis'i anında dışarıda bırakır,
başka hiçbir şeyi etkilemez.

## Riskli noktalar

> [!warning] `doveconf -n` hata verirse devam etme
> Dovecot bozuk yapılandırmayla yeniden yüklenirse **posta alımı durur**.
> Betik yedeği aldı; hata görürsen geri al ve dur.

> [!warning] Master user tüm kutulara erişebilir
> Dovecot'ta master user tanım gereği her kutuya girebilir. Şu an tek
> kutu var (`eymen@akts.tr`), ama ileride kullanıcı eklenirse Jarvis
> onlara da erişebilir hâle gelir. O zaman `passdb` bloğuna kısıt
> eklenmeli.
