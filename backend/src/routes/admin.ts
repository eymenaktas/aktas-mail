import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { execFile } from "node:child_process";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { unpackSessionCookie } from "../lib/crypto.js";
import { loadSession } from "../auth/session.js";
import { audit } from "../lib/audit.js";
import { verifyCredentials } from "../mail/imap.js";
import { SESSION_COOKIE } from "./auth.js";

/**
 * Yönetim uçları — posta kutusu ekleme/çıkarma.
 *
 * Uygulama `aktasmail` kullanıcısıyla çalışıyor ve root DEĞİL. Kutu açmak
 * `/etc/postfix/vmailbox` ve `/etc/dovecot/users` dosyalarına yazmayı
 * gerektirdiği için tek bir yardımcı script'e sudo izni verildi:
 *
 *   /usr/local/sbin/aktasmail-user   (root:aktasmail, 0750)
 *   /etc/sudoers.d/aktasmail         (NOPASSWD, yalnızca bu script)
 *
 * Script çağıranına güvenmez, girdiyi kendi başına yeniden doğrular.
 * Buradaki doğrulama ikinci katman.
 */

const HELPER = "/usr/local/sbin/aktasmail-user";

/** Admin kimliği env'den gelir — DB'den DEĞİL.
 *  Sebebi: veritabanına yazabilen biri kendini admin yapamasın. */
function isAdmin(email: string): boolean {
  return email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase();
}

/**
 * Yıkıcı yönetim işlemleri için YENİDEN KİMLİK DOĞRULAMA.
 *
 * Oturum çerezi çalınırsa saldırgan postaları okuyabilir — kötü, ama
 * kutu açıp silebilmesi çok daha kötü olurdu (kalıcı arka kapı).
 * Bu yüzden ekleme/silmede admin kendi parolasını yeniden giriyor ve
 * parola Dovecot'a sorularak doğrulanıyor.
 *
 * Oturumda "yükseltilmiş mod" tutmuyoruz: fazladan durum, fazladan
 * hata yüzeyi demek. İşlem seyrek, parola girmek ucuz.
 */
async function reauth(email: string, password: string): Promise<boolean> {
  return verifyCredentials({ user: email, pass: password });
}

async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  const cookie = req.cookies[SESSION_COOKIE];
  const un = cookie ? unpackSessionCookie(cookie) : null;
  if (!un) {
    reply.code(401).send({ error: "Oturum yok" });
    return null;
  }
  const session = await loadSession(un.sessionId, un.sessionKey);
  if (!session) {
    reply.code(401).send({ error: "Oturum geçersiz" });
    return null;
  }
  if (!isAdmin(session.email)) {
    await audit({ userId: session.userId, action: "admin.denied", ip: req.ip });
    // Yönetim uçlarının varlığını sızdırmamak için 404
    reply.code(404).send({ error: "Bulunamadı" });
    return null;
  }
  return session;
}

/**
 * Yardımcıyı çalıştırır. Argümanlar DİZİ olarak veriliyor (kabuk yok),
 * parola ise stdin'den — argv `ps` çıktısında görünür, parola oraya
 * asla yazılmamalı.
 */
function helper(
  args: string[],
  stdin?: string,
): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      "sudo",
      ["-n", HELPER, ...args],
      { timeout: 20_000, maxBuffer: 1024 * 128 },
      (err, stdout, stderr) => {
        if (err) resolve({ ok: false, out: (stderr || stdout || err.message).trim() });
        else resolve({ ok: true, out: stdout.trim() });
      },
    );
    if (stdin !== undefined) {
      child.stdin?.write(stdin + "\n");
      child.stdin?.end();
    }
  });
}

