import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { listMessages, getMessage, searchMessages, okunmamisSayilari } from "../mail/imap.js";
import { audit } from "../lib/audit.js";
import { safeEqual, sha256 } from "../lib/crypto.js";

/**
 * Jarvis erişimi — ayrı kimlik, ayrı kapı, ayrı denetim izi.
 *
 * NEDEN AYRI: uygulamanın kendi oturum modeli IMAP parolasını oturum
 * anahtarıyla şifreliyor ve anahtar YALNIZCA istemcide duruyor
 * (bkz. `auth/session.ts`). Bu kasıtlı bir tasarım ve bozulmamalı —
 * ama sonucu şu: başsız bir ajan mevcut oturum sistemini kullanamaz.
 *
 * Çözüm, Dovecot'ta ayrı bir **master user**. Jarvis kendi parolasıyla
 * `eymen@akts.tr` kutusuna giriyor; Eymen'in parolası hiçbir aşamada
 * işin içine girmiyor ve erişim tek satırla iptal edilebiliyor.
 *
 * YETKİ: oku · ara · sayaç. **Gönderme ve silme YOK.**
 * Taslak hazırlama uygulamanın kendi arayüzünden onaylanıyor.
 */

const KULLANICI = process.env.JARVIS_IMAP_USER ?? "";   // ör. eymen@akts.tr*jarvis
const PAROLA = process.env.JARVIS_IMAP_PASS ?? "";
const TOKEN_HASH = process.env.JARVIS_TOKEN_HASH ?? "";

function kimlik() {
  return { user: KULLANICI, pass: PAROLA };
}

/**
 * Bearer token doğrulaması.
 *
 * Token düz metin olarak saklanmıyor; ortamda yalnızca SHA-256 özeti var.
 * Karşılaştırma `safeEqual` ile — zamanlama saldırısına kapalı.
 */
function yetkiVar(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!TOKEN_HASH || !KULLANICI || !PAROLA) {
    reply.code(503).send({ error: "Jarvis erişimi yapılandırılmamış" });
    return false;
  }

  const baslik = req.headers.authorization ?? "";
  const token = baslik.startsWith("Bearer ") ? baslik.slice(7) : "";
  if (!token || !safeEqual(sha256(token), TOKEN_HASH)) {
    reply.code(401).send({ error: "Yetkisiz" });
    return false;
  }
  return true;
}

export async function jarvisRoutes(app: FastifyInstance): Promise<void> {
  /** Gelen kutusu özeti — Jarvis'in "bugün önemli ne geldi" cevabı buradan. */
  app.get("/api/jarvis/ozet", async (req, reply) => {
    if (!yetkiVar(req, reply)) return;

    const sorgu = z.object({
      kutu: z.string().default("INBOX"),
      adet: z.coerce.number().min(1).max(50).default(20),
    }).parse(req.query);

    const [mesajlar, sayilar] = await Promise.all([
      listMessages(kimlik(), { mailbox: sorgu.kutu, limit: sorgu.adet, sayfa: 1 }),
      okunmamisSayilari(kimlik()),
    ]);

    await audit({ action: "jarvis.ozet", detail: `${sorgu.kutu} · ${sorgu.adet}`, ip: req.ip });
    return reply.send({ mesajlar, okunmamis: sayilar });
  });

  /** Tam mail — gövdesi, ekleri, spam skoru, gönderen doğrulaması dahil. */
  app.get("/api/jarvis/mail/:uid", async (req, reply) => {
    if (!yetkiVar(req, reply)) return;

    const { uid } = z.object({ uid: z.coerce.number() }).parse(req.params);
    const { kutu } = z.object({ kutu: z.string().default("INBOX") }).parse(req.query);

    const mesaj = await getMessage(kimlik(), uid, { mailbox: kutu });
    if (!mesaj) return reply.code(404).send({ error: "Mail bulunamadı" });

    await audit({ action: "jarvis.mail-oku", detail: `${kutu}:${uid}`, ip: req.ip });
    return reply.send({ mesaj });
  });

  /** Arama. */
  app.get("/api/jarvis/ara", async (req, reply) => {
    if (!yetkiVar(req, reply)) return;

    const { q, kutu } = z.object({
      q: z.string().min(2),
      kutu: z.string().default("INBOX"),
    }).parse(req.query);

    const sonuc = await searchMessages(kimlik(), q, { mailbox: kutu, limit: 30 });
    await audit({ action: "jarvis.ara", detail: q.slice(0, 80), ip: req.ip });
    return reply.send({ sonuc });
  });
}
