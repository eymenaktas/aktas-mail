/**
 * Kripto ve TOTP testleri.
 * Çalıştır: npx tsx src/lib/crypto.test.ts
 *
 * Bu katman sessizce bozulabilecek türden: yanlış anahtarla çözme
 * "çalışıyor gibi" görünmez, ama kurcalanmış veriyi kabul etmek
 * fark edilmeden geçebilir. O yüzden negatif vakalar da test ediliyor.
 */
import {
  encrypt,
  decrypt,
  newSessionKey,
  sha256,
  safeEqual,
  packSessionCookie,
  unpackSessionCookie,
  randomToken,
} from "./crypto.js";
import { newTotpSecret, totpUri, verifyTotpToken } from "../auth/totp.js";
import { generateSync } from "otplib";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ""}`);
  }
}

console.log("\nOturum anahtarı şifrelemesi\n");

const key = newSessionKey();
const parola = "çok-gizli-posta-parolası-🔐";

{
  const enc = encrypt(parola, key);
  check("şifrele/çöz gidiş-dönüş", decrypt(enc, key) === parola);
  check("şifreli metin düz parolayı içermiyor", !enc.includes(parola), enc.slice(0, 40));
}

{
  // Asıl güvence: DB dökümü tek başına parolayı vermez
  const enc = encrypt(parola, key);
  const baskaAnahtar = newSessionKey();
  let cozuldu = false;
  try {
    decrypt(enc, baskaAnahtar);
    cozuldu = true;
  } catch {
    /* beklenen */
  }
  check("yanlış anahtarla çözülemiyor (DB dökümü yetmez)", !cozuldu);
}

{
  // GCM auth tag: kurcalama sessizce geçmemeli
  const enc = encrypt(parola, key);
  const raw = Buffer.from(enc, "base64");
  const bozulacak = raw.length - 20;
  raw[bozulacak] = (raw[bozulacak] ?? 0) ^ 0xff; // ciphertext'in ortasını boz
  let kabul = false;
  try {
    decrypt(raw.toString("base64"), key);
    kabul = true;
  } catch {
    /* beklenen */
  }
  check("kurcalanmış şifreli veri reddediliyor", !kabul);
}

{
  const enc1 = encrypt(parola, key);
  const enc2 = encrypt(parola, key);
  check("aynı girdi farklı çıktı veriyor (IV rastgele)", enc1 !== enc2);
}

{
  let hata = false;
  try {
    encrypt("x", "kisa");
  } catch {
    hata = true;
  }
  check("geçersiz uzunlukta anahtar reddediliyor", hata);
}

console.log("\nToken ve çerez\n");

{
  check("sha256 kararlı", sha256("abc") === sha256("abc"));
  check("sha256 farklı girdide farklı", sha256("abc") !== sha256("abd"));
  check("token'lar benzersiz", randomToken() !== randomToken());
  check("safeEqual eşitte true", safeEqual("aynı", "aynı"));
  check("safeEqual farklıda false", !safeEqual("aynı", "başka"));
  check("safeEqual farklı uzunlukta false", !safeEqual("kısa", "çok-uzun-değer"));
}

{
  const id = randomToken(24);
  const k = newSessionKey();
  const packed = packSessionCookie(id, k);
  const un = unpackSessionCookie(packed);
  check("çerez paketle/aç gidiş-dönüş", un?.sessionId === id && un?.sessionKey === k);
  check("bozuk çerez null dönüyor", unpackSessionCookie("noktasiz") === null);
  check("boş kısımlı çerez null dönüyor", unpackSessionCookie(".") === null);
}

console.log("\nTOTP\n");

{
  const secret = newTotpSecret();
  const kod = String(generateSync({ secret }));

  check("üretilen kod doğrulanıyor", verifyTotpToken(kod, secret));
  check("yanlış kod reddediliyor", !verifyTotpToken("000000", secret));
  check("6 haneden kısa reddediliyor", !verifyTotpToken("123", secret));
  check("harf içeren kod reddediliyor", !verifyTotpToken("12a456", secret));
  check("boşluklu kod temizlenip kabul ediliyor", verifyTotpToken(`${kod.slice(0, 3)} ${kod.slice(3)}`, secret));

  const baskaSecret = newTotpSecret();
  check("başka secret'ın kodu geçmiyor", !verifyTotpToken(kod, baskaSecret));

  const uri = totpUri(secret, "eymen@akts.tr");
  check("otpauth URI hesap adını içeriyor", uri.includes("eymen%40akts.tr") || uri.includes("eymen@akts.tr"), uri);
  check("otpauth URI secret içeriyor", uri.includes(secret), uri.slice(0, 60));
}

console.log(`\nSonuç: ${passed} geçti, ${failed} kaldı\n`);
process.exit(failed === 0 ? 0 : 1);
