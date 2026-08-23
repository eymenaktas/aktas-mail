import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { unpackSessionCookie } from "../lib/crypto.js";
import { loadSession } from "../auth/session.js";
import { SESSION_COOKIE } from "./auth.js";

/**
 * Canlı olay akışı (Server-Sent Events).
 *
 * ## Neden gerekli
 *
 * Bildirim mail teslim edildiği anda gidiyor ama LİSTE yenilenmiyordu:
 * kullanıcı sayfayı tazeleyene kadar yeni mail görünmüyordu. Bildirimi
 * tetikleyen aynı kanca artık açık sekmelere de haber veriyor.
 *
 * ## Neden SSE, WebSocket değil
 *
 * Akış tek yönlü: sunucu "yeni mail var" diyor, istemcinin bir şey
 * söylemesi gerekmiyor. SSE düz HTTP üzerinden çalışıyor, tarayıcı
 * kopan bağlantıyı kendisi geri kuruyor ve oturum çerezi otomatik
 * gidiyor. WebSocket bu iş için gereksiz karmaşık olurdu.
 *
 * ## Ne gönderiliyor
 *
 * Yalnızca "yeni mail geldi" sinyali ve klasör adı — mailin kendisi
 * DEĞİL. İstemci sinyali alınca listeyi normal yollardan çekiyor,
 * yani yetkilendirme her zamanki gibi işliyor.
 */

interface Baglanti {
  userId: number;
  reply: FastifyReply;
}

/** Açık bağlantılar. Süreç yeniden başlarsa tarayıcı kendisi yeniden bağlanır. */
const baglantilar = new Set<Baglanti>();

/** Bir kullanıcının açık sekmelerine olay yollar. */
export function yayinla(userId: number, olay: Record<string, unknown>): number {
  let gonderilen = 0;
  for (const b of baglantilar) {
    if (b.userId !== userId) continue;
    try {
      b.reply.raw.write(`data: ${JSON.stringify(olay)}\n\n`);
      gonderilen += 1;
    } catch {
      baglantilar.delete(b);
    }
  }
  return gonderilen;
}

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/events", async (req: FastifyRequest, reply: FastifyReply) => {
    const cookie = req.cookies[SESSION_COOKIE];
    const unpacked = cookie ? unpackSessionCookie(cookie) : null;
    if (!unpacked) return reply.code(401).send({ error: "Oturum yok" });

    const session = await loadSession(unpacked.sessionId, unpacked.sessionKey);
    if (!session) return reply.code(401).send({ error: "Oturum geçersiz" });

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // nginx SSE'yi tamponlarsa olaylar birikip toplu düşer — anlıklık
      // biter. Bu başlık nginx'e o bağlantıda tamponlamayı kapattırıyor,
      // yani sunucu yapılandırmasını değiştirmeye gerek kalmıyor.
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(`data: ${JSON.stringify({ tip: "baglandi" })}\n\n`);

    const baglanti: Baglanti = { userId: session.userId, reply };
    baglantilar.add(baglanti);

    /**
     * Canlı tutma sinyali. Araya giren vekil sunucular ve mobil ağlar
     * sessiz bağlantıyı bir süre sonra kapatıyor; 25 saniyede bir yorum
     * satırı göndermek bunu engelliyor (yorumlar istemcide olay
     * tetiklemiyor).
     */
    const kalpAtisi = setInterval(() => {
      try {
        reply.raw.write(": ping\n\n");
      } catch {
        temizle();
      }
    }, 25_000);

    function temizle() {
      clearInterval(kalpAtisi);
      baglantilar.delete(baglanti);
    }

    req.raw.on("close", temizle);
    req.raw.on("error", temizle);

    // Fastify'a cevabı bizim yönettiğimizi söyle
    return reply;
  });
}
