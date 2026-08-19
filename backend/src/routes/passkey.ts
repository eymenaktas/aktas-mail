import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import {
  passkeyRegistrationOptions,
  verifyPasskeyRegistration,
  passkeyAuthenticationOptions,
  verifyPasskeyAuthentication,
  listPasskeys,
} from "../auth/passkey.js";
import {
  createPendingLogin,
  readPendingLogin,
  discardPendingLogin,
  issueSession,
  loadSession,
} from "../auth/session.js";
import { verifyCredentials } from "../mail/imap.js";
import { packSessionCookie, unpackSessionCookie, newSessionKey } from "../lib/crypto.js";
import { audit } from "../lib/audit.js";
import { SESSION_COOKIE, REFRESH_COOKIE, cookieBase } from "./auth.js";

/**
 * PAROLASIZ GİRİŞ — PC ve mobilde aynı akış.
 *
 *   1. /passkey/login/options   → challenge (e-posta sorulmaz)
 *   2. /passkey/login/verify    → passkey doğrulanır, sarmal geri döner
 *   3. istemci PRF ile sarmalı çözer
 *   4. /passkey/login/complete  → çözülen parola gelir, oturum açılır
 *
 * Kullanıcı hiçbir adımda parola YAZMAZ. Sunucu sarmalı çözemez;
 * PRF anahtarı yalnızca authenticator'ın içinde üretilir.
 *
 * TEK İSTİSNA: en baştaki ilk giriş. Sunucunun Dovecot'a bağlanmak için
 * parolayı bir kez öğrenmesi gerekiyor — o an sarmal da oluşturuluyor.
 */

const WA_CHALLENGE_COOKIE = "am_wa_challenge";
const PASSKEY_PENDING_COOKIE = "am_pk_pending";

/** Challenge kısa ömürlü ve imzalı çerezde: DB'ye satır açmaya değmez. */
const challengeCookie = { ...cookieBase, maxAge: 120, signed: true };

