import { eq, and, isNull, inArray, lt } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import {
  randomToken,
  newSessionKey,
  sha256,
  encrypt,
  decrypt,
} from "../lib/crypto.js";
import { audit } from "../lib/audit.js";

/**
 * Oturum ömrü.
 * "Çıkış yapana kadar hatırla" davranışı sürenin KAYMASINDAN geliyor:
 * uygulama her açıldığında (`/api/auth/me`) süre baştan başlar, yani
 * 30 gün hiç açılmayan oturum düşer, kullanılan oturum düşmez.
 */
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 gün
/** Süre bundan sık uzatılmaz — her istekte DB'ye yazmamak için. */
const UZATMA_ARALIGI_MS = 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 5 * 60 * 1000; // 5 dakika

export interface IssuedSession {
  sessionId: string;
  sessionKey: string;
  refreshToken: string;
  expiresAt: Date;
  remember: boolean;
}

/** Parola doğrulandı, ikinci faktör bekleniyor. */
export async function createPendingLogin(
  userId: number,
  imapPassword: string | null,
  ip: string | null,
  opts: { passkeyVerified?: boolean } = {},
): Promise<{ pendingId: string; sessionKey: string; challenge: string }> {
  const pendingId = randomToken(24);
  const sessionKey = newSessionKey();
  const challenge = randomToken(32);

  await db.insert(schema.pendingLogins).values({
    id: pendingId,
    userId,
    // Passkey akışında parola henüz bilinmiyor: istemci sarmalı
    // çözdükten sonra ikinci adımda gönderiyor.
    imapPasswordEnc: imapPassword === null ? null : encrypt(imapPassword, sessionKey),
    challenge,
    passkeyVerified: opts.passkeyVerified ?? false,
    expiresAt: new Date(Date.now() + PENDING_TTL_MS),
    createdIp: ip,
  });

  return { pendingId, sessionKey, challenge };
}

export async function readPendingLogin(
  pendingId: string,
  sessionKey: string,
): Promise<{
  userId: number;
  imapPassword: string | null;
  challenge: string | null;
  passkeyVerified: boolean;
} | null> {
  const [row] = await db
    .select()
    .from(schema.pendingLogins)
    .where(eq(schema.pendingLogins.id, pendingId))
    .limit(1);

  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(schema.pendingLogins).where(eq(schema.pendingLogins.id, pendingId));
    return null;
  }

  try {
    return {
      userId: row.userId,
      imapPassword:
        row.imapPasswordEnc === null ? null : decrypt(row.imapPasswordEnc, sessionKey),
      challenge: row.challenge,
      passkeyVerified: row.passkeyVerified,
    };
  } catch {
    // Anahtar yanlış → çerez kurcalanmış
    return null;
  }
}

export async function discardPendingLogin(pendingId: string): Promise<void> {
  await db.delete(schema.pendingLogins).where(eq(schema.pendingLogins.id, pendingId));
}

/** İkinci faktör de geçildi → gerçek oturum. */
export async function issueSession(params: {
  userId: number;
  deviceId: number | null;
  imapPassword: string;
  sessionKey: string;
  ip: string | null;
  previousId?: string;
  remember?: boolean;
}): Promise<IssuedSession> {
  const sessionId = randomToken(24);
  const refreshToken = randomToken(32);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
  const remember = params.remember ?? true;

  await db.insert(schema.sessions).values({
    id: sessionId,
    userId: params.userId,
    deviceId: params.deviceId,
    imapPasswordEnc: encrypt(params.imapPassword, params.sessionKey),
    refreshTokenHash: sha256(refreshToken),
    previousId: params.previousId ?? null,
    remember,
    expiresAt,
    createdIp: params.ip,
  });

  return { sessionId, sessionKey: params.sessionKey, refreshToken, expiresAt, remember };
}

