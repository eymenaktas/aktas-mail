/**
 * SKORLAMA TUTARLILIĞI
 *
 * 2026-08-22'de aynı hata ÜÇ ayrı yerde çıktı: karar veren kod, spam
 * skorunu farklı girdilerle hesaplıyordu.
 *
 *   bildirim kancası -> gönderen + konu      ("Siparişiniz teslim edildi" %51)
 *   liste rozeti     -> konu + önizleme
 *   otomatik taşıma  -> konu + önizleme      (önizleme boşsa ~konu)
 *
 * Sonuç: Gmail'in yönlendirme onay maili taşımada %90 alıp Spam'e düştü;
 * tam gövdeyle skoru %0'dı. Yani kullanıcının en çok ihtiyaç duyduğu mail
 * kaybolabilirdi.
 *
 * Bu dosya modelin doğruluğunu değil, KONU TEK BAŞINA YETMEZ gerçeğini
 * sabitliyor. Karar veren yeni bir yer eklenirse buradaki örnekler
 * hatırlatıcı olsun.
 */
import assert from "node:assert/strict";
import { spamSkorla } from "./spam.js";

let gecti = 0;
let kaldi = 0;
async function test(ad: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${ad}`);
    gecti += 1;
  } catch (e) {
    console.log(`  ✗ ${ad}\n      ${(e as Error).message}`);
    kaldi += 1;
  }
}

console.log("\nSkorlama tutarlılığı");

/** Gerçek olay: bu mail Spam'e taşınmıştı. */
const GMAIL_KONU = "Gmail Forwarding Confirmation - Receive Mail from gizliman2345@gmail.com";
const GMAIL_GOVDE =
  "gizliman2345@gmail.com has requested to automatically forward mail to your email address. " +
  "Confirmation code: 123456789. To allow this, please click the link below. " +
  "If you do not approve of this request, no further action is required.";

await test("konu TEK BAŞINA yanıltıyor, gövdeyle birlikte doğru", async () => {
  const [yalnizKonu] = await spamSkorla([GMAIL_KONU]);
  const [tamMetin] = await spamSkorla([`${GMAIL_KONU} ${GMAIL_GOVDE}`]);

  // Asıl iddia: gövde eklenince skor DÜŞÜYOR. Sayılar model
  // değiştikçe kayabilir, ilişki kalmalı.
  assert.ok(
    (tamMetin?.skor ?? 1) < (yalnizKonu?.skor ?? 0),
    `gövde skoru düşürmeli: yalnız konu %${Math.round((yalnizKonu?.skor ?? 0) * 100)}, ` +
      `tam metin %${Math.round((tamMetin?.skor ?? 0) * 100)}`,
  );
});

await test("Gmail yönlendirme onayı tam metinde spam DEĞİL", async () => {
  const [r] = await spamSkorla([`${GMAIL_KONU} ${GMAIL_GOVDE}`]);
  assert.ok(
    (r?.skor ?? 1) < 0.7,
    `taşıma eşiğinin altında olmalı, %${Math.round((r?.skor ?? 0) * 100)} çıktı`,
  );
});

await test("boş gövde skoru şişiriyor — ön eleme tek başına yetmez", async () => {
  const [bos] = await spamSkorla([GMAIL_KONU]);
  const [dolu] = await spamSkorla([`${GMAIL_KONU} ${GMAIL_GOVDE}`]);
  const fark = (bos?.skor ?? 0) - (dolu?.skor ?? 0);
  assert.ok(
    fark > 0.2,
    `fark anlamlı olmalı (şu an ${Math.round(fark * 100)} puan); ` +
      `değilse bu testin dayandığı sorun ortadan kalkmış olabilir`,
  );
});

console.log(`\nSonuç: ${gecti} geçti, ${kaldi} kaldı`);
if (kaldi > 0) process.exit(1);
