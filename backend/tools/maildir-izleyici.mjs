#!/usr/bin/env node
/**
 * MAILDIR İZLEYİCİ — anlık bildirim tetikleyicisi
 * ==============================================
 *
 * Yeni mail Maildir'e yazıldığı ANDA uygulamanın push kancasına haber
 * verir. `fs.watch` Linux'ta inotify kullanıyor, yani yoklama yok:
 * dosya oluştuğu anda olay geliyor.
 *
 * ## Neden bu yol?
 *
 * Uygulama IMAP parolasını saklamıyor (oturum anahtarı yalnızca
 * istemcide), dolayısıyla posta kutusunu kendi başına yoklayamıyor.
 * Tetikleyicinin teslimat tarafında olması ŞART.
 *
 * Önce Dovecot'un `push_notification` eklentisi (OX sürücüsü) denendi
 * (2026-08-22): hedefi kullanıcı meta verisinden okuduğu için
 * "Mailbox attributes not enabled" deyip atladı, nitelikler açıldığında
 * da sessiz kaldı. Posta teslimatına dokunan bir yapılandırmayı
 * çalışmadığı hâlde bırakmak doğru olmadığı için geri alındı ve
 * tetikleme buraya taşındı: Dovecot'un yapılandırmasına hiç dokunmuyor,
 * yalnızca sonucu (dosya) izliyor.
 *
 * ## Spam taşıma
 *
 * Kanca yalnızca "bildirim gönderilsin mi" demiyor, "bu mail Spam'e
 * taşınsın mı" da diyor (`tasi`). Taşımayı BU betik yapıyor çünkü
 * dosyaya doğrudan erişimi var.
 *
 * Neden burada: uygulama IMAP parolasını saklamadığı için posta
 * kutusunu kendi başına değiştiremiyor ve taşıma ancak kullanıcı gelen
 * kutusunu açtığında yapılabiliyordu. Oysa taşıma bir DOSYA işlemi —
 * Maildir'de maili `.Junk/new/` altına taşımak yeterli, Dovecot orayı
 * tarayıp indeksliyor. Karar sunucuda (model, eşikler), iş burada.
 *
 * Önce dosya taşınmayı deniyor (hızlı yol, mail hâlâ `new/` içindeyse
 * çalışır). Dovecot arada `cur/`e almışsa `doveadm move` ile Message-ID
 * üzerinden taşınıyor — indeksler tutarlı kalsın diye Dovecot'un kendi
 * aracı.
 *
 * ## Ne okunuyor
 *
 * `From`, `Subject` ve gövdeden kısa bir parça. Gövde parçası YALNIZCA
 * spam skoru için kullanılıyor ve sunucudan çıkmıyor — bildirim yükünde
 * hâlâ sadece gönderen ve konu var.
 *
 * ## Çalıştırma
 *
 *   MAILDIR_KOK=/var/mail/vhosts \
 *   HOOK_URL=http://127.0.0.1:3001/api/push/hook \
 *   HOOK_SECRET=... node maildir-izleyici.mjs
 */

import { readdir, readFile, rename, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const calistir = promisify(execFile);

const KOK = process.env["MAILDIR_KOK"] ?? "/var/mail/vhosts";
const HOOK = process.env["HOOK_URL"] ?? "http://127.0.0.1:3001/api/push/hook";
const SIR = process.env["HOOK_SECRET"] ?? "";

if (!SIR) {
  console.error("HOOK_SECRET tanımlı değil — çıkılıyor.");
  process.exit(1);
}

/** RFC 2047 kodlu başlıkları (=?UTF-8?B?...?=) okunur hâle getirir. */
function basligiCoz(ham) {
  return ham.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (tam, kod, tur, veri) => {
    try {
      if (tur.toUpperCase() === "B") {
        return Buffer.from(veri, "base64").toString(kod.toLowerCase().includes("8859") ? "latin1" : "utf8");
      }
      // Q kodlaması: alt çizgi boşluk demek, =XX onaltılık
      const metin = veri.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
        String.fromCharCode(parseInt(h, 16)),
      );
      return Buffer.from(metin, "latin1").toString("utf8");
    } catch {
      return tam;
    }
  });
}

/**
 * Başlıkları ve gövdeden KISA bir parça okur.
 *
 * Gövde parçası yalnızca SPAM SKORU için: model konu+gövde ile
 * eğitildi, tek başına konu çok zayıf bir sinyal. 2026-08-22'de
 * ölçüldü — yalnızca konuya bakınca "Siparişiniz teslim edildi" %51
 * çıkıp bildirimi engelliyordu; tam metinle %2.
 *
 * Bu parça bildirim YÜKÜNE GİRMİYOR: push'ta hâlâ yalnızca gönderen
 * ve konu var. Gövde sunucudan hiç çıkmıyor.
 */
