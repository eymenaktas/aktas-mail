import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { env } from "../env.js";

/**
 * Sunucu anahtarıyla şifreleme — SADECE giriş sırasında, henüz oturum
 * yokken çözülmesi gereken sırlar için (TOTP gizli anahtarı).
 *
 * IMAP parolası buradan GEÇMEZ; o, istemcideki oturum anahtarıyla
 * şifrelenir (bkz. lib/crypto.ts). Ayrımı korumak önemli: aksi halde
 * veritabanı dökümü tek başına posta parolalarını verir.
 */

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function serverKey(): Buffer {
  return Buffer.from(env.ENCRYPTION_KEY, "base64url");
}

export function encryptServerSide(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, serverKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, enc, cipher.getAuthTag()]).toString("base64");
}

export function decryptServerSide(payload: string): string {
  const raw = Buffer.from(payload, "base64");
  if (raw.length < IV_LEN + TAG_LEN) throw new Error("Bozuk şifreli veri");

  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(raw.length - TAG_LEN);
  const data = raw.subarray(IV_LEN, raw.length - TAG_LEN);

  const decipher = createDecipheriv(ALGO, serverKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** Kurtarma kodu: yüksek entropili, okunabilir gruplar hâlinde. */
export function generateRecoveryCode(): string {
  const raw = randomBytes(10).toString("hex").toUpperCase();
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}`;
}

/** 128 bit rastgele değer için SHA-256 yeterli; Argon2 insan parolaları içindir. */
export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.replace(/-/g, "").toUpperCase()).digest("hex");
}
