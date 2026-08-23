# Aktaş Mail

`mail.akts.tr` üzerinde çalışan, kendi sunucusunda barınan e-posta uygulaması.
Gmail benzeri arayüz, passkey ile parolasız giriş, anlık bildirim ve Türkçe
spam sınıflandırma. **Web + Android (Capacitor).**

[![canlı](https://img.shields.io/badge/mail.akts.tr-canlı-1a73e8?style=flat-square)](https://mail.akts.tr)
![test](https://img.shields.io/badge/test-71%20geçiyor-2ea043?style=flat-square)
![lisans](https://img.shields.io/badge/lisans-MIT-blue?style=flat-square)

## Neden ilginç

### Uygulama IMAP parolanı saklamıyor

Girişte rastgele bir **oturum anahtarı** üretiliyor; posta parolası onunla
şifrelenip veritabanına yazılıyor ve anahtar yalnızca istemciye gidiyor
(`httpOnly` çerez). Sunucu her istekte anahtarı alıyor, kullanıyor, atıyor.
Veritabanı tek başına çalınırsa posta parolası çözülemiyor.

Bunun mimari bir bedeli var ve her şeyi şekillendirdi: **sunucu, kullanıcı
istekte bulunmadan posta kutusuna bakamıyor.** Arka planda yoklama yapısal
olarak imkânsız.

### Bildirimler teslimat tarafından tetikleniyor

Yoklama mümkün olmadığı için bildirim zinciri şöyle:

```
Postfix/Dovecot teslim eder
   → maildir-izleyici (inotify) yeni dosyayı yakalar
   → yalnızca From/Subject okur, yerel kancaya POST atar
   → web-push ile kayıtlı tüm cihazlara gider
```

Ölçüldü: **teslimattan bildirime 549 ms.** Bildirim yükünde gövde yok.

> Önce Dovecot'un kendi `push_notification` eklentisi denendi; OX sürücüsü
> hedefi kullanıcı meta verisinden okuduğu için çalışmadı. Posta teslimatına
> dokunan bir yapılandırmayı çalışmadığı hâlde bırakmak doğru olmadığından
> geri alındı.

### Gönderen doğrulama — mavi tik neye dayanıyor

İki kademe var ve güvenceleri farklı:

| kaynak | anlamı |
|---|---|
| **BIMI + VMC** | Markayı bir sertifika otoritesi doğrulamış. Logo gösteriliyor. |
| **DMARC `p=reject`** | Domain taklit edilemiyor. Kime ait olduğu doğrulanmamış. |

Bu kural `google.com`'a tik veriyor (`p=reject`) ama `gmail.com`'a vermiyor
(`p=none`) — ayrım kendiliğinden çıkıyor, istisna yazmaya gerek kalmıyor.

### Gelen HTML en büyük saldırı yüzeyi

Bir mail istemcisinde asıl tehlike SQL injection değil, **her gelen mailin
saldırganın yazdığı HTML olması.**

- Sunucuda `sanitize-html` ile allow-list — **16/16 saldırı testi**
- İstemcide `sandbox` iframe, `allow-scripts` **yok**
- Uzak görseller varsayılan kapalı (takip pikseli)
- Spam ihtimali %20'yi geçerse görseller hiç açılmıyor

### Türkçe MIME gerçekten zor

Gelen Türkçe maillerin hepsi bozuk görünüyordu: `Doğrulama` yerine `DoÄrulama`.
Sebep, elle yazılmış ayrıştırıcının quoted-printable'ı **bayt değil karakter**
olarak çözmesiydi — UTF-8'de "ğ" iki bayttır. `mailparser`'a geçildi; eski
Türkçe maillerin `ISO-8859-9` kodlaması da böylece çalıştı.

## Spam sınıflandırma

Model ayrı depoda: **[turkce-spam-modeli](https://github.com/eymenaktas/turkce-spam-modeli)**
— %97 doğruluk, ONNX, kendi gelen kutusu verisiyle eğitildi.

Üç kademeli davranış:

| skor | ne oluyor |
|---|---|
| %20 üstü | uzak görseller açılmıyor |
| %50 üstü | listede `spam? %62` rozeti, bildirim gitmiyor |
| %70 üstü | Spam klasörüne taşınıyor |

Taşıma en ağır karar olduğu için dört emniyeti var: yalnızca okunmamış,
yıldızsız ve doğrulanmamış göndereninden gelen mailler taşınıyor, her taşıma
denetim kaydına yazılıyor. Taşımadan önce **tam gövdeyle yeniden ölçülüyor** —
konu tek başına güvenilmez bir sinyal.

## Kurulum

## Nasıl çalışıyor

### Giriş (iki aşama)

```
1. POST /api/auth/login       e-posta + parola
   └─ Dovecot'a bağlanılır; başarılıysa
      ├─ 2FA yoksa  → oturum açılır
      └─ 2FA varsa  → "2fa_required" + (cihaz yöntemiyse) challenge

2. POST /api/auth/login/2fa   totp | device | recovery
   └─ geçerse oturum açılır
```

### Posta parolası neden güvende

Tek parola modelinde uygulamanın IMAP parolasına oturum boyunca ihtiyacı
var. Düz saklamak, veritabanı dökümü = tüm postaların ele geçmesi
demekti. Bunun yerine:

1. Girişte rastgele bir **oturum anahtarı** üretilir.
2. IMAP parolası bu anahtarla şifrelenip DB'ye yazılır.
3. Anahtar **yalnızca istemciye** gider (httpOnly çerezde).
4. Sunucu her istekte anahtarı istemciden alır, kullanır, atar.

Sonuç: **veritabanı tek başına çalınırsa posta parolası çözülemez.**
Test bunu doğruluyor ("yanlış anahtarla çözülemiyor").

### Mobilde "çıkış yapana kadar hatırla"

Cihaz bir anahtar çifti üretir; özel anahtar Android Keystore'dan
**çıkmaz**. Refresh token o cihaza bağlanır ve her kullanımda yenilenir
— uygulama açıldıkça süre baştan başlar, kullanıcı çıkış yapana kadar
oturum kapanmaz. Aynı cihazda birden fazla hesap bağlanabilir.

Token çalınsa bile başka cihazda işe yaramaz.

## Kurulum

```bash
cd backend
npm install
cp .env.example .env
```

Sırları üret (her biri için ayrı çalıştır):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`ENCRYPTION_KEY` tam 32 bayt olmalı:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## Geliştirme: sunucuya tünel

Uygulama kendi Dovecot'una `127.0.0.1` üzerinden bağlanır. Bu portlar
dışarıya **kapalı** (ufw); yerelde geliştirirken SSH tüneli gerekir:

```bash
ssh -N -L 15432:127.0.0.1:5432 -L 1143:127.0.0.1:143 -L 1587:127.0.0.1:587 -L 16379:127.0.0.1:6379 akts
```

> **Dikkat:** `~/.ssh/config`'de `ControlPersist 10m` var. Tünel açan
> `ssh -N` süreci bittikten sonra yönlendirmeler ana bağlantı üzerinde
> bir süre yaşamaya devam ediyor, sonra sessizce kapanıyor. Bağlantı
> hatası alırsan tüneli yeniden aç.

Tünel açıkken:

```bash
npm run dev
```

## Testler

```bash
npm test
```

Sanitizer testleri gerçek saldırı biçimlerini kapsıyor: `<script>`,
`javascript:` / `data:` URL'leri, inline event handler, iframe/form,
CSS ile sayfa kaplama, takip pikseli. Kripto testleri yanlış anahtar,
kurcalama ve IV tekrarına bakıyor.

> **Sanitizer'a veya kripto katmanına dokunulduğunda bu testler
> mutlaka çalıştırılmalı.** Kurulum sırasında iki gerçek açık bu
> testler sayesinde yakalandı:
> 1. `rel="noopener"` sessizce düşüyordu (`allowedAttributes` filtresi
>    `transformTags`'ten sonra çalışıyor) — reverse tabnabbing.
> 2. `data-external-href`e ham URL kopyalanırken `javascript:` ve
>    `data:` şemaları geri sızıyordu; `href` doğru elenmiş olsa da
>    kopyası açığı geri açıyordu.

## Faz 2 — arayüz ve gönderme

| Parça | Durum |
|---|---|
| Gönderme (Postfix submission + nodemailer) | ✅ yazıldı, canlı denenmedi |
| Sent klasörüne kopyalama | ✅ aynı baytlar IMAP APPEND ile |
| React + Vite arayüz iskeleti | ✅ |
| Gmail paleti (açık + koyu) | ✅ ekranda doğrulandı |
| 3 panelli düzen | ✅ |
| Sandbox'lı okuyucu | ✅ |
| Uzak görsel engelleme bandı | ✅ |
| Yazma penceresi | ✅ |
| Klavye kısayolları (c/r///Esc) | ✅ |
| Passkey + PRF istemci tarafı | ✅ yazıldı, gerçek passkey ile denenmedi |
| Passkey kayıt ekranı (Ayarlar) | ✅ |
| Logo | ✅ degrade karo + iki tonlu A |
| Sunucu tarafı arama (IMAP SEARCH) | ✅ kutunun tamamını tarar |
| Ekler | ⏳ |

### Redis düşerse ne olur

`skipOnError: true` — Redis erişilemezse istek **reddedilmez**, sadece
sayılmaz. Bu ayar kapalıyken Redis'in bir anlık kesintisi **API'nin
tamamını 500'e düşürüyordu**: rate limit sayacı yüzünden posta kutusuna
erişim komple kapanıyordu.

Karşılığında: Redis yokken rate limit de yok. Sessizce korumasız
kalmamak için durum değişimleri açıkça loglanıyor
(`redis erişilemiyor — RATE LIMIT DEVRE DIŞI` / `redis geri geldi`).
Redis dönünce limit kendiliğinden yeniden devreye giriyor — doğrulandı.

### Arayüzü çalıştırma

Üç şey birden gerekiyor: tünel, backend, frontend.

```bash
ssh -N -L 15432:127.0.0.1:5432 -L 1143:127.0.0.1:143 -L 1587:127.0.0.1:587 -L 16379:127.0.0.1:6379 akts
```

```bash
cd backend && npm run dev
```

```bash
cd frontend && npm run dev
```

Sonra **http://localhost:5173** adresini aç.

> **Tünel ipucu:** `~/.ssh/config`'deki `ControlPersist` yüzünden normal
> `ssh -N -L ...` tüneli ana bağlantıya iliştiriliyor ve o kapanınca
> sessizce ölüyor. Kalıcı tünel için `-o ControlPath=none` ekle:
>
> ```bash
> ssh -N -o ControlPath=none -o ExitOnForwardFailure=yes \
>   -L 15432:127.0.0.1:5432 -L 1143:127.0.0.1:143 \
>   -L 1587:127.0.0.1:587 -L 16379:127.0.0.1:6379 akts
> ```

> [!important] Passkey için `localhost` şart, `127.0.0.1` olmaz.
> **WebAuthn ham IP'yi geçerli rpId saymaz.** Spesifikasyon rpId'nin bir
> alan adı olmasını istiyor; `localhost` özel olarak izinli, `127.0.0.1`
> değil. Parolayla giriş her ikisinde de çalışır, passkey yalnızca
> `localhost`'ta.

### Neden API vite üzerinden proxy'leniyor

Frontend 5173, backend 3001 — bunlar **farklı origin**. Oturum çerezi
`SameSite=Strict` olduğu için tarayıcı onu 3001'e geri göndermiyordu:
giriş başarılı olsa bile her istek 401 dönüyor, uygulama sonsuz
`me → refresh → 401` döngüsüne giriyordu.

Çözüm: `vite.config.ts` içinde `/api` backend'e proxy'leniyor. Tarayıcı
her şeyi tek origin olarak görüyor — çerezler same-site oluyor, CORS'a
gerek kalmıyor, WebAuthn origin'i tutarlı kalıyor. Üretimde aynı işi
nginx yapacak (hepsi `mail.akts.tr` altında).

Bu yüzden istemcide `BASE` boş bırakıldı; `http://127.0.0.1:3001`
yazmak hatayı geri getirir.

### Açılışta gereksiz istek atılmıyor

Oturum çerezi `httpOnly`, JS okuyamıyor — açılışta oturum olup
olmadığını ancak sunucuya sorarak öğrenebiliyoruz. Hiç giriş
yapılmamışken bile `me` **ve** `refresh` atılıyor, iki gereksiz 401
üretiyordu. Artık `localStorage`'da bir **ipucu** tutuluyor: daha önce
hiç giriş yapılmamışsa `refresh` denenmiyor.

İpucu yalnızca bir optimizasyon — yetki tamamen sunucuda. Bayrak yanlış
olsa bile en kötü ihtimalle fazladan bir istek atılır.

### Gerçek posta kutusuyla test

Doğru parolayla giriş denemek için (parolayı sen giriyorsun, dosyaya
yazılmıyor):

```bash
curl -s -X POST http://127.0.0.1:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"eymen@akts.tr\",\"password\":\"$(read -rsp 'Parola: ' p; echo "$p")\"}"
```

## Dağıtım — CANLI ✅

**https://mail.akts.tr** yayında.

| Parça | Nerede |
|---|---|
| Frontend (statik) | `/opt/aktas-mail/frontend` — nginx servis ediyor |
| Backend | `/opt/aktas-mail/backend/dist` — PM2, `127.0.0.1:3001` |
| Çalışan kullanıcı | **`aktasmail`** (uid 999) — root DEĞİL |
| Yapılandırma | `/opt/aktas-mail/backend/.env`, chmod 600, sahibi `aktasmail` |
| Sertifika | Let's Encrypt, `mail.akts.tr` |

### Güncelleme

```bash
cd backend && npm run build && cd ../frontend && npm run build && cd ..
rsync -a --delete backend/dist/ akts:/opt/aktas-mail/backend/dist/
rsync -a --delete frontend/dist/ akts:/opt/aktas-mail/frontend/
ssh akts 'pm2 restart aktas-mail'
```

Bağımlılık değiştiyse `backend/package.json` ve `package-lock.json`'ı da
gönderip sunucuda `npm ci --omit=dev` çalıştır.

### Dağıtımda çıkan iki şey

1. **Node `.env`'i kendiliğinden okumuyor.** Uygulama açılışta
   yapılandırma doğrulamasına takılıp crash döngüsüne girdi — env
   doğrulaması tam da amacına uygun davrandı. Çözüm: PM2'ye
   `--interpreter-args="--env-file=..."` (Node 22'nin yerleşik özelliği,
   ek paket gerekmiyor).
2. **`pm2 save` unutulursa reboot'ta süreç geri gelmez.** Kaydedildi;
   dump'ta `uid: 999` ve `--env-file` bayrağı da duruyor.

### nginx tarafında

Cloudflare kalkanı olmadığı için `limit_req` konuldu: giriş uçlarına
dakikada 10 (burst 5), genel API'ye dakikada 120 (burst 40), IP başına
en fazla 24 eşzamanlı bağlantı.

## Yönetim (admin)

`ADMIN_EMAIL` (varsayılan `eymen@akts.tr`) posta kutusu açıp kaldırabilir.
Ayarlar penceresinde **"Kullanıcılar" sekmesi** olarak görünür — ayrı
sayfa yok.

### Güvenlik katmanları

Uygulama root değil, ama kutu açmak `/etc/postfix/vmailbox` ve
`/etc/dovecot/users`'a yazmayı gerektiriyor. Araya beş katman kondu:

1. **Admin kimliği env'den**, DB'den değil — veritabanına yazabilen biri
   kendini admin yapamaz.
2. **Giriş yapmış ama admin olmayan → 404.** Uçların varlığı bile
   sızmıyor. (Oturumsuz → 401.)
3. **Yeniden kimlik doğrulama:** ekleme ve silmede admin *kendi*
   parolasını girer, Dovecot'a sorularak doğrulanır. Oturum çerezi
   çalınsa bile kutu açılıp silinemez.
4. **Dar sudo:** `aktasmail` yalnızca `/usr/local/sbin/aktasmail-user`
   script'ini çalıştırabilir (`/etc/sudoers.d/aktasmail`).
5. **Script çağıranına güvenmez:** adresi kendi başına doğrular. Test
   edildi — başka alan adı, `../`, `;`, `$(...)`, boşluk, büyük harf ve
   admin kutusunun silinmesi reddediliyor.

Ayrıca: parola argüman olarak DEĞİL **stdin**'den geçiyor (`ps` çıktısında
görünmesin), işlemler rate limitli (saatte 10) ve audit log'a yazılıyor
(parola değil, yalnızca adres).

> **Kutu kaldırıldığında posta verisi diskte kalır.** Geri alınamaz silme
> yapılmıyor; `/var/mail/vhosts/akts.tr/<kullanıcı>` elle silinmeli.

## Mobil

**PWA olarak kurulabilir** — Android'de Chrome → menü → "Uygulamayı
yükle". Ana ekrana ikon gelir, tam ekran (standalone) açılır, çevrimdışı
açılışta kabuk yüklenir.

> Service worker **`/api/` altındaki hiçbir cevabı önbelleğe almıyor.**
> Mail gövdeleri ve adresler cihazda kalıcı kopya bırakmamalı — telefon
> kaybolursa tarayıcı önbelleğinden posta okunabilmesi kabul edilemez.
> Doğrulandı: önbellekte yalnızca kabuk dosyaları var.

### APK — henüz yok

Bu makinede **Java, Android SDK ve Android Studio kurulu değil**, o
yüzden APK derlenemedi. Capacitor ile sarmalamak için gerekenler:

```bash
brew install --cask temurin           # JDK
brew install --cask android-commandlinetools
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"

cd frontend
npm i @capacitor/core @capacitor/cli @capacitor/android
npx cap init "Aktaş Mail" tr.akts.mail --web-dir=dist
npx cap add android
npm run build && npx cap sync android
cd android && ./gradlew assembleDebug     # -> app/build/outputs/apk/debug/
```

Yayına çıkacak sürüm için ayrıca imzalama anahtarı gerekiyor.

## Sıradaki iş (Faz 3)

1. **Ekler** — yükleme/indirme, ayrı origin'den servis, ClamAV taraması.
2. **Dağıtım** — ayrı sistem kullanıcısı, PM2, nginx `limit_req`,
   `mail.akts.tr`'ye kurulum.
3. **Android** — Capacitor sarmalama.

## Bilinen eksikler

- **Dev ve üretim aynı veritabanını kullanıyor** (`aktasmail`), ama
  `ENCRYPTION_KEY`'leri farklı. Üretimde TOTP kurulursa yerel geliştirme
  onu çözemez (ve tersi). Ayırmak için:
  ```bash
  ssh akts 'sudo -u postgres createdb -O aktasmail aktasmail_dev'
  # sonra yerel .env'de DATABASE_URL'i aktasmail_dev'e çevir, db:push çalıştır
  ```

- **TOTP replay:** `verifyTotpToken` içinde `afterTimeStep`
  kullanılmıyor, aynı kod 30 sn penceresinde ikinci kez kullanılabilir.
  Son başarılı time step'in `users` tablosunda tutulması gerekiyor
  (kodda `TODO(replay)`).
- **Gönderme canlı denenmedi:** kod hazır ama gerçek bir mail
  gönderilmedi.
