import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { unpackSessionCookie } from "../lib/crypto.js";
import { loadSession } from "../auth/session.js";
import { listMailboxes, listMessages, getMessage, setFlag, searchMessages } from "../mail/imap.js";
import { sendMail } from "../mail/send.js";
import { audit } from "../lib/audit.js";
import { SESSION_COOKIE } from "./auth.js";

/** Oturumu çözer; yoksa 401. Her posta rotasının ilk adımı. */
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

export async function mailRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/mailboxes", async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const boxes = await listMailboxes({
      user: session.email,
      pass: session.imapPassword,
    });
    return reply.send({ mailboxes: boxes });
  });

  app.get("/api/messages", async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const query = z
      .object({
        mailbox: z.string().max(255).default("INBOX"),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .safeParse(req.query);

    if (!query.success) return reply.code(400).send({ error: "Geçersiz sorgu" });

    const messages = await listMessages(
      { user: session.email, pass: session.imapPassword },
      { mailbox: query.data.mailbox, limit: query.data.limit },
    );
    return reply.send({ messages });
  });

  /**
   * Sunucu tarafı arama. İstemci filtresi yalnızca yüklenmiş mesajlara
   * bakıyordu; bu, kutunun tamamını arar.
   */
  app.get(
    "/api/search",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;

      const query = z
        .object({
          q: z.string().min(1).max(200),
          mailbox: z.string().max(255).default("INBOX"),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .safeParse(req.query);

      if (!query.success) return reply.code(400).send({ error: "Geçersiz sorgu" });

      const messages = await searchMessages(
        { user: session.email, pass: session.imapPassword },
        query.data.q,
        { mailbox: query.data.mailbox, limit: query.data.limit },
      );

      return reply.send({ messages });
    },
  );

  app.get("/api/messages/:uid", async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const params = z.object({ uid: z.coerce.number().int().positive() }).safeParse(req.params);
    const query = z
      .object({
        mailbox: z.string().max(255).default("INBOX"),
        // Uzak görseller yalnızca kullanıcı açıkça isterse yüklenir
        images: z.enum(["blocked", "allowed"]).default("blocked"),
      })
      .safeParse(req.query);

    if (!params.success || !query.success) {
      return reply.code(400).send({ error: "Geçersiz istek" });
    }

    const message = await getMessage(
      { user: session.email, pass: session.imapPassword },
      params.data.uid,
      {
        mailbox: query.data.mailbox,
        allowRemoteImages: query.data.images === "allowed",
      },
    );

    if (!message) return reply.code(404).send({ error: "Mesaj bulunamadı" });
    return reply.send({ message });
  });

  /**
   * Gönderme. Saatte 50 mail sınırı: hesap ele geçirilirse spam
   * kaynağına dönüşmesin, IP itibarımız yanmasın.
   */
  app.post(
    "/api/messages/send",
    { config: { rateLimit: { max: 50, timeWindow: "1 hour" } } },
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;

      const adres = z.string().email().max(254);
      const body = z
        .object({
          to: z.array(adres).min(1).max(50),
          cc: z.array(adres).max(50).optional(),
          bcc: z.array(adres).max(50).optional(),
          // Satır sonu enjeksiyonu başlık uydurmaya yarar; konuda yasak
          subject: z.string().max(500).regex(/^[^\r\n]*$/, "Konuda satır sonu olamaz"),
          text: z.string().max(1024 * 512),
          html: z.string().max(1024 * 512).optional(),
          inReplyTo: z.string().max(998).optional(),
          references: z.array(z.string().max(998)).max(50).optional(),
        })
        .safeParse(req.body);

      if (!body.success) {
        return reply.code(400).send({
          error: body.error.issues[0]?.message ?? "Geçersiz istek",
        });
      }

      try {
        const result = await sendMail({
          from: session.email,
          password: session.imapPassword,
          ...body.data,
        });

        await audit({
          userId: session.userId,
          action: "mail.send",
          // İçerik değil, yalnızca metadata
          detail: `${result.accepted.length} alıcı, sent=${result.savedToSent}`,
          ip: req.ip,
        });

        return reply.send({ status: "ok", ...result });
      } catch (err) {
        req.log.error({ err }, "gönderme hatası");
        await audit({
          userId: session.userId,
          action: "mail.send_fail",
          ip: req.ip,
        });
        return reply.code(502).send({ error: "Mail gönderilemedi" });
      }
    },
  );

  app.post("/api/messages/:uid/flags", async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const params = z.object({ uid: z.coerce.number().int().positive() }).safeParse(req.params);
    const body = z
      .object({
        flag: z.enum(["seen", "flagged"]),
        value: z.boolean(),
        mailbox: z.string().max(255).default("INBOX"),
      })
      .safeParse(req.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Geçersiz istek" });
    }

    await setFlag(
      { user: session.email, pass: session.imapPassword },
      params.data.uid,
      body.data.flag === "seen" ? "\\Seen" : "\\Flagged",
      body.data.value,
      body.data.mailbox,
    );

    await audit({
      userId: session.userId,
      action: "mail.flag",
      detail: `${body.data.flag}=${body.data.value} uid=${params.data.uid}`,
      ip: req.ip,
    });

    return reply.send({ status: "ok" });
  });
}
