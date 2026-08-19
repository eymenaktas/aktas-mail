import { createVerify, randomBytes } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { decryptServerSide, encryptServerSide, hashRecoveryCode } from "../lib/secrets.js";
import { verifyTotpToken } from "./totp.js";

/**
 * İkinci faktör: kullanıcı üçünden birini seçer.
 *
 *   totp   — Authenticator uygulamasındaki 6 hane
 *   passkey— WebAuthn (bkz. auth/passkey.ts)
 *   device — güvenilen cihaz anahtarı ("HWID"nin gerçek karşılığı)
 *
 * Hiçbiri kurulmamışsa (none) parola tek başına yeter.
 */

// ── TOTP ────────────────────────────────────────────────────
// Saf TOTP fonksiyonları auth/totp.ts'te (DB bağımlılığı olmasın diye).
// Buradan yeniden dışa aktarılıyor ki çağıran taraf tek yer bilsin.
export { newTotpSecret, totpUri, verifyTotpToken } from "./totp.js";

export async function verifyUserTotp(userId: number, token: string): Promise<boolean> {
  const [user] = await db
    .select({ secretEnc: schema.users.totpSecretEnc })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (!user?.secretEnc) return false;

  let secret: string;
  try {
    secret = decryptServerSide(user.secretEnc);
  } catch {
    return false;
  }
  return verifyTotpToken(token, secret);
}

export async function storeTotpSecret(userId: number, secret: string): Promise<void> {
  await db
    .update(schema.users)
    .set({
      totpSecretEnc: encryptServerSide(secret),
      totpEnabledAt: new Date(),
      secondFactor: "totp",
      updatedAt: new Date(),
    })
    .where(eq(schema.users.id, userId));
}

// ── Güvenilen cihaz ("HWID") ────────────────────────────────

/**
 * Cihaz, sunucunun ürettiği challenge'ı kendi özel anahtarıyla imzalar.
 * Özel anahtar cihazdan çıkmaz (Android Keystore / non-extractable
 * CryptoKey), bu yüzden imza cihazın kendisini kanıtlar.
 *
 * Not: bu, tarayıcı "fingerprint"inden temelde farklı — fingerprint
 * tahmindir, bu kriptografik kanıttır.
 */
export function newChallenge(): string {
  return randomBytes(32).toString("base64url");
}

export function verifyDeviceSignature(
  challenge: string,
  signatureB64Url: string,
  publicKeyB64Url: string,
): boolean {
  try {
    const spki = Buffer.from(publicKeyB64Url, "base64url");
    const publicKey = {
      key: spki,
      format: "der" as const,
      type: "spki" as const,
    };

    const verifier = createVerify("SHA256");
    verifier.update(Buffer.from(challenge, "base64url"));
    verifier.end();

    return verifier.verify(publicKey, Buffer.from(signatureB64Url, "base64url"));
  } catch {
    return false;
  }
}

/** Kullanıcının onaylı, iptal edilmemiş cihazları. */
export async function activeDevices(userId: number) {
  return db
    .select()
    .from(schema.devices)
    .where(
      and(
        eq(schema.devices.userId, userId),
        isNull(schema.devices.revokedAt),
      ),
    );
}

export async function verifyUserDevice(
  userId: number,
  deviceId: number,
  challenge: string,
  signature: string,
): Promise<boolean> {
  const [device] = await db
    .select()
    .from(schema.devices)
    .where(and(eq(schema.devices.id, deviceId), eq(schema.devices.userId, userId)))
    .limit(1);

  if (!device) return false;
  // Onaylanmamış ya da iptal edilmiş cihaz ikinci faktör sayılmaz
  if (!device.approvedAt || device.revokedAt) return false;

  return verifyDeviceSignature(challenge, signature, device.publicKey);
}

// ── Kurtarma kodları ────────────────────────────────────────

/**
 * Tek kullanımlık. Doğruysa aynı işlemde "kullanıldı" işaretlenir —
 * yoksa aynı kod iki kez geçerdi.
 */
export async function consumeRecoveryCode(userId: number, code: string): Promise<boolean> {
  const hash = hashRecoveryCode(code);

  const updated = await db
    .update(schema.recoveryCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(schema.recoveryCodes.userId, userId),
        eq(schema.recoveryCodes.codeHash, hash),
        isNull(schema.recoveryCodes.usedAt),
      ),
    )
    .returning({ id: schema.recoveryCodes.id });

  return updated.length > 0;
}