const adresSemasi = z
  .string()
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]{0,62}@[a-z0-9.-]+$/, "Geçersiz adres biçimi");

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  /** Kutu listesi + uygulamada kaydı olanlar. */
  app.get("/api/admin/users", async (req, reply) => {
    const session = await requireAdmin(req, reply);
    if (!session) return;

    const sonuc = await helper(["list"]);
    if (!sonuc.ok) {
      req.log.error({ out: sonuc.out }, "kutu listesi alınamadı");
      return reply.code(500).send({ error: "Liste alınamadı" });
    }

    const kutular = sonuc.out.split("\n").map((s) => s.trim()).filter(Boolean);
    const kayitli = await db
      .select({ email: schema.users.email, createdAt: schema.users.createdAt })
      .from(schema.users);

    const kayitliHarita = new Map(kayitli.map((k) => [k.email.toLowerCase(), k]));

    return reply.send({
      admin: env.ADMIN_EMAIL,
      users: kutular.map((email) => ({
        email,
        isAdmin: isAdmin(email),
        /** Kutu var ama hiç giriş yapmamışsa uygulamada kaydı olmaz */
        hasLoggedIn: kayitliHarita.has(email.toLowerCase()),
      })),
    });
  });

  app.post(
    "/api/admin/users",
    { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
    async (req, reply) => {
      const session = await requireAdmin(req, reply);
      if (!session) return;

      const body = z
        .object({
          email: adresSemasi,
          /** Yeni kullanıcının ilk parolası; kendisi sonradan değiştirir. */
          password: z.string().min(10).max(200),
          /** Admin'in KENDİ parolası — yeniden kimlik doğrulama. */
          adminPassword: z.string().min(1).max(512),
        })
        .safeParse(req.body);

      if (!body.success) {
        return reply.code(400).send({
          error: body.error.issues[0]?.message ?? "Geçersiz istek",
        });
      }

      if (!(await reauth(session.email, body.data.adminPassword))) {
        await audit({
          userId: session.userId,
          action: "admin.reauth_fail",
          detail: `add ${body.data.email}`,
          ip: req.ip,
        });
        return reply.code(401).send({ error: "Kendi parolan hatalı" });
      }

      const sonuc = await helper(["add", body.data.email], body.data.password);

      await audit({
        userId: session.userId,
        action: sonuc.ok ? "admin.user_add" : "admin.user_add_fail",
        // Parola DEĞİL, yalnızca adres
        detail: body.data.email,
        ip: req.ip,
      });

      if (!sonuc.ok) return reply.code(400).send({ error: sonuc.out });
      return reply.send({ status: "ok", message: sonuc.out });
    },
  );

  /**
   * Silme POST ile: DELETE gövdesi bazı vekiller ve istemcilerde
   * düşürülüyor, admin parolası gövdede taşınmalı.
   */
  app.post(
    "/api/admin/users/remove",
    { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
    async (req, reply) => {
      const session = await requireAdmin(req, reply);
      if (!session) return;

      const params = z
        .object({
          email: adresSemasi,
          adminPassword: z.string().min(1).max(512),
        })
        .safeParse(req.body);
      if (!params.success) return reply.code(400).send({ error: "Geçersiz istek" });

      if (isAdmin(params.data.email)) {
        return reply.code(400).send({ error: "Admin kutusu silinemez" });
      }

      if (!(await reauth(session.email, params.data.adminPassword))) {
        await audit({
          userId: session.userId,
          action: "admin.reauth_fail",
          detail: `remove ${params.data.email}`,
          ip: req.ip,
        });
        return reply.code(401).send({ error: "Kendi parolan hatalı" });
      }

      const sonuc = await helper(["remove", params.data.email]);

      await audit({
        userId: session.userId,
        action: sonuc.ok ? "admin.user_remove" : "admin.user_remove_fail",
        detail: params.data.email,
        ip: req.ip,
      });

      if (!sonuc.ok) return reply.code(400).send({ error: sonuc.out });

      // Uygulama kaydını da temizle (posta verisi diskte kalır)
      await db.delete(schema.users).where(eq(schema.users.email, params.data.email));

      return reply.send({ status: "ok", message: sonuc.out });
    },
  );
}

export { isAdmin };
