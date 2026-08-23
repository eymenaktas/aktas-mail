import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import webpush from "web-push";
import { db } from "../db/index.js";
import { pushSubscriptions, users } from "../db/schema.js";
import { env } from "../env.js";
import { unpackSessionCookie } from "../lib/crypto.js";
import { loadSession } from "../auth/session.js";
import { audit } from "../lib/audit.js";
import { spamSkorla, SPAM_ESIGI } from "../mail/spam.js";
import { tasimaEsigi } from "../mail/bakim.js";
import { avatarGetir } from "../mail/avatar-cache.js";
import { SESSION_COOKIE } from "./auth.js";
import { yayinla } from "./events.js";

/**
 * Web push bildirimleri.
 *
 * ## Neden Dovecot tetikliyor, uygulama değil
 *
 * Uygulama IMAP parolasını saklamıyor — oturum anahtarı yalnızca
 * istemcide. Yani sunucu, kullanıcı istekte bulunmadan posta kutusuna
 * BAKAMIYOR; "yeni mail geldi mi" diye yoklamak yapısal olarak mümkün
 * değil. Yoklasa bile aralık kadar gecikme olurdu.
 *
 * Çözüm: bildirimi POSTA SUNUCUSU tetikliyor. Dovecot'un
 * `push_notification` eklentisi maili teslim ettiği anda buraya bir
 * HTTP isteği atıyor. Gecikme yok, parolaya da ihtiyaç yok.
 *
 * ## Bildirimde ne yazıyor
 *
 * Yalnızca gönderen ve konu. Gövde GÖNDERİLMİYOR: push yükü tarayıcının
 * push servisinden (Google/Apple) geçiyor. İçerik uçtan uca şifreli
 * olduğu için onlar okuyamıyor ama yükü küçük ve asgari tutmak yine de
 * doğru — kilit ekranında da tüm mail görünmesin.
 */

/** VAPID yapılandırılmamışsa bildirim özelliği kapalı. */
function pushHazirMi(): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

if (pushHazirMi()) {
  webpush.setVapidDetails(
    `mailto:${env.MAIL_DOMAIN ? `postmaster@${env.MAIL_DOMAIN}` : "postmaster@localhost"}`,
    env.VAPID_PUBLIC_KEY as string,
    env.VAPID_PRIVATE_KEY as string,
  );
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

const abonelikSemasi = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().max(256),
    auth: z.string().max(256),
  }),
  label: z.string().max(80).optional(),
});

/**
 * Bir kullanıcının TÜM cihazlarına bildirim gönderir.
 *
 * Ölü abonelikler (404/410) temizleniyor: kullanıcı bildirimi
 * kapattığında ya da tarayıcı verisini sildiğinde push servisi bu
 * kodları döner ve o kayıt bir daha çalışmaz.
 */
export async function bildirimGonder(
  userId: number,
  yuk: { baslik: string; govde: string; url?: string },
): Promise<{ gonderilen: number; temizlenen: number }> {
  if (!pushHazirMi()) return { gonderilen: 0, temizlenen: 0 };

  const abonelikler = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));

  let gonderilen = 0;
  let temizlenen = 0;

  await Promise.all(
    abonelikler.map(async (a) => {
      try {
        await webpush.sendNotification(
          { endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } },
          JSON.stringify(yuk),
          { TTL: 600 },
        );
        gonderilen += 1;
        await db
          .update(pushSubscriptions)
          .set({ lastSentAt: new Date() })
          .where(eq(pushSubscriptions.endpoint, a.endpoint))
          .catch(() => {});
      } catch (e) {
        const kod = (e as { statusCode?: number }).statusCode;
        if (kod === 404 || kod === 410) {
          await db
            .delete(pushSubscriptions)
            .where(eq(pushSubscriptions.endpoint, a.endpoint))
            .catch(() => {});
          temizlenen += 1;
        }
      }
    }),
  );

  return { gonderilen, temizlenen };
}

