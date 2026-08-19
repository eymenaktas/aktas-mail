import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import type { AuthenticationExtensionsClientInputs } from "@simplewebauthn/server";

/**
 * PASSKEY — hem PC'de hem mobilde, parola sormadan giriş.
 *
 * Passkey tek başına kimliği kanıtlar ama posta parolasını vermez;
 * uygulamanın Dovecot'a bağlanmak için ona ihtiyacı var. Çözüm, WebAuthn'un
 * **PRF uzantısı**: passkey'den her seferinde AYNI gizli anahtar türetilir.
 *
 *   İlk giriş (bir kez parola yazılır)
 *     └─ passkey kaydedilir, PRF anahtarı türetilir
 *     └─ posta parolası o anahtarla sarmalanır → `wrappedSecret` olarak saklanır
 *
 *   Sonraki girişler (parola sorulmaz)
 *     └─ passkey doğrulanır → PRF aynı anahtarı verir
 *     └─ istemci sarmalı çözer → parola sunucuya gider → IMAP oturumu açılır
 *
 * Sunucu `wrappedSecret`i ÇÖZEMEZ; PRF anahtarı yalnızca authenticator'ın
 * içinde üretilir. Sunucu sızsa bile sarmal işe yaramaz.
 *
 * `wrappedSecret` istemcide değil sunucuda durur, çünkü passkey'ler iCloud
 * ve Google hesabıyla senkronlanıyor: aynı passkey yeni bir cihazda da
 * çalışmalı. İstemcide saklansaydı yeni cihaz çözemezdi.
 */

/** Relying Party — passkey'in bağlı olduğu alan adı. Origin'e bağlıdır, phishing'e kapalıdır. */
function rpID(): string {
  return new URL(env.APP_ORIGIN).hostname;
}

const RP_NAME = "Aktaş Mail";

// ── Kayıt ───────────────────────────────────────────────────

export async function passkeyRegistrationOptions(userId: number, email: string) {
  const existing = await db
    .select({ credentialId: schema.webauthnCredentials.credentialId })
    .from(schema.webauthnCredentials)
    .where(eq(schema.webauthnCredentials.userId, userId));

  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpID(),
    userName: email,
    userDisplayName: email,
    attestationType: "none",
    // Aynı authenticator'a ikinci kez kaydolmayı engelle
    excludeCredentials: existing.map((c) => ({ id: c.credentialId })),
    authenticatorSelection: {
      residentKey: "required", // discoverable: e-posta yazmadan giriş
      userVerification: "required", // biyometrik/PIN şart
    },
    // PRF uzantısı WebAuthn Level 3'te; TypeScript'in DOM tipleri henüz
    // içermiyor, o yüzden cast gerekiyor. Tarayıcı desteği var.
    extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
  });
}

