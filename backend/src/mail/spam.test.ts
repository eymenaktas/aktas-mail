/**
 * Spam sınıflandırma testleri (ML kampı Gün 1 ONNX modelleri).
 *
 * Modelin doğruluğunu değil, ENTEGRASYONU test ediyor: model yükleniyor mu,
 * dil seçimi doğru mu, çıktı beklenen aralıkta mı, hata durumunda akış
 * kırılıyor mu. Modelin kendi doğruluğu ML-KAMP/gun-01'de ölçüldü.
 */
import assert from "node:assert/strict";
import { spamSkorla, diliTahminEt } from "./spam.js";

let gecti = 0;
let kaldi = 0;
async function test(ad: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${ad}`);
    gecti += 1;
  } catch (e) {
    console.log(`  ✗ ${ad}\n      ${(e as Error).message}`);
    kaldi += 1;
  }
}

console.log("\nSpam sınıflandırma");

await test("Türkçe karakterden dili tanıyor", () => {
  assert.equal(diliTahminEt("Doğrulama kodunuz: 746628"), "tr");
});

await test("Türkçe karaktersiz Türkçe cümleyi de tanıyor", () => {
  assert.equal(diliTahminEt("Merhaba, bu bir test maili"), "tr");
});

await test("İngilizce metni İngilizce sayıyor", () => {
  assert.equal(diliTahminEt("Your verification code is 746628"), "en");
});

test("tek bir Türkçe harf metni Türkçe yapmıyor", () => {
  // 2026-08-24: eski sürüm "içinde ş/ö/ı varsa tr" diyordu. İmzasında
  // "Eymen Aktaş" geçen ya da gövdesi bozuk kodlanmış İNGİLİZCE mailler
  // Türkçe modele gidiyor, o model İngilizce spam'i görmediği için ~%0
  // veriyordu ve spam gelen kutusunda kalıyordu.
  assert.equal(
    diliTahminEt("Save $30k even if you've refi'd. Attention U.S. HomeOwners, " +
                 "you have been pre-approved for a new mortgage rate. Click here " +
                 "to view your offer and claim it now with our team. ö"),
    "en",
  );
  assert.equal(
    diliTahminEt("Hi Eymen Aktaş, your invoice from Vercel is ready. " +
                 "Please view your account for the details and thank you."),
    "en",
  );
});

test("gerçekten Türkçe metin hâlâ tr", () => {
  assert.equal(
    diliTahminEt("Sayın müşterimiz, siparişiniz kargoya verildi ve " +
                 "bir gün içinde teslim edilecek. Tutar 250 TL."),
    "tr",
  );
});

await test("Türkçe spam yüksek skor alıyor", async () => {
  const [r] = await spamSkorla([
    "TEBRİKLER! 10.000 TL hediye çeki kazandınız, hemen tıklayın!",
  ]);
  assert.equal(r?.model, "tr");
  assert.ok((r?.skor ?? 0) > 0.8, `skor ${r?.skor}`);
});

/**
 * Modelin BUGÜN NE YAPTIĞINI kaydeder — iyi olduğunu değil.
 * Model değişirse burası kırılır ve yeniden ölçmek gerektiğini söyler.
 *
 * 2026-08-21: Türkçe model Eymen'in KENDİ Gmail arşivi (7801 gerçek mail)
 * + kamu veri setleriyle yeniden eğitildi. %74.1 -> %97.1.
 * Skorlar artık daha ılımlı (LogisticRegression + class_weight=balanced),
 * o yüzden eşikler mutlak değil: ham < 0.5 < spam olması yeterli.
 */
await test("Türkçe: gerçek işlem mailleri spam sayılmıyor", async () => {
  const sonuc = await spamSkorla([
    "Siparişiniz kargoya verildi Sipariş numaranız 12345 kargo takip",
    "Faturanız hazır Sayın müşterimiz, Ağustos ayı faturanız oluşturulmuştur",
    "Doğrulama kodunuz: 746628 Hesabınızı doğrulamak için bu kodu girin",
    "Merhaba abi, yarın müsait misin?",
  ]);
  for (const s of sonuc) {
    assert.equal(s.spam, false, `yanlış alarm: skor ${s.skor}`);
  }
});

await test("Türkçe: dolandırıcılık yakalanıyor", async () => {
  const sonuc = await spamSkorla([
    "TEBRİKLER! 10.000 TL hediye çeki kazandınız, hemen tıklayın!",
    // Bu örnek 2026-08-21 sabahı KAÇIYORDU (%4); kendi verisiyle
    // eğitildikten sonra yakalanır oldu.
    "SON ŞANS!!! Kredi başvurunuz ONAYLANDI, hemen parayı çekin TIKLAYIN",
  ]);
  for (const s of sonuc) {
    assert.equal(s.spam, true, `kaçırıldı: skor ${s.skor}`);
  }
});

/**
 * İngilizce model 2026-08-24'te 28.460 GERÇEK e-posta ile yeniden
 * eğitildi (TREC 2005/2006, SpamAssassin, kimlik avı külliyatları +
 * kullanıcının kendi arşivinden 3.460 modern mail).
 *
 * Bu test eskiden modelin KUSURUNU doğruluyordu ("GitHub uyarısı hâlâ
 * yanlış alarm olmalı"). Artık gerçek garantiyi doğruluyor: modern
 * işlem maili TAŞIMA EŞİĞİNİ (%90) geçmemeli. Rozet eşiğini (%50)
 * geçebilir — o zararsız, mail yerinde kalıyor.
 *
 * Ölçüm: 690 gerçek modern mailde %90 eşiğinde yanlış alarm %0.58.
 */
await test("modern İngilizce işlem maili taşıma eşiğini geçmiyor", async () => {
  const ORNEKLER = [
    "Your GitHub security alert A new sign-in to your account was detected " +
      "from a new device. Review your security log to see recent activity.",
    "Your receipt from Anthropic, PBC #2174-6750-6501 Thanks for your payment. " +
      "Amount paid $20.00. Download your invoice PDF from the billing page.",
    "Your Link verification code: 453 390 This code will expire in 10 minutes " +
      "and can only be used once. If you did not request this, ignore this email.",
  ];
  const sonuclar = await spamSkorla(ORNEKLER);
  sonuclar.forEach((r, i) => {
    assert.equal(r?.model, "en");
    assert.ok(
      (r?.skor ?? 1) < 0.9,
      `taşıma eşiğini geçti (%${Math.round((r?.skor ?? 1) * 100)}): ${ORNEKLER[i]?.slice(0, 50)}`,
    );
  });
});

await test("Türkçe normal mail spam sayılmıyor", async () => {
  const [r] = await spamSkorla(["Merhaba, yarınki toplantıya katılabilecek misin?"]);
  assert.equal(r?.spam, false, `skor ${r?.skor}`);
});

await test("İngilizce spam yakalanıyor", async () => {
  const [r] = await spamSkorla([
    "CONGRATULATIONS! You WON a FREE iPhone. Click here to claim now!",
  ]);
  assert.equal(r?.model, "en");
  assert.equal(r?.spam, true, `skor ${r?.skor}`);
});

await test("karışık dilli liste tek çağrıda doğru gruplanıyor", async () => {
  const sonuclar = await spamSkorla([
    "Hey, are we still meeting tomorrow at 3?",
    "TEBRİKLER! Ödülünüzü almak için tıklayın",
    "URGENT: claim your FREE prize NOW",
    "Doğrulama kodunuz: 746628",
  ]);
  assert.equal(sonuclar.length, 4);
  assert.equal(sonuclar[0]?.model, "en");
  assert.equal(sonuclar[1]?.model, "tr");
  assert.equal(sonuclar[3]?.model, "tr");
});

await test("skor her zaman 0..1 aralığında", async () => {
  const sonuclar = await spamSkorla(["merhaba", "test", ""]);
  for (const s of sonuclar) {
    assert.ok(s.skor >= 0 && s.skor <= 1, `skor aralık dışı: ${s.skor}`);
  }
});

await test("boş liste çökertmiyor", async () => {
  assert.deepEqual(await spamSkorla([]), []);
});

console.log(`\nSonuç: ${gecti} geçti, ${kaldi} kaldı`);
if (kaldi > 0) process.exit(1);
