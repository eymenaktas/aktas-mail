/**
 * Avatar çözme testleri — ağ gerektirmeyen saf kısımlar.
 *
 * BIMI/Gravatar'ın gerçek ağ davranışı ayrıca elle doğrulandı (2026-08-21):
 *   noreply@account.tiktok.com -> BIMI logo + VMC (mavi tik)
 *   billing@paypal.com         -> BIMI logo + VMC
 *   noreply@github.com         -> BIMI yok, Gravatar yok -> harf avatarı
 *   matt@mullenweg.com         -> Gravatar fotoğrafı
 */
import assert from "node:assert/strict";
import { bimiAyristir, bimiAdaylari, domainAyikla } from "./avatar.js";
import { domainAyikla } from "./avatar.js";

let gecti = 0;
let kaldi = 0;
function test(ad: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${ad}`);
    gecti += 1;
  } catch (e) {
    console.log(`  ✗ ${ad}\n      ${(e as Error).message}`);
    kaldi += 1;
  }
}

console.log("\nAvatar çözme");

test("BIMI kaydı ayrıştırılıyor", () => {
  const r = bimiAyristir("v=BIMI1; l=https://x.com/logo.svg; a=https://x.com/vmc.pem");
  assert.equal(r?.l, "https://x.com/logo.svg");
  assert.equal(r?.a, "https://x.com/vmc.pem");
});

test("VMC'siz kayıtta a alanı yok (tik gösterilmemeli)", () => {
  const r = bimiAyristir("v=BIMI1; l=https://x.com/logo.svg;");
  assert.equal(r?.l, "https://x.com/logo.svg");
  assert.equal(r?.a, undefined);
});

test("BIMI olmayan TXT kaydı reddediliyor", () => {
  assert.equal(bimiAyristir("v=spf1 include:_spf.google.com ~all"), null);
  assert.equal(bimiAyristir("google-site-verification=abc"), null);
});

test("alt domainden kuruluş domainine yürüyor", () => {
  // TikTok doğrulama maili account.tiktok.com'dan gelir, BIMI tiktok.com'da
  assert.deepEqual(bimiAdaylari("account.tiktok.com"), ["account.tiktok.com", "tiktok.com"]);
});

test("com.tr gibi çok parçalı uzantıda 'com.tr' sorgulanmıyor", () => {
  const adaylar = bimiAdaylari("mail.sirket.com.tr");
  assert.deepEqual(adaylar, ["mail.sirket.com.tr", "sirket.com.tr"]);
  assert.ok(!adaylar.includes("com.tr"));
});

test("kuruluş domaininde tek aday var", () => {
  assert.deepEqual(bimiAdaylari("github.com"), ["github.com"]);
});

test("en fazla 3 DNS sorgusu yapılıyor", () => {
  assert.ok(bimiAdaylari("a.b.c.d.e.ornek.com").length <= 3);
});

test("adresten domain ayıklanıyor", () => {
  assert.equal(domainAyikla("noreply@account.tiktok.com"), "account.tiktok.com");
  assert.equal(domainAyikla("BÜYÜK@Ornek.COM"), "ornek.com");
  assert.equal(domainAyikla("domainsiz"), null);
});

console.log(`\nSonuç: ${gecti} geçti, ${kaldi} kaldı`);
if (kaldi > 0) process.exit(1);
