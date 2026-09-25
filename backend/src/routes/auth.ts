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
  extendSessions,
  REFRESH_TTL_MS,
  type IssuedSession,
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
/**
 * Aynı tarayıcıda açık DİĞER hesaplar. Etkin hesap her zaman
 * `am_session`'da; geçiş yapınca ikisi yer değiştiriyor. Böylece
 * oturum okuyan diğer uçların hiçbiri çoklu hesaptan haberdar olmak
 * zorunda kalmıyor.
 */
const ACCOUNTS_COOKIE = "am_hesaplar";
/** Bir tarayıcıda en fazla bu kadar hesap — çerez 4 KB'ı aşmasın. */
const EN_FAZLA_HESAP = 6;

const cookieBase = {
  httpOnly: true, // JS okuyamaz — XSS'te token çalınamaz
  secure: isProd,
  sameSite: "strict" as const, // CSRF'e karşı
  path: "/",
};

function clientIp(req: FastifyRequest): string | null {
  return req.ip || null;
}

/** Çerezde duran bir oturum: `id.anahtar`, refresh token, hatırla bayrağı. */
interface CerezOturum {
  packed: string;
  refresh: string;
  remember: boolean;
}

type CozulmusOturum = CerezOturum & {
  sessionId: string;
  session: NonNullable<Awaited<ReturnType<typeof loadSession>>>;
};

/**
 * Hatırlanan oturumun çerezi kalıcı: `maxAge` yoksa tarayıcı çerezi
 * kapanışta siliyordu ve telefonda uygulama her kapandığında oturum
 * düşüyordu (sunucudaki kayıt 30 gün geçerli olduğu hâlde).
 */
function cerezSecenek(remember: boolean) {
  return remember ? { ...cookieBase, maxAge: REFRESH_TTL_MS / 1000 } : cookieBase;
}

function aktifYaz(reply: FastifyReply, o: CerezOturum): void {
  reply.setCookie(SESSION_COOKIE, o.packed, cerezSecenek(o.remember));
  reply.setCookie(REFRESH_COOKIE, o.refresh, cerezSecenek(o.remember));
}

function digerleriniYaz(reply: FastifyReply, liste: CerezOturum[]): void {
  if (liste.length === 0) {
    reply.clearCookie(ACCOUNTS_COOKIE, cookieBase);
    return;
  }
  const deger = liste.map((o) => `${o.packed}~${o.refresh}~${o.remember ? 1 : 0}`).join(",");
  reply.setCookie(ACCOUNTS_COOKIE, deger, cerezSecenek(liste.some((o) => o.remember)));
}

function digerleriniOku(req: FastifyRequest): CerezOturum[] {
  const ham = req.cookies[ACCOUNTS_COOKIE];
  if (!ham) return [];
  return ham
    .split(",")
    .map((parca) => parca.split("~"))
    .filter((p): p is [string, string, string] => p.length === 3 && !!p[0] && !!p[1])
    .map(([packed, refresh, r]) => ({ packed, refresh, remember: r === "1" }))
    .slice(0, EN_FAZLA_HESAP);
}

async function coz(o: Omit<CerezOturum, "remember">): Promise<CozulmusOturum | null> {
  const un = unpackSessionCookie(o.packed);
  if (!un) return null;
  const session = await loadSession(un.sessionId, un.sessionKey);
  if (!session) return null;
  return { ...o, remember: session.remember, sessionId: un.sessionId, session };
}

/** Etkin hesap + diğerleri, geçersiz olanlar ayıklanmış. */
async function hesaplariCoz(req: FastifyRequest): Promise<{
  aktif: CozulmusOturum | null;
  digerleri: CozulmusOturum[];
}> {
  const packed = req.cookies[SESSION_COOKIE];
  const refresh = req.cookies[REFRESH_COOKIE] ?? "";
  const aktif = packed ? await coz({ packed, refresh }) : null;
  const digerleri = (await Promise.all(digerleriniOku(req).map(coz))).filter(
    (o): o is CozulmusOturum =>
      o !== null && o.sessionId !== aktif?.sessionId && o.session.userId !== aktif?.session.userId,
  );
  return { aktif, digerleri };
}

/**
 * Yeni oturumu etkin yapar. Tarayıcıda açık olan önceki hesap
 * kapatılmıyor, "diğer hesaplar"a geçiyor — aynı anda birden fazla
 * hesap açık kalabiliyor. Aynı hesabın eski oturumu varsa o kapatılıyor.
 */