export async function passkeyRoutes(app: FastifyInstance): Promise<void> {
  // ── Giriş ─────────────────────────────────────────────────

  app.post(
    "/api/auth/passkey/login/options",
    { config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const options = await passkeyAuthenticationOptions();
      reply.setCookie(WA_CHALLENGE_COOKIE, options.challenge, challengeCookie);
      return reply.send(options);
    },
  );

  app.post(
    "/api/auth/passkey/login/verify",
    { config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const signed = req.cookies[WA_CHALLENGE_COOKIE];
      const unsigned = signed ? req.unsignCookie(signed) : null;
      if (!unsigned?.valid || !unsigned.value) {
        return reply.code(400).send({ error: "Challenge bulunamadı veya süresi doldu" });
      }

      const body = z.object({ response: z.any() }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "Geçersiz istek" });

      const result = await verifyPasskeyAuthentication({
        response: body.data.response,
        expectedChallenge: unsigned.value,
      });

      reply.clearCookie(WA_CHALLENGE_COOKIE, cookieBase);

      if (!result.ok) {
        await audit({ action: "passkey.fail", detail: result.error, ip: req.ip });
        return reply.code(401).send({ error: "Passkey doğrulanamadı" });
      }

      // Passkey doğrulandı; parolayı çözmek için kısa ömürlü bir aşama aç
      const { pendingId, sessionKey } = await createPendingLogin(
        result.userId,
        null, // parola henüz yok — istemci sarmalı çözüp gönderecek
        req.ip,
        { passkeyVerified: true },
      );

      reply.setCookie(PASSKEY_PENDING_COOKIE, packSessionCookie(pendingId, sessionKey), {
        ...cookieBase,
        maxAge: 300,
      });

      await audit({ userId: result.userId, action: "passkey.ok", ip: req.ip });

      if (!result.wrappedSecret) {
        // Bu passkey için sarmal yok (eski kayıt ya da PRF desteklenmiyordu)
        return reply.send({
          status: "password_required",
          email: result.email,
          reason: "Bu passkey için kayıtlı sarmal yok, parola bir kez gerekiyor",
        });
      }

      return reply.send({
        status: "unwrap",
        email: result.email,
        // İstemci bunu PRF anahtarıyla çözecek — sunucu çözemez
        wrappedSecret: result.wrappedSecret,
      });
    },
  );

  /** İstemci sarmalı çözdü (ya da ilk kez parola giriyor) → oturum aç. */
  app.post(
    "/api/auth/passkey/login/complete",
    { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({ password: z.string().min(1).max(512) })
        .safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "Geçersiz istek" });

      const cookie = req.cookies[PASSKEY_PENDING_COOKIE];
      const unpacked = cookie ? unpackSessionCookie(cookie) : null;
      if (!unpacked) return reply.code(401).send({ error: "Giriş oturumu bulunamadı" });

      const pending = await readPendingLogin(unpacked.sessionId, unpacked.sessionKey);
      if (!pending) return reply.code(401).send({ error: "Giriş oturumu süresi doldu" });

      // Passkey adımı gerçekten geçilmiş olmalı — yoksa bu uç parola
      // denemek için serbest bir kapı olurdu
      if (!pending.passkeyVerified) {
        return reply.code(401).send({ error: "Passkey doğrulaması yapılmamış" });
      }

      const [user] = await db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          displayName: schema.users.displayName,
        })
        .from(schema.users)
        .where(eq(schema.users.id, pending.userId))
        .limit(1);

      if (!user) return reply.code(401).send({ error: "Kullanıcı bulunamadı" });

      // Çözülen parola gerçekten doğru mu? Dovecot söyler.
      const ok = await verifyCredentials({ user: user.email, pass: body.data.password });
      if (!ok) {
        await audit({ userId: user.id, action: "passkey.unwrap_fail", ip: req.ip });
        return reply.code(401).send({ error: "Parola doğrulanamadı" });
      }

      await discardPendingLogin(unpacked.sessionId);

      const sessionKey = newSessionKey();
      const { sessionId, refreshToken } = await issueSession({
        userId: user.id,
        deviceId: null,
        imapPassword: body.data.password,
        sessionKey,
        ip: req.ip,
      });

      reply.clearCookie(PASSKEY_PENDING_COOKIE, cookieBase);
      reply.setCookie(SESSION_COOKIE, packSessionCookie(sessionId, sessionKey), cookieBase);
      reply.setCookie(REFRESH_COOKIE, refreshToken, cookieBase);

      await audit({ userId: user.id, action: "login.ok", detail: "passkey", ip: req.ip });

      return reply.send({
        status: "ok",
        user: { email: user.email, displayName: user.displayName },
      });
    },
  );

  // ── Kayıt (oturum açıkken) ────────────────────────────────

  app.post("/api/auth/passkey/register/options", async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const options = await passkeyRegistrationOptions(session.userId, session.email);
    reply.setCookie(WA_CHALLENGE_COOKIE, options.challenge, challengeCookie);
    return reply.send(options);
  });

  app.post("/api/auth/passkey/register/verify", async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const signed = req.cookies[WA_CHALLENGE_COOKIE];
    const unsigned = signed ? req.unsignCookie(signed) : null;
    if (!unsigned?.valid || !unsigned.value) {
      return reply.code(400).send({ error: "Challenge bulunamadı" });
    }

    const body = z
      .object({
        response: z.any(),
        /**
         * İstemcinin PRF anahtarıyla sarmaladığı posta parolası.
         * Sunucu çözemez, sadece saklar.
         */
        wrappedSecret: z.string().max(4096).nullable().default(null),
        label: z.string().max(120).optional(),
      })
      .safeParse(req.body);

    if (!body.success) return reply.code(400).send({ error: "Geçersiz istek" });

    const result = await verifyPasskeyRegistration({
      userId: session.userId,
      response: body.data.response,
      expectedChallenge: unsigned.value,
      wrappedSecret: body.data.wrappedSecret,
      ...(body.data.label ? { label: body.data.label } : {}),
    });

    reply.clearCookie(WA_CHALLENGE_COOKIE, cookieBase);

    if (!result.ok) return reply.code(400).send({ error: result.error });

    await audit({
      userId: session.userId,
      action: "passkey.registered",
      detail: body.data.wrappedSecret ? "sarmal ile (parolasız giriş açık)" : "sarmal yok",
      ip: req.ip,
    });

    return reply.send({
      status: "ok",
      passwordlessLogin: body.data.wrappedSecret !== null,
    });
  });

  app.get("/api/auth/passkeys", async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const rows = await listPasskeys(session.userId);
    return reply.send({
      passkeys: rows.map((r) => ({
        id: r.id,
        label: r.label,
        createdAt: r.createdAt,
        lastUsedAt: r.lastUsedAt,
        // Sarmalın kendisi sızdırılmaz, sadece var mı bilgisi
        passwordlessLogin: r.hasWrappedSecret !== null,
      })),
    });
  });
}

async function requireSession(req: FastifyRequest, reply: FastifyReply) {
  const cookie = req.cookies[SESSION_COOKIE];
  const unpacked = cookie ? unpackSessionCookie(cookie) : null;
  if (!unpacked) {
    reply.code(401).send({ error: "Oturum yok" });
    return null;
  }
  const session = await loadSession(unpacked.sessionId, unpacked.sessionKey);
  if (!session) {
    reply.code(401).send({ error: "Oturum geçersiz" });
    return null;
  }
  return session;
}