export async function verifyPasskeyRegistration(params: {
  userId: number;
  response: Parameters<typeof verifyRegistrationResponse>[0]["response"];
  expectedChallenge: string;
  wrappedSecret: string | null;
  label?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;

  try {
    verification = await verifyRegistrationResponse({
      response: params.response,
      expectedChallenge: params.expectedChallenge,
      expectedOrigin: env.APP_ORIGIN,
      expectedRPID: rpID(),
      requireUserVerification: true,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Doğrulama hatası" };
  }

  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, error: "Passkey doğrulanamadı" };
  }

  const { credential } = verification.registrationInfo;

  await db.insert(schema.webauthnCredentials).values({
    userId: params.userId,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    transports: credential.transports ? JSON.stringify(credential.transports) : null,
    label: params.label ?? null,
    wrappedSecret: params.wrappedSecret,
  });

  // Passkey kurulduysa ikinci faktör artık passkey
  await db
    .update(schema.users)
    .set({ secondFactor: "passkey", updatedAt: new Date() })
    .where(eq(schema.users.id, params.userId));

  return { ok: true };
}

// ── Giriş ───────────────────────────────────────────────────

/**
 * E-posta İSTEMEZ: discoverable credential sayesinde kullanıcı
 * doğrudan passkey'iyle gelir.
 */
export async function passkeyAuthenticationOptions() {
  return generateAuthenticationOptions({
    rpID: rpID(),
    userVerification: "required",
    extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
  });
}

export async function verifyPasskeyAuthentication(params: {
  response: Parameters<typeof verifyAuthenticationResponse>[0]["response"];
  expectedChallenge: string;
}): Promise<
  | { ok: true; userId: number; email: string; wrappedSecret: string | null }
  | { ok: false; error: string }
> {
  const credentialId = params.response.id;

  const [row] = await db
    .select({
      id: schema.webauthnCredentials.id,
      userId: schema.webauthnCredentials.userId,
      publicKey: schema.webauthnCredentials.publicKey,
      counter: schema.webauthnCredentials.counter,
      transports: schema.webauthnCredentials.transports,
      wrappedSecret: schema.webauthnCredentials.wrappedSecret,
      email: schema.users.email,
      isActive: schema.users.isActive,
    })
    .from(schema.webauthnCredentials)
    .innerJoin(schema.users, eq(schema.users.id, schema.webauthnCredentials.userId))
    .where(eq(schema.webauthnCredentials.credentialId, credentialId))
    .limit(1);

  if (!row || !row.isActive) return { ok: false, error: "Passkey tanınmadı" };

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: params.response,
      expectedChallenge: params.expectedChallenge,
      expectedOrigin: env.APP_ORIGIN,
      expectedRPID: rpID(),
      requireUserVerification: true,
      credential: {
        id: credentialId,
        publicKey: new Uint8Array(Buffer.from(row.publicKey, "base64url")),
        counter: row.counter,
        transports: row.transports ? JSON.parse(row.transports) : undefined,
      },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Doğrulama hatası" };
  }

  if (!verification.verified) return { ok: false, error: "Passkey doğrulanamadı" };

  /**
   * Sayaç klonlanmış authenticator'ı yakalar: sayaç geri gitmişse
   * aynı passkey'in kopyası kullanılıyor demektir.
   * (Bazı platform authenticator'ları sayacı hep 0 tutar — o durumda
   * bu kontrol devre dışı kalır, WebAuthn spesifikasyonu böyle diyor.)
   */
  const newCounter = verification.authenticationInfo.newCounter;
  if (row.counter > 0 && newCounter <= row.counter) {
    return { ok: false, error: "Passkey sayacı geçersiz — klonlanmış olabilir" };
  }

  await db
    .update(schema.webauthnCredentials)
    .set({ counter: newCounter, lastUsedAt: new Date() })
    .where(eq(schema.webauthnCredentials.id, row.id));

  return {
    ok: true,
    userId: row.userId,
    email: row.email,
    wrappedSecret: row.wrappedSecret,
  };
}

/** Kullanıcı parolasını değiştirdiğinde sarmallar yenilenmeli. */
export async function updateWrappedSecret(
  userId: number,
  credentialId: string,
  wrappedSecret: string,
): Promise<void> {
  await db
    .update(schema.webauthnCredentials)
    .set({ wrappedSecret })
    .where(
      and(
        eq(schema.webauthnCredentials.userId, userId),
        eq(schema.webauthnCredentials.credentialId, credentialId),
      ),
    );
}

export async function listPasskeys(userId: number) {
  return db
    .select({
      id: schema.webauthnCredentials.id,
      label: schema.webauthnCredentials.label,
      createdAt: schema.webauthnCredentials.createdAt,
      lastUsedAt: schema.webauthnCredentials.lastUsedAt,
      hasWrappedSecret: schema.webauthnCredentials.wrappedSecret,
    })
    .from(schema.webauthnCredentials)
    .where(eq(schema.webauthnCredentials.userId, userId));
}