async function oturumuYerlestir(
  req: FastifyRequest,
  reply: FastifyReply,
  userId: number,
  yeni: IssuedSession,
): Promise<void> {
  const { aktif, digerleri } = await hesaplariCoz(req);
  const eskiler = [...(aktif ? [aktif] : []), ...digerleri];

  const ayniHesap = eskiler.filter((o) => o.session.userId === userId);
  await Promise.all(ayniHesap.map((o) => revokeSession(o.sessionId)));

  aktifYaz(reply, {
    packed: packSessionCookie(yeni.sessionId, yeni.sessionKey),
    refresh: yeni.refreshToken,
    remember: yeni.remember,
  });
  digerleriniYaz(
    reply,
    eskiler.filter((o) => o.session.userId !== userId).slice(0, EN_FAZLA_HESAP - 1),
  );
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
          remember: z.boolean().default(true),
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
        const yeni = await issueSession({
          userId: user.id,
          deviceId: null,
          imapPassword: body.data.password,
          sessionKey: newSessionKey(),
          ip,
          remember: body.data.remember,
        });
        await oturumuYerlestir(req, reply, user.id, yeni);

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
          z.object({
            method: z.literal("totp"),
            token: z.string().max(16),
            remember: z.boolean().default(true),
          }),
          z.object({
            method: z.literal("device"),
            deviceId: z.number().int().positive(),
            signature: z.string().max(2048),
            remember: z.boolean().default(true),
          }),
          z.object({
            method: z.literal("recovery"),
            code: z.string().max(64),
            remember: z.boolean().default(true),
          }),
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

      const yeni = await issueSession({
        userId: pending.userId,
        deviceId,
        imapPassword: pending.imapPassword,
        // Aynı anahtarı devral: parolayı yeniden şifrelemek gerekmiyor
        sessionKey: unpacked.sessionKey,
        ip,
        remember: body.data.remember,
      });

      reply.clearCookie(PENDING_COOKIE, cookieBase);
      await oturumuYerlestir(req, reply, pending.userId, yeni);

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

    aktifYaz(reply, {
      packed: packSessionCookie(result.sessionId, result.sessionKey),
      refresh: result.refreshToken,
      remember: result.remember,
    });

    return reply.send({ status: "ok", expiresAt: result.expiresAt.toISOString() });
  });

  /**
   * Çıkış. Varsayılan olarak yalnızca etkin hesaptan çıkılır; tarayıcıda
   * başka hesap açıksa o etkin olur. `tumu: true` hepsinden çıkar.
   */
  app.post("/api/auth/logout", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = z.object({ tumu: z.boolean().default(false) }).safeParse(req.body ?? {});
    const tumu = body.success && body.data.tumu;

    const sessionCookie = req.cookies[SESSION_COOKIE];
    const unpacked = sessionCookie ? unpackSessionCookie(sessionCookie) : null;
    const { digerleri } = await hesaplariCoz(req);

    if (unpacked) {
      await revokeSession(unpacked.sessionId);
      await audit({ action: "logout", ip: clientIp(req) });
    }

    if (tumu) {
      await Promise.all(digerleri.map((o) => revokeSession(o.sessionId)));
      digerleri.length = 0;
    }

    const [sonraki, ...kalan] = digerleri;
    if (sonraki) {
      aktifYaz(reply, sonraki);
      digerleriniYaz(reply, kalan);
      return reply.send({ status: "ok", devam: sonraki.session.email });
    }

    reply.clearCookie(SESSION_COOKIE, cookieBase);
    reply.clearCookie(REFRESH_COOKIE, cookieBase);
    reply.clearCookie(ACCOUNTS_COOKIE, cookieBase);
    return reply.send({ status: "ok" });
  });

  /** Tarayıcıda açık başka bir hesaba geç — parola sorulmaz. */
  app.post("/api/auth/switch", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = z.object({ email: z.string().email().max(254) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Geçersiz istek" });

    const { aktif, digerleri } = await hesaplariCoz(req);
    const hedef = digerleri.find(
      (o) => o.session.email.toLowerCase() === body.data.email.toLowerCase(),
    );
    if (!hedef) return reply.code(404).send({ error: "Bu hesabın oturumu kapanmış" });

    aktifYaz(reply, hedef);
    digerleriniYaz(reply, [...(aktif ? [aktif] : []), ...digerleri.filter((o) => o !== hedef)]);

    await audit({ userId: hedef.session.userId, action: "session.switch", ip: clientIp(req) });
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
    if (!req.cookies[SESSION_COOKIE]) return reply.code(401).send({ error: "Oturum yok" });

    const { aktif, digerleri } = await hesaplariCoz(req);
    if (!aktif) return reply.code(401).send({ error: "Oturum geçersiz" });
    const session = aktif.session;

    // Uygulama her açıldığında süre baştan başlar; çerezler de yeniden
    // yazılıyor ki tarayıcı tarafındaki 30 gün de kaysın. Düşmüş diğer
    // hesaplar bu yazımla çerezden ayıklanmış oluyor.
    await extendSessions([aktif, ...digerleri].map((o) => o.sessionId));
    aktifYaz(reply, aktif);
    digerleriniYaz(reply, digerleri);

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
      hesaplar: digerleri.map((o) => ({
        email: o.session.email,
        displayName: o.session.displayName,
      })),
      domain: env.MAIL_DOMAIN,
      domains: mailDomains,
      isAdmin: session.email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase(),
    });
  });
}

export { SESSION_COOKIE, REFRESH_COOKIE, cookieBase, oturumuYerlestir };
