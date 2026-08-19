import { generateSecret, generateURI, verifySync } from "otplib";

/**
 * Saf TOTP işlemleri — veritabanı ya da yapılandırma bağımlılığı YOK.
 * Böylece test edilebilir ve bir kullanıcı bağlamı gerektirmez.
 * Kullanıcıya bağlı işlemler için: auth/twofactor.ts
 *
 * otplib v13 API'si: generateSecret / generateURI / verifySync.
 * (v12'deki `authenticator` nesnesi kaldırılmış.)
 */

export function newTotpSecret(): string {
  return generateSecret();
}

/**
 * Authenticator uygulamasına okutulacak otpauth:// adresi.
 * Not: v13'te hesap adının anahtarı `label` — `accountName` sessizce
 * "undefined" üretiyor.
 */
export function totpUri(secret: string, account: string, issuer = "Aktaş Mail"): string {
  return String(generateURI({ secret, label: account, issuer }));
}

export function verifyTotpToken(token: string, secret: string): boolean {
  const clean = token.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  try {
    // Bir adım tolerans: cihaz saati ±30 sn kaymış olabilir.
    // v13'te bunun adı `window` değil `epochTolerance` (saniye).
    const result = verifySync({ secret, token: clean, epochTolerance: 30 });
    return result?.valid === true;
    // TODO(replay): v13 `afterTimeStep` ile aynı kodun ikinci kez
    // kullanılmasını engelliyor. Son başarılı time step'i users
    // tablosunda tutup buraya geçirmek gerekiyor.
  } catch {
    return false;
  }
}