export async function pushRoutes(app: FastifyInstance): Promise<void> {
  /** İstemcinin aboneliği kurmak için ihtiyaç duyduğu açık anahtar. */
  app.get("/api/push/key", async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    if (!pushHazirMi()) {
      return reply.code(503).send({ error: "Bildirim yapılandırılmamış" });
    }
    return reply.send({ key: env.VAPID_PUBLIC_KEY });
  });

  /** Bu cihazı kaydet. Aynı endpoint yeniden gelirse günceller. */
  app.post("/api/push/subscribe", async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const govde = abonelikSemasi.safeParse(req.body);
    if (!govde.success) return reply.code(400).send({ error: "Geçersiz abonelik" });

    await db
      .insert(pushSubscriptions)
      .values({
        endpoint: govde.data.endpoint,
        userId: session.userId,
        p256dh: govde.data.keys.p256dh,
        auth: govde.data.keys.auth,
        label: govde.data.label ?? null,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          userId: session.userId,
          p256dh: govde.data.keys.p256dh,
          auth: govde.data.keys.auth,
          label: govde.data.label ?? null,
        },
      });

    await audit({ userId: session.userId, action: "push.subscribe", ip: req.ip });
    return reply.send({ ok: true });
  });

  app.delete("/api/push/subscribe", async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const govde = z.object({ endpoint: z.string().max(2048) }).safeParse(req.body);
    if (!govde.success) return reply.code(400).send({ error: "Geçersiz istek" });

    await db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.endpoint, govde.data.endpoint),
          eq(pushSubscriptions.userId, session.userId),
        ),
      );
    return reply.send({ ok: true });
  });

  /** Bu hesabın kayıtlı cihazları — Ayarlar'da gösteriliyor. */
  app.get("/api/push/devices", async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const kayitlar = await db
      .select({
        endpoint: pushSubscriptions.endpoint,
        label: pushSubscriptions.label,
        createdAt: pushSubscriptions.createdAt,
        lastSentAt: pushSubscriptions.lastSentAt,
      })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, session.userId));

    return reply.send({ devices: kayitlar, hazir: pushHazirMi() });
  });

  /** Deneme bildirimi — kurulumun çalıştığını görmek için. */
  app.post("/api/push/test", async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const sonuc = await bildirimGonder(session.userId, {
      baslik: "Aktaş Mail",
      govde: "Bildirimler çalışıyor.",
      url: "/",
    });
    return reply.send(sonuc);
  });

  /**
   * TESLİMAT KANCASI — Dovecot burayı çağırıyor.
   *
   * > [!warning] Bu uç oturum İSTEMİYOR
   * > Çağıran Dovecot, kullanıcı değil. İki katmanla korunuyor:
   * >   1. Yalnızca 127.0.0.1'den kabul ediliyor (nginx dışarı açmıyor,
   * >      ama savunma derinliği için burada da kontrol var)
   * >   2. Paylaşılan sır (`PUSH_HOOK_SECRET`) başlıkta doğrulanıyor
   * > Sır tanımlı değilse uç tamamen kapalı — yanlışlıkla açık kalmasın.
   */
  app.post("/api/push/hook", async (req, reply) => {
    if (!env.PUSH_HOOK_SECRET) return reply.code(404).send({ error: "Kapalı" });

    const ip = req.ip;
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
      return reply.code(403).send({ error: "Yalnızca yerel" });
    }
    if (req.headers["x-hook-secret"] !== env.PUSH_HOOK_SECRET) {
      return reply.code(403).send({ error: "Sır hatalı" });
    }

    /**
     * Dovecot'un OX sürücüsü alan adlarını sürümden sürüme değiştirdiği
     * için şema GEVŞEK: bilinen adların hangisi gelirse o kullanılıyor.
     * Gelen ham gövde de loglanıyor, böylece biçim değişirse görülür.
     */
    const g = (req.body ?? {}) as Record<string, unknown>;
    const metin = (a: unknown) => (typeof a === "string" ? a : undefined);

    const adres = metin(g["user"]) ?? metin(g["to"]) ?? metin(g["username"]);
    const klasor = metin(g["folder"]) ?? metin(g["mailbox"]) ?? "INBOX";
    const konu = metin(g["subject"]) ?? "(konu yok)";
    const gonderen = metin(g["from"]) ?? metin(g["sender"]) ?? "";

    if (!adres) {
      req.log.warn({ govde: g }, "push kancası: kullanıcı alanı bulunamadı");
      return reply.code(400).send({ error: "Kullanıcı yok" });
    }

    // Yalnızca gelen kutusu; Sent/Trash'e düşen kopyalar bildirim üretmesin
    if (!/^INBOX$/i.test(klasor)) return reply.send({ atlandi: klasor });

    const [kullanici] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, adres.toLowerCase()))
      .limit(1);

    if (!kullanici) return reply.send({ atlandi: "kullanıcı kayıtlı değil" });

    /**
     * Açık sekmelere HER ZAMAN haber ver — spam olsa bile.
     *
     * Bildirim (telefonu titreten şey) spam'de bastırılıyor ama liste
     * yenilemesi başka: mail Spam klasörüne düşse bile kullanıcı o an
     * bakıyorsa listenin güncel olması doğru. Rahatsız etmeyen bir
     * sinyal, sessize almaya gerek yok.
     */
    const acikSekme = yayinla(kullanici.id, { tip: "yeni-mail", klasor: "INBOX" });

    /**
     * Spam'e bildirim GİTMEZ.
     *
     * Bildirimin tek işi "bakmaya değer bir şey geldi" demek. Spam için
     * telefon titrerse özellik zarar verir hale gelir. Eşik rozetle aynı
     * (%50): rozet gösterilen bir mail zaten şüpheli sayılıyor.
     *
     * Burada model yanılırsa bedeli bildirim kaçırmak — mail yine
     * kutuda duruyor, kaybolmuyor.
     */
    /**
     * Skor konu + gövde parçası ile hesaplanıyor.
     *
     * Yalnızca konuya bakmak yanıltıyordu (2026-08-22 ölçümü):
     * "Siparişiniz teslim edildi" tek başına %51 alıp bildirimi
     * engelliyordu, tam metinle %2. Model konu+gövde ile eğitildi.
     *
     * `snippet` yalnızca burada kullanılıyor; bildirim yüküne girmiyor.
     */
    const parca = metin(g["snippet"]) ?? "";
    const [skor] = await spamSkorla([`${konu} ${parca}`.trim().slice(0, 4000)]);
    /**
     * Bildirim bastırma İKİ DİLDE de geçerli.
     *
     * Eskiden İngilizce muaftı: o model SMS ile eğitilmişti ve her şeye
     * spam diyordu, ona uyulsa İngilizce maillerin hiçbirinde bildirim
     * gelmezdi. Model 2026-08-24'te gerçek e-posta ile yeniden eğitildi
     * ve muafiyet kalktı — spam olan mailde, dili ne olursa olsun,
     * telefon titremiyor.
     *
     * Eşik burada %50 (taşımanınki %90). İkisi kasten farklı: bildirimi
     * kaçırmanın bedeli mailin geç görülmesi, taşımanınki ise
     * kullanıcının maili başka klasörde araması. Ucuz hatada daha
     * atak, pahalı hatada daha temkinli davranıyoruz.
     */
    /**
     * TAŞIMA KARARI BURADA VERİLİYOR — mail geldiği ANDA.
     *
     * Eskiden taşıma yalnızca kullanıcı gelen kutusunu açtığında
     * (`bakimYap`) yapılabiliyordu, çünkü sunucu IMAP parolasını
     * saklamıyor. Ama bu kancayı çağıran İZLEYİCİ maildir dosyasına
     * doğrudan erişiyor — taşıma bir DOSYA işlemi, IMAP gerekmiyor.
     *
     * Karar burada veriliyor (model ve eşikler burada), taşımayı
     * izleyici yapıyor. Böylece spam kullanıcı hiçbir şey yapmadan,
     * geldiği saniye Spam klasörüne gidiyor.
     *
     * Doğrulanmış gönderen (BIMI/VMC ya da DMARC zorlaması) asla
     * taşınmıyor — `bakimYap`'taki güvenceyle aynı.
     */
    const puan = skor?.skor ?? 0;
    const dil = skor?.model ?? "tr";
    let tasi = puan >= tasimaEsigi(dil);
    if (tasi) {
      // İzleyici adresi ayrı gönderiyor; `gonderen` yalnızca görünen ad.
      const adres = (metin(g["fromAddress"]) ?? gonderen.match(/<([^>]+)>/)?.[1] ?? "").trim();
      const avatar = adres.includes("@")
        ? await avatarGetir(adres).catch(() => null)
        : null;
      if (avatar?.verified) tasi = false;
    }

    if (puan > SPAM_ESIGI) {
      return reply.send({
        atlandi: `spam %${Math.round(puan * 100)}`,
        acikSekme,
        tasi,
        skor: puan,
        dil,
      });
    }

    const sonuc = await bildirimGonder(kullanici.id, {
      baslik: gonderen || "Yeni mail",
      govde: konu,
      url: "/",
    });
    return reply.send({ ...sonuc, acikSekme, tasi: false, skor: puan, dil });
  });
}
