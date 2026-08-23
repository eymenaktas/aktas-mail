import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { unpackSessionCookie } from "../lib/crypto.js";
import { loadSession } from "../auth/session.js";
import { audit } from "../lib/audit.js";
import { SESSION_COOKIE } from "./auth.js";

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

/**
 * Profil fotoğrafı, `data:` URI olarak saklanıyor.
 *
 * Küçültme İSTEMCİDE yapılıyor (canvas ile 256x256 WebP). Sunucuda görüntü
 * işlemek istemedik: sharp/ImageMagick gibi kütüphaneler kendi başlarına
 * bir saldırı yüzeyi (hazırlanmış görüntülerle çıkan RCE'ler bu sınıfın
 * klasik açığı). Sunucu yalnızca DOĞRULAR: tür, boyut ve sihirli baytlar.
 */
const MAKS_BAYT = 512 * 1024;

const IZINLI: Record<string, RegExp> = {
  "image/webp": /^RIFF....WEBP/s,
  "image/png": /^\x89PNG\r\n\x1a\n/,
  "image/jpeg": /^\xff\xd8\xff/,
};

const avatarSemasi = z.object({
  // data:image/webp;base64,....
  avatar: z
    .string()
    .max(Math.ceil(MAKS_BAYT * 1.4))
    .regex(/^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/]+=*$/, "Desteklenmeyen görüntü"),
});

/** Base64 gövdesinin gerçekten iddia ettiği tür olduğunu doğrular. */
function govdeyiDogrula(dataUri: string): { ok: true; bayt: number } | { ok: false; hata: string } {
  const [bas, b64] = dataUri.split(",", 2);
  const tip = bas?.match(/^data:([^;]+);base64$/)?.[1] ?? "";
  const desen = IZINLI[tip];
  if (!desen || !b64) return { ok: false, hata: "Desteklenmeyen görüntü türü" };

  let ham: Buffer;
  try {
    ham = Buffer.from(b64, "base64");
  } catch {
    return { ok: false, hata: "Görüntü çözülemedi" };
  }
  if (ham.byteLength === 0) return { ok: false, hata: "Boş görüntü" };
  if (ham.byteLength > MAKS_BAYT) {
    return { ok: false, hata: `Görüntü çok büyük (en fazla ${MAKS_BAYT / 1024} KB)` };
  }
  // Uzantıya/başlığa değil İÇERİĞE bak: ".png" diye gelen bir HTML dosyası
  // burada elenir.
  if (!desen.test(ham.toString("latin1"))) {
    return { ok: false, hata: "Dosya içeriği türüyle uyuşmuyor" };
  }
  return { ok: true, bayt: ham.byteLength };
}

/**
 * Cihazdan bağımsız tercihler.
 *
 * Şema DAR tutuluyor: bilinmeyen alanlar Zod tarafından sessizce
 * düşürülüyor, yani istemci buraya keyfi veri depolayamıyor.
 */
const ayarSemasi = z.object({
  tema: z.enum(["light", "dark"]).optional(),
  arkaplan: z.string().max(24).optional(),
  desen: z.string().max(24).optional(),
  okumaTemasi: z.enum(["auto", "light", "dark"]).optional(),
});

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/profile", async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const [kullanici] = await db
      .select({
        email: users.email,
        displayName: users.displayName,
        avatar: users.avatar,
        settings: users.settings,
      })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    return reply.send({ profile: kullanici ?? null });
  });

  /**
   * Tercihleri kaydet. Kısmi güncelleme: gönderilen alanlar mevcutların
   * üstüne yazılıyor, gönderilmeyenler korunuyor — böylece iki cihaz
   * farklı alanları aynı anda değiştirdiğinde biri ötekini silmiyor.
   */
  app.put("/api/profile/settings", async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const govde = ayarSemasi.safeParse(req.body);
    if (!govde.success) {
      return reply.code(400).send({ error: "Geçersiz ayar" });
    }

    const [mevcut] = await db
      .select({ settings: users.settings })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    const birlesik = {
      ...((mevcut?.settings as Record<string, unknown>) ?? {}),
      ...govde.data,
    };

    await db
      .update(users)
      .set({ settings: birlesik, updatedAt: new Date() })
      .where(eq(users.id, session.userId));

    return reply.send({ settings: birlesik });
  });

  app.post("/api/profile/avatar", async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const govde = avatarSemasi.safeParse(req.body);
    if (!govde.success) {
      return reply.code(400).send({ error: govde.error.issues[0]?.message ?? "Geçersiz istek" });
    }

    const dogrulama = govdeyiDogrula(govde.data.avatar);
    if (!dogrulama.ok) return reply.code(400).send({ error: dogrulama.hata });

    await db
      .update(users)
      .set({ avatar: govde.data.avatar, updatedAt: new Date() })
      .where(eq(users.id, session.userId));

    await audit({
      userId: session.userId,
      action: "profile.avatar.set",
      detail: `${dogrulama.bayt} bayt`,
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
    });
    return reply.send({ ok: true });
  });

  app.delete("/api/profile/avatar", async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    await db
      .update(users)
      .set({ avatar: null, updatedAt: new Date() })
      .where(eq(users.id, session.userId));

    await audit({
      userId: session.userId,
      action: "profile.avatar.cleared",
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
    });
    return reply.send({ ok: true });
  });
}
