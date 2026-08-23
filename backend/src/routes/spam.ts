import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { spamLabels } from "../db/schema.js";
import { unpackSessionCookie } from "../lib/crypto.js";
import { loadSession } from "../auth/session.js";
import { getMessage, ozelKutuBul, mesajiTasi } from "../mail/imap.js";
import { spamSkorla } from "../mail/spam.js";
import { htmlToOnizleme } from "../mail/mime.js";
import { audit } from "../lib/audit.js";
import { SESSION_COOKIE } from "./auth.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Spam eğitim verisi toplayıcı.
 *
 * ## Neden gerekli
 *
 * Şu anki model ML kampı Gün 1'de eğitildi: 5158 İngilizce SMS + 616
 * Türkçe e-posta. Kendi test kümesinde %99/%94 alıyor ama GERÇEK gelen
 * kutusunda yanılıyor — çünkü kargo, fatura, doğrulama kodu, bülten gibi
 * mail türlerini hiç görmedi.
 *
 * Eşikle oynamak bunu çözmez. Çözüm gerçek veriyle yeniden eğitmek ve
 * o veri ancak buradan gelebilir: Eymen'in kendi gelen kutusundan,
 * kendi işaretlediği örneklerden.
 *
 * ## Ne saklanıyor
 *
 * Konu + gövdenin düz metin hâlinin ilk 4000 karakteri. Tam mail
 * saklanmıyor: eğitim için gerekmiyor ve postanın ikinci bir kopyasını
 * veritabanında tutmak gereksiz risk. `modelSkoru` da yazılıyor ki
 * sonradan "model tam olarak nerede yanılmış" sorusu cevaplanabilsin.
 *
 * ## Dışa aktarma
 *
 * `GET /api/spam/dataset` CSV veriyor: `metin,etiket`. Bu, ML kampı
 * Gün 1'deki `veri/spam_tr.csv` ile AYNI biçim — doğrudan
 * `cozum/onnx_disa_aktar.py`'ye verilip yeni bir `.onnx` üretilebilir.
 */

const GOVDE_SINIRI = 4000;

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

/** CSV alanı: tırnak ve satır sonu içeren metinleri güvenle sarar. */
function csvAlan(deger: string): string {
  return `"${deger.replace(/"/g, '""')}"`;
}