async function basliklariOku(dosya) {
  let ham;
  try {
    ham = await readFile(dosya, "latin1");
  } catch {
    return null;
  }
  const bitis = ham.search(/\r?\n\r?\n/);
  const blok = (bitis === -1 ? ham : ham.slice(0, bitis))
    // Katlanmış başlıkları tek satıra indir
    .replace(/\r?\n[ \t]+/g, " ");

  const al = (ad) => {
    const m = blok.match(new RegExp(`^${ad}:\\s*(.*)$`, "im"));
    return m?.[1] ? basligiCoz(m[1].trim()) : "";
  };

  const from = al("From");

  // Gövdenin ilk parçası: quoted-printable/base64 çözmeden kaba bir
  // metin yeterli — skor için işaret kelimeleri lazım, kusursuz metin değil.
  const govdeHam = bitis === -1 ? "" : ham.slice(bitis, bitis + 4000);
  const govde = Buffer.from(govdeHam, "latin1")
    .toString("utf8")
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500);

  return {
    subject: al("Subject") || "(konu yok)",
    // "Ad <adres>" -> "Ad"; yoksa adresin kendisi
    from: from.replace(/\s*<[^>]*>\s*/, "").replace(/^"|"$/g, "").trim() || from,
    /*
      ADRES AYRI TAŞINIYOR.

      `from` yalnızca görünen adı tutuyor (bildirimde öyle görünsün
      diye). Ama sunucudaki "doğrulanmış gönderen taşınmaz" güvencesi
      DOMAIN'e bakıyor — adres olmadan çalışamaz.
    */
    fromAddress: (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase(),
    // doveadm ile taşımak gerekirse maili bununla buluyoruz
    messageId: al("Message-ID"),
    govde,
  };
}

/** Aynı dosya için iki kez bildirim gitmesin. */
const gorulen = new Set();
setInterval(() => gorulen.clear(), 10 * 60 * 1000).unref();

async function bildir(kullanici, dosya) {
  if (gorulen.has(dosya)) return;
  gorulen.add(dosya);

  const basliklar = await basliklariOku(dosya);
  if (!basliklar) return;

  try {
    const cevap = await fetch(HOOK, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hook-secret": SIR },
      body: JSON.stringify({
        user: kullanici,
        folder: "INBOX",
        subject: basliklar.subject,
        from: basliklar.from,
        fromAddress: basliklar.fromAddress,
        // Yalnızca skor için; bildirim yüküne girmiyor
        snippet: basliklar.govde,
      }),
    });
    const sonuc = await cevap.text();
    console.log(`[${new Date().toISOString()}] ${kullanici} <- ${basliklar.from}: ${cevap.status} ${sonuc.slice(0, 90)}`);

    let karar = null;
    try {
      karar = JSON.parse(sonuc);
    } catch {
      /* kanca metin döndüyse taşıma yok */
    }
    if (karar?.tasi) await spameTasi(kullanici, dosya, basliklar, karar);
  } catch (e) {
    console.error("kanca çağrılamadı:", e.message);
  }
}

/**
 * Maili Spam klasörüne taşır.
 *
 * 1) Hızlı yol: dosya hâlâ `new/` içindeyse `.Junk/new/` altına taşı.
 * 2) Dovecot arada almışsa `doveadm move` ile Message-ID üzerinden.
 *
 * Taşınamazsa mail gelen kutusunda kalıyor — kullanıcı gelen kutusunu
 * açtığında `bakimYap` yine yakalar. Yani bu bir HIZLANDIRMA, tek
 * savunma hattı değil.
 */
async function spameTasi(kullanici, dosya, basliklar, karar) {
  const yuzde = Math.round((karar.skor ?? 0) * 100);
  const kok = path.dirname(path.dirname(dosya)); // <kutu>/new/<ad> -> <kutu>
  const ad = path.basename(dosya);
  const hedef = path.join(kok, ".Junk", "new", ad);

  try {
    await rename(dosya, hedef);
    console.log(`  -> Spam'e taşındı (%${yuzde} ${karar.dil}): ${basliklar.subject.slice(0, 50)}`);
    return;
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error(`  -> dosya taşınamadı: ${e.message}`);
    }
  }

  const mid = basliklar.messageId;
  if (!mid) {
    console.error("  -> Message-ID yok, doveadm ile taşınamıyor");
    return;
  }
  try {
    await calistir("doveadm", ["move", "-u", kullanici, "Junk", "mailbox", "INBOX", "HEADER", "Message-ID", mid]);
    console.log(`  -> Spam'e taşındı [doveadm] (%${yuzde} ${karar.dil}): ${basliklar.subject.slice(0, 50)}`);
  } catch (e) {
    console.error(`  -> doveadm taşıyamadı: ${e.message.slice(0, 120)}`);
  }
}

/**
 * Kullanıcı klasörlerini bulur: <kok>/<domain>/<kullanici>/new
 * Adres olarak `<kullanici>@<domain>` üretiliyor.
 */
async function kutulariBul() {
  const kutular = [];
  for (const domain of await readdir(KOK).catch(() => [])) {
    const dYol = path.join(KOK, domain);
    if (!(await stat(dYol).catch(() => null))?.isDirectory()) continue;
    for (const kullanici of await readdir(dYol).catch(() => [])) {
      const yeni = path.join(dYol, kullanici, "new");
      if ((await stat(yeni).catch(() => null))?.isDirectory()) {
        kutular.push({ adres: `${kullanici}@${domain}`, yol: yeni });
      }
    }
  }
  return kutular;
}

const kutular = await kutulariBul();
if (kutular.length === 0) {
  console.error(`${KOK} altında posta kutusu bulunamadı.`);
  process.exit(1);
}

for (const { adres, yol } of kutular) {
  console.log(`izleniyor: ${adres}  (${yol})`);
  watch(yol, (olay, ad) => {
    // "rename" dosya oluşturma/silme demek; Maildir yeni maili
    // doğrudan new/ içine yazıyor.
    if (!ad || olay !== "rename") return;
    const tam = path.join(yol, ad);
    // Dosyanın tamamen yazılmasını bekle — çok kısa bir gecikme yeter
    setTimeout(() => {
      void stat(tam)
        .then(() => bildir(adres, tam))
        .catch(() => {}); // silinmişse (okundu klasörüne taşındı) atla
    }, 120);
  });
}

console.log(`${kutular.length} kutu izleniyor, kanca: ${HOOK}`);