/** Aktif oturumu ve çözülmüş IMAP parolasını getirir. */
export async function loadSession(
  sessionId: string,
  sessionKey: string,
): Promise<{
  userId: number;
  email: string;
  displayName: string | null;
  imapPassword: string;
  remember: boolean;
  expiresAt: Date;
} | null> {
  const [row] = await db
    .select({
      userId: schema.sessions.userId,
      email: schema.users.email,
      displayName: schema.users.displayName,
      remember: schema.sessions.remember,
      imapPasswordEnc: schema.sessions.imapPasswordEnc,
      expiresAt: schema.sessions.expiresAt,
      revokedAt: schema.sessions.revokedAt,
      isActive: schema.users.isActive,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(eq(schema.sessions.id, sessionId))
    .limit(1);

  if (!row || row.revokedAt || !row.isActive) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;

  try {
    return {
      userId: row.userId,
      email: row.email,
      displayName: row.displayName,
      imapPassword: decrypt(row.imapPasswordEnc, sessionKey),
      remember: row.remember,
      expiresAt: row.expiresAt,
    };
  } catch {
    return null;
  }
}

/**
 * Refresh rotasyonu + REUSE DETECTION.
 *
 * Bir refresh token yalnızca bir kez kullanılabilir. İkinci kez
 * geldiyse token çalınmış demektir: o kullanıcının TÜM oturumları
 * kapatılır. Kullanıcı yeniden giriş yapmak zorunda kalır — ama
 * saldırgan da atılmış olur.
 */
export async function rotateRefreshToken(params: {
  sessionId: string;
  sessionKey: string;
  refreshToken: string;
  ip: string | null;
}): Promise<IssuedSession | { error: "reuse" | "invalid" }> {
  const [row] = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, params.sessionId))
    .limit(1);

  if (!row || row.revokedAt) return { error: "invalid" };
  if (row.refreshTokenHash !== sha256(params.refreshToken)) return { error: "invalid" };

  if (row.usedAt) {
    // Bu token daha önce kullanılmış → hırsızlık
    await revokeAllSessions(row.userId);
    await audit({
      userId: row.userId,
      action: "session.reuse_detected",
      detail: `oturum ${params.sessionId} — tüm oturumlar kapatıldı`,
      ip: params.ip,
    });
    return { error: "reuse" };
  }

  if (row.expiresAt.getTime() < Date.now()) return { error: "invalid" };

  let imapPassword: string;
  try {
    imapPassword = decrypt(row.imapPasswordEnc, params.sessionKey);
  } catch {
    return { error: "invalid" };
  }

  // Eskisini "kullanıldı" işaretle, yerine yenisini ver
  await db
    .update(schema.sessions)
    .set({ usedAt: new Date(), revokedAt: new Date() })
    .where(eq(schema.sessions.id, params.sessionId));

  return issueSession({
    userId: row.userId,
    deviceId: row.deviceId,
    imapPassword,
    sessionKey: params.sessionKey,
    ip: params.ip,
    previousId: params.sessionId,
    remember: row.remember,
  });
}

/**
 * Hatırlanan oturumların süresini baştan başlatır.
 * Yalnızca son uzatmanın üstünden bir gün geçmişse yazar.
 */
export async function extendSessions(sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  const now = Date.now();
  await db
    .update(schema.sessions)
    .set({ expiresAt: new Date(now + REFRESH_TTL_MS) })
    .where(
      and(
        inArray(schema.sessions.id, sessionIds),
        eq(schema.sessions.remember, true),
        isNull(schema.sessions.revokedAt),
        lt(schema.sessions.expiresAt, new Date(now + REFRESH_TTL_MS - UZATMA_ARALIGI_MS)),
      ),
    );
}

export async function revokeSession(sessionId: string): Promise<void> {
  await db
    .update(schema.sessions)
    .set({ revokedAt: new Date() })
    .where(eq(schema.sessions.id, sessionId));
}

export async function revokeAllSessions(userId: number): Promise<void> {
  await db
    .update(schema.sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)));
}

/** Süresi geçmiş kayıtları temizler (periyodik iş). */
export async function pruneExpired(): Promise<void> {
  const now = new Date();
  await db.delete(schema.pendingLogins).where(eq(schema.pendingLogins.expiresAt, now));
}
