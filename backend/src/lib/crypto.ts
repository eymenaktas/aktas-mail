import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";

/**
 * Oturum anahtarı sunucuda TUTULMAZ.
 *
 * Tek parola modelinde (A) uygulamanın IMAP parolasına oturum boyunca
 * ihtiyacı var. Onu düz saklamak, veritabanı dökümü = tüm postaların
 * ele geçmesi demek olurdu. Bu yüzden:
 *
 *   1. Girişte rastgele bir `sessionKey` üretilir.
 *   2. IMAP parolası bu anahtarla şifrelenip DB'ye yazılır.
 *   3. `sessionKey` yalnızca istemciye gider (httpOnly çerezde).
 *   4. Sunucu her istekte anahtarı istemciden alır, kullanır, atar.
 *
 * Sonuç: veritabanı tek başına çalınırsa posta parolası çözülemez.
 */

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Oturum anahtarı: 32 bayt, base64url. */
export function newSessionKey(): string {
  return randomBytes(32).toString("base64url");
}

/** Token'lar DB'ye ham değil, özetiyle yazılır. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Zamanlama saldırısına kapalı karşılaştırma. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function keyFrom(sessionKey: string): Buffer {
  const raw = Buffer.from(sessionKey, "base64url");
  if (raw.length !== 32) throw new Error("Geçersiz oturum anahtarı uzunluğu");
  return raw;
}

/** IV | ciphertext | authTag → base64 */
export function encrypt(plaintext: string, sessionKey: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, keyFrom(sessionKey), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, enc, cipher.getAuthTag()]).toString("base64");
}

export function decrypt(payload: string, sessionKey: string): string {
  const raw = Buffer.from(payload, "base64");
  if (raw.length < IV_LEN + TAG_LEN) throw new Error("Bozuk şifreli veri");

  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(raw.length - TAG_LEN);
  const data = raw.subarray(IV_LEN, raw.length - TAG_LEN);

  const decipher = createDecipheriv(ALGO, keyFrom(sessionKey), iv);
  decipher.setAuthTag(tag);
  // GCM: kurcalanmışsa final() hata fırlatır
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/**
 * Çerez değeri: "<sessionId>.<sessionKey>"
 * Sunucu id ile kaydı bulur, anahtarla parolayı çözer.
 */
export function packSessionCookie(sessionId: string, sessionKey: string): string {
  return `${sessionId}.${sessionKey}`;
}

export function unpackSessionCookie(
  value: string,
): { sessionId: string; sessionKey: string } | null {
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  return {
    sessionId: value.slice(0, dot),
    sessionKey: value.slice(dot + 1),
  };
}