export async function spamRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Bir maili spam / spam değil diye işaretle.
   *
   * Mailin kendisini sunucudan yeniden okuyoruz, istemcinin gönderdiği
   * metne güvenmiyoruz: aksi halde eğitim verisine istemci üzerinden
   * uydurma örnek sokulabilirdi.
   */
  app.post("/api/spam/label", async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const govde = z
      .object({
        uid: z.coerce.number().int().positive(),
        mailbox: z.string().max(255).default("INBOX"),
        label: z.enum(["spam", "ham"]),
      })
      .safeParse(req.body);
    if (!govde.success) return reply.code(400).send({ error: "Geçersiz istek" });

    const { uid, mailbox, label } = govde.data;

    const mesaj = await getMessage(
      { user: session.email, pass: session.imapPassword },
      uid,
      { mailbox },
    );
    if (!mesaj) return reply.code(404).send({ error: "Mail bulunamadı" });

    const duzMetin = htmlToOnizleme(mesaj.html).replace(/\s+/g, " ").trim();
    const metin = `${mesaj.subject} ${duzMetin}`.trim().slice(0, GOVDE_SINIRI);
    const [skor] = await spamSkorla([metin]);

    /**
     * Aynı mail iki kez toplanmasın diye kutu + uid anahtarı.
     * Fikir değiştirirse (spam dedi, sonra ham dedi) kayıt GÜNCELLENİR —
     * eğitim verisinde çelişkili iki satır olmaz.
     */
    const messageKey = `${mailbox}:${uid}`;

    await db
      .insert(spamLabels)
      .values({
        userId: session.userId,
        label,
        kaynak: "elle",
        subject: mesaj.subject.slice(0, 500),
        body: duzMetin.slice(0, GOVDE_SINIRI),
        fromAddress: mesaj.from?.address ?? null,
        modelSkoru: skor?.skor ?? null,
        modelDili: skor?.model ?? null,
        messageKey,
      })
      .onConflictDoUpdate({
        target: [spamLabels.userId, spamLabels.messageKey],
        set: {
          label,
          modelSkoru: skor?.skor ?? null,
          modelDili: skor?.model ?? null,
          createdAt: new Date(),
        },
      });

    /**
     * Etiket sadece kaydedilmiyor, mail de TAŞINIYOR.
     *
     * Önce yalnızca eğitim verisine yazılıyordu ve mail bulunduğu
     * klasörde kalıyordu — kullanıcı "spam değil" deyip mailin Spam
     * klasöründe durmaya devam ettiğini görüyordu. Beklenen davranış
     * mailin gitmesi.
     *
     * Taşıma başarısız olursa etiket YİNE kaydediliyor: model öğrensin,
     * yalnızca klasör değişmemiş olsun.
     */
    const kimlik = { user: session.email, pass: session.imapPassword };
    const spamKutusu = await ozelKutuBul(kimlik, "\\Junk", ["Junk", "Spam"]);
    let tasindi: string | null = null;

    if (label === "spam" && spamKutusu && mailbox !== spamKutusu) {
      if (await mesajiTasi(kimlik, uid, mailbox, spamKutusu)) tasindi = spamKutusu;
    } else if (label === "ham" && spamKutusu && mailbox === spamKutusu) {
      // Spam'den çıkarılan mail gelen kutusuna döner
      if (await mesajiTasi(kimlik, uid, mailbox, "INBOX")) tasindi = "INBOX";
    }

    await audit({
      userId: session.userId,
      action: "spam.label",
      detail:
        `${label} <- ${mesaj.subject.slice(0, 60)} ` +
        `(model %${Math.round((skor?.skor ?? 0) * 100)}` +
        `${tasindi ? `, ${mailbox} -> ${tasindi}` : ""})`,
      ip: req.ip,
    });

    return reply.send({ ok: true, label, modelSkoru: skor?.skor ?? null, tasindi });
  });

  /**
   * Bu maile daha önce etiket verilmiş mi?
   *
   * Olmadan arayüz her açılışta yeniden soruyordu — kullanıcı zaten
   * cevaplamışken tekrar sormak hem sinir bozucu hem de "kaydedildi mi?"
   * şüphesi yaratıyor.
   */
  app.get("/api/spam/label", async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const sorgu = z
      .object({ uid: z.coerce.number().int().positive(), mailbox: z.string().max(255).default("INBOX") })
      .safeParse(req.query);
    if (!sorgu.success) return reply.code(400).send({ error: "Geçersiz sorgu" });

    const [kayit] = await db
      .select({ label: spamLabels.label })
      .from(spamLabels)
      .where(
        and(
          eq(spamLabels.userId, session.userId),
          eq(spamLabels.messageKey, `${sorgu.data.mailbox}:${sorgu.data.uid}`),
        ),
      )
      .limit(1);

    return reply.send({ label: kayit?.label ?? null });
  });

  /**
   * Modelin künyesi: hangi veriyle eğitildi, ne kadar doğru, nerede zayıf.
   *
   * `models/spam-model.json` eğitim betiği tarafından yazılıyor, yani
   * buradaki sayılar elle girilmiş değil — modelle birlikte geliyor.
   * Amaç: rozete bakan kişi neye güvendiğini bilsin.
   */
  app.get("/api/spam/model", async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const klasor = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "models");
    try {
      const ham = readFileSync(path.join(klasor, "spam-model.json"), "utf8");
      return reply.send({ model: JSON.parse(ham) });
    } catch {
      // Dosya yoksa model eski sürüm demek; arayüz bunu söyleyecek.
      return reply.send({ model: null });
    }
  });

  /** Toplanan veri hakkında özet — modelin nerede yanıldığı dahil. */
  app.get("/api/spam/stats", async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const satirlar = await db
      .select({
        label: spamLabels.label,
        adet: sql<number>`count(*)::int`,
        // Model bu etiketle ne kadar uyuşuyor?
        modelKatiliyor: sql<number>`
          count(*) FILTER (
            WHERE (${spamLabels.label} = 'spam' AND ${spamLabels.modelSkoru} >= 0.5)
               OR (${spamLabels.label} = 'ham'  AND ${spamLabels.modelSkoru} <  0.5)
          )::int`,
      })
      .from(spamLabels)
      .where(eq(spamLabels.userId, session.userId))
      .groupBy(spamLabels.label);

    const toplam = satirlar.reduce((t, r) => t + r.adet, 0);
    const uyusan = satirlar.reduce((t, r) => t + r.modelKatiliyor, 0);

    return reply.send({
      toplam,
      etiketler: satirlar.map((r) => ({ label: r.label, adet: r.adet })),
      /** Mevcut modelin senin etiketlerinle uyuşma oranı */
      modelDogrulugu: toplam > 0 ? uyusan / toplam : null,
      /** Yeniden eğitim için makul alt sınır */
      yeterliMi: toplam >= 200,
    });
  });

  /**
   * Eğitim verisini CSV olarak indir.
   *
   * Biçim ML-KAMP Gün 1'deki `veri/spam_*.csv` ile aynı (`metin,etiket`),
   * yani doğrudan oradaki eğitim koduna verilebilir.
   */
  app.get("/api/spam/dataset", async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const kayitlar = await db
      .select({
        subject: spamLabels.subject,
        body: spamLabels.body,
        label: spamLabels.label,
      })
      .from(spamLabels)
      .where(and(eq(spamLabels.userId, session.userId)))
      .orderBy(desc(spamLabels.createdAt));

    const satirlar = ["metin,etiket"];
    for (const k of kayitlar) {
      const metin = `${k.subject} ${k.body}`.replace(/\s+/g, " ").trim();
      if (!metin) continue;
      satirlar.push(`${csvAlan(metin)},${csvAlan(k.label)}`);
    }

    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", 'attachment; filename="spam-egitim-verisi.csv"')
      .send(satirlar.join("\n"));
  });
}
