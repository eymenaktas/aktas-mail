import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { env, isProd, mailDomains } from "../env.js";
import { verifyCredentials } from "../mail/imap.js";
import { packSessionCookie, unpackSessionCookie, newSessionKey } from "../lib/crypto.js";
import {
  createPendingLogin,
  readPendingLogin,
  discardPendingLogin,
  issueSession,
  rotateRefreshToken,
  revokeSession,
  loadSession,
} from "../auth/session.js";
import {
  verifyUserTotp,
  verifyUserDevice,
  consumeRecoveryCode,
  activeDevices,
} from "../auth/twofactor.js";
import { audit } from "../lib/audit.js";

const SESSION_COOKIE = "am_session";
const REFRESH_COOKIE = "am_refresh";
const PENDING_COOKIE = "am_pending";

const cookieBase = {
  httpOnly: true, // JS okuyamaz — XSS'te token çalınamaz
  secure: isProd,
  sameSite: "strict" as const, // CSRF'e karşı
  path: "/",
};

function clientIp(req: FastifyRequest): string | null {
  return req.ip || null;
}

/** Uygulama yalnızca kendi alan adının posta kutularına açık. */
function ayniAlanAdi(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  return domain !== undefined && mailDomains.includes(domain);
}

export { ayniAlanAdi };

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 1. AŞAMA — parola.
   * Doğrulamayı Dovecot yapar; uygulamanın kendi parolası yok.
   */
  app.post(
    "/api/auth/login",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "10 minutes" },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          email: z.string().email().max(254),
          password: z.string().min(1).max(512),
        })
        .safeParse(req.body);

      if (!body.success) {
        return reply.code(400).send({ error: "Geçersiz istek" });
      }

      const email = body.data.email.toLowerCase().trim();
      const ip = clientIp(req);

      // Yalnızca kendi alan adımızın kutuları. Dovecot zaten başkasını
      // doğrulamaz, ama açıkça reddetmek daha net bir hata veriyor ve
      // ileride başka alan adı eklenirse uygulama yanlışlıkla ona da
      // açılmıyor.
      if (!ayniAlanAdi(email)) {
        await audit({ action: "login.wrong_domain", detail: email, ip });
        return reply.code(401).send({ error: "E-posta veya parola hatalı" });
      }

      // Dovecot'a bağlanabiliyorsak parola doğru
      const ok = await verifyCredentials({ user: email, pass: body.data.password });
      if (!ok) {
        await audit({ action: "login.fail", detail: email, ip });
        // Hesabın var olup olmadığını sızdırmayan tek tip cevap
        return reply.code(401).send({ error: "E-posta veya parola hatalı" });
      }

      // Kullanıcı kaydı yoksa ilk girişte oluştur (tek kullanıcılı ilk sürüm)
      let [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1);

      if (!user) {
        [user] = await db
          .insert(schema.users)
          .values({ email, displayName: email.split("@")[0] ?? email })
          .returning();
      }
      if (!user || !user.isActive) {
        return reply.code(403).send({ error: "Hesap devre dışı" });
      }

      /**
       * Parola doğru. İkinci faktör yalnızca TOTP ya da güvenilen cihaz
       * kurulmuşsa istenir.
       *
       * `passkey` burada ikinci faktör SAYILMAZ — o ayrı bir giriş yolu
       * (parolasız). Passkey kurmak parolayla girişi kilitlememelidir;
       * zaten kilitlese bile aynı parola Dovecot'ta doğrudan çalışıyor,
       * yani kullanıcıyı engellerdi ama saldırganı engellemezdi.
       */
      const ikinciFaktorGerek =
        user.secondFactor === "totp" || user.secondFactor === "device";

      if (!ikinciFaktorGerek) {
        const { sessionId, sessionKey, refreshToken } = await issueSession({
          userId: user.id,
          deviceId: null,
          imapPassword: body.data.password,
          sessionKey: newSessionKey(),
          ip,
        });

        reply.setCookie(SESSION_COOKIE, packSessionCookie(sessionId, sessionKey), cookieBase);
        reply.setCookie(REFRESH_COOKIE, refreshToken, cookieBase);

        await audit({
          userId: user.id,
          action: "login.ok",
          detail: user.secondFactor === "passkey" ? "parola (passkey de kurulu)" : "parola",
          ip,
        });
        return reply.send({
          status: "ok",
          user: { email: user.email, displayName: user.displayName },
        });
      }

      // İkinci faktör bekleniyor
      const { pendingId, sessionKey, challenge } = await createPendingLogin(
        user.id,
        body.data.password,
        ip,
      );

      reply.setCookie(PENDING_COOKIE, packSessionCookie(pendingId, sessionKey), {
        ...cookieBase,
        maxAge: 300,
      });

      const devices =
        user.secondFactor === "device"
          ? (await activeDevices(user.id))
              .filter((d) => d.approvedAt)
              .map((d) => ({ id: d.id, label: d.label, platform: d.platform }))
          : [];

      await audit({ userId: user.id, action: "login.password_ok", ip });

      return reply.send({
        status: "2fa_required",
        method: user.secondFactor,
        // device yöntemi için: cihazın imzalayacağı challenge
        ...(user.secondFactor === "device" ? { challenge, devices } : {}),
      });
    },
  );

  /**
   * 2. AŞAMA — ikinci faktör.
   * TOTP, passkey, güvenilen cihaz ya da kurtarma kodu.
   */
  app.post(
    "/api/auth/login/2fa",
    {
      config: {
        rateLimit: { max: 10, timeWindow: "10 minutes" },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .discriminatedUnion("method", [
          z.object({ method: z.literal("totp"), token: z.string().max(16) }),
          z.object({
            method: z.literal("device"),
            deviceId: z.number().int().positive(),
            signature: z.string().max(2048),
          }),
          z.object({ method: z.literal("recovery"), code: z.string().max(64) }),
        ])
        .safeParse(req.body);

      if (!body.success) return reply.code(400).send({ error: "Geçersiz istek" });

      const cookie = req.cookies[PENDING_COOKIE];
      const unpacked = cookie ? unpackSessionCookie(cookie) : null;
      if (!unpacked) return reply.code(401).send({ error: "Giriş oturumu bulunamadı" });

      const pending = await readPendingLogin(unpacked.sessionId, unpacked.sessionKey);
      if (!pending) return reply.code(401).send({ error: "Giriş oturumu süresi doldu" });

      const ip = clientIp(req);
      let passed = false;
      let deviceId: number | null = null;

      if (body.data.method === "totp") {
        passed = await verifyUserTotp(pending.userId, body.data.token);
      } else if (body.data.method === "device") {
        if (!pending.challenge) return reply.code(400).send({ error: "Challenge yok" });
        passed = await verifyUserDevice(
          pending.userId,
          body.data.deviceId,
          pending.challenge,
          body.data.signature,
        );
        if (passed) deviceId = body.data.deviceId;
      } else {
        passed = await consumeRecoveryCode(pending.userId, body.data.code);
      }

      if (!passed) {
        await audit({
          userId: pending.userId,
          action: "2fa.fail",
          detail: body.data.method,
          ip,
        });
        return reply.code(401).send({ error: "Doğrulama başarısız" });
      }

      // Parola akışında buraya parolasız gelinmez; passkey akışı ayrı
      // uçta (routes/passkey.ts) ilerliyor.
      if (pending.imapPassword === null) {
        return reply.code(400).send({ error: "Bu giriş akışı parola içermiyor" });
      }

      await discardPendingLogin(unpacked.sessionId);

      const { sessionId, sessionKey, refreshToken } = await issueSession({
        userId: pending.userId,
        deviceId,
        imapPassword: pending.imapPassword,
        // Aynı anahtarı devral: parolayı yeniden şifrelemek gerekmiyor
        sessionKey: unpacked.sessionKey,
        ip,
      });

      reply.clearCookie(PENDING_COOKIE, cookieBase);
      reply.setCookie(SESSION_COOKIE, packSessionCookie(sessionId, sessionKey), cookieBase);
      reply.setCookie(REFRESH_COOKIE, refreshToken, cookieBase);

      await audit({
        userId: pending.userId,
        action: "2fa.ok",
        detail: body.data.method,
        ip,
      });

      return reply.send({ status: "ok" });
    },
  );

  /**
   * Oturum yenileme. Mobilde "çıkış yapana kadar açık kal" bununla olur:
   * uygulama her açıldığında token döner, süre baştan başlar.
   */
  app.post("/api/auth/refresh", async (req: FastifyRequest, reply: FastifyReply) => {
    const sessionCookie = req.cookies[SESSION_COOKIE];
    const refreshToken = req.cookies[REFRESH_COOKIE];
    const unpacked = sessionCookie ? unpackSessionCookie(sessionCookie) : null;

    if (!unpacked || !refreshToken) {
      return reply.code(401).send({ error: "Oturum yok" });
    }

    const result = await rotateRefreshToken({
      sessionId: unpacked.sessionId,
      sessionKey: unpacked.sessionKey,
      refreshToken,
      ip: clientIp(req),
    });

    if ("error" in result) {
      reply.clearCookie(SESSION_COOKIE, cookieBase);
      reply.clearCookie(REFRESH_COOKIE, cookieBase);

      if (result.error === "reuse") {
        return reply.code(401).send({
          error: "Güvenlik nedeniyle tüm oturumlar kapatıldı. Lütfen tekrar giriş yapın.",
        });
      }
      return reply.code(401).send({ error: "Oturum geçersiz" });
    }

    reply.setCookie(
      SESSION_COOKIE,
      packSessionCookie(result.sessionId, result.sessionKey),
      cookieBase,
    );
    reply.setCookie(REFRESH_COOKIE, result.refreshToken, cookieBase);

    return reply.send({ status: "ok", expiresAt: result.expiresAt.toISOString() });
  });

  app.post("/api/auth/logout", async (req: FastifyRequest, reply: FastifyReply) => {
    const sessionCookie = req.cookies[SESSION_COOKIE];
    const unpacked = sessionCookie ? unpackSessionCookie(sessionCookie) : null;

    if (unpacked) {
      await revokeSession(unpacked.sessionId);
      await audit({ action: "logout", ip: clientIp(req) });
    }

    reply.clearCookie(SESSION_COOKIE, cookieBase);
    reply.clearCookie(REFRESH_COOKIE, cookieBase);
    return reply.send({ status: "ok" });
  });

  /**
   * Yeniden kimlik doğrulama — passkey eklemeden önce.
   *
   * Passkey kaydında istemci posta parolasını PRF anahtarıyla sarmalıyor.
   * Parola YANLIŞ girilirse sarmal da yanlış olur ve bozukluk ancak bir
   * sonraki parolasız girişte, anlamsız bir hatayla ortaya çıkar.
   * Burada Dovecot'a sorup baştan doğruluyoruz.
   */
  app.post(
    "/api/auth/verify-password",
    { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const cookie = req.cookies[SESSION_COOKIE];
      const un = cookie ? unpackSessionCookie(cookie) : null;
      if (!un) return reply.code(401).send({ error: "Oturum yok" });

      const session = await loadSession(un.sessionId, un.sessionKey);
      if (!session) return reply.code(401).send({ error: "Oturum geçersiz" });

      const body = z.object({ password: z.string().min(1).max(512) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "Geçersiz istek" });

      const ok = await verifyCredentials({
        user: session.email,
        pass: body.data.password,
      });

      await audit({
        userId: session.userId,
        action: ok ? "reauth.ok" : "reauth.fail",
        ip: clientIp(req),
      });

      if (!ok) return reply.code(401).send({ error: "Parola hatalı" });
      return reply.send({ status: "ok" });
    },
  );

  app.get("/api/auth/me", async (req: FastifyRequest, reply: FastifyReply) => {
    const sessionCookie = req.cookies[SESSION_COOKIE];
    const unpacked = sessionCookie ? unpackSessionCookie(sessionCookie) : null;
    if (!unpacked) return reply.code(401).send({ error: "Oturum yok" });

    const session = await loadSession(unpacked.sessionId, unpacked.sessionKey);
    if (!session) return reply.code(401).send({ error: "Oturum geçersiz" });

    const [user] = await db
      .select({
        email: schema.users.email,
        displayName: schema.users.displayName,
        secondFactor: schema.users.secondFactor,
      })
      .from(schema.users)
      .where(eq(schema.users.id, session.userId))
      .limit(1);

    return reply.send({
      user,
      domain: env.MAIL_DOMAIN,
      domains: mailDomains,
      isAdmin: session.email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase(),
    });
  });
}

export { SESSION_COOKIE, REFRESH_COOKIE, cookieBase };
