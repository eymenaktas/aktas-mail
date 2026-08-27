import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Redis from "ioredis";
import { env, isProd } from "./env.js";
import { authRoutes } from "./routes/auth.js";
import { mailRoutes } from "./routes/mail.js";
import { passkeyRoutes } from "./routes/passkey.js";
import { adminRoutes } from "./routes/admin.js";
import { profileRoutes } from "./routes/profile.js";
import { pushRoutes } from "./routes/push.js";
import { eventRoutes } from "./routes/events.js";
import { spamRoutes } from "./routes/spam.js";
import { jarvisRoutes } from "./routes/jarvis.js";
import { closeDb } from "./db/index.js";

/**
 * mail.akts.tr Cloudflare proxy'sinin ARKASINDA DEĞİL (SMTP/IMAP proxy'den
 * geçemiyor). Yani WAF ve DDoS kalkanı yok — rate limit ve güvenlik
 * başlıkları burada opsiyonel değil, tek savunma katmanı.
 */
const app = Fastify({
  logger: isProd
    ? { level: "info" }
    : { level: "debug", transport: { target: "pino-pretty" } },
  // Ters vekil (nginx) arkasında gerçek istemci IP'si için
  trustProxy: true,
  bodyLimit: 1024 * 1024, // 1 MB
});

await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"], // inline script yok
      styleSrc: ["'self'", "'unsafe-inline'"], // mail gövdesi inline style kullanıyor
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"], // clickjacking
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: "no-referrer" },
});

await app.register(cors, {
  origin: env.APP_ORIGIN,
  credentials: true, // çerez tabanlı oturum
});

await app.register(cookie, {
  secret: env.COOKIE_SECRET,
});

/**
 * Rate limit sayaçları Redis'te.
 * Bellek içi sayaç tek süreçte doğru çalışır, ama PM2 ile çok örnekli
 * çalıştırılırsa her örnek kendi sayacını tutar ve limit sessizce
 * örnek sayısı katına çıkar. Cloudflare kalkanı olmadığı için bu
 * fark burada doğrudan güvenlik sorunu.
 */
const redis = env.REDIS_URL
  ? new Redis(env.REDIS_URL, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
      // rate-limit eklentisinin beklediği davranış
      enableOfflineQueue: false,
    })
  : null;

if (redis) {
  /**
   * Redis düşerse `skipOnError` sayesinde servis ayakta kalır — ama
   * o sırada RATE LIMIT DE YOK. Sessizce korumasız kalmamak için
   * durum değişimleri açıkça loglanıyor.
   */
  let uyarildi = false;
  redis.on("error", (err: Error) => {
    if (!uyarildi) {
      app.log.error({ err }, "redis erişilemiyor — RATE LIMIT DEVRE DIŞI");
      uyarildi = true;
    }
  });
  redis.on("ready", () => {
    if (uyarildi) app.log.warn("redis geri geldi — rate limit yeniden aktif");
    else app.log.info("redis bağlandı");
    uyarildi = false;
  });
} else {
  app.log.warn(
    "REDIS_URL yok — rate limit bellekte tutuluyor. Çok örnekli çalıştırmada limit bozulur.",
  );
}

await app.register(rateLimit, {
  global: true,
  max: 300,
  timeWindow: "1 minute",
  // nginx real_ip sayesinde gerçek ziyaretçi IP'si geliyor
  keyGenerator: (req) => req.ip,
  /**
   * Redis erişilemezse isteği REDDETME, sadece say(a)ma.
   *
   * Bu varsayılan olarak açık ama açıkça yazıyorum: kapalıyken Redis'in
   * bir anlık kesintisi API'nin tamamını 500'e düşürüyor — yani posta
   * kutusuna erişim, rate limit sayacı yüzünden komple kapanıyor.
   * Sayaç tutulamaması, servisin durmasından iyidir.
   */
  skipOnError: true,
  ...(redis ? { redis } : {}),
});

app.get("/api/health", async () => ({
  status: "ok",
  time: new Date().toISOString(),
}));

await app.register(authRoutes);
await app.register(passkeyRoutes);
await app.register(mailRoutes);
await app.register(adminRoutes);
await app.register(profileRoutes);
await app.register(pushRoutes);
await app.register(eventRoutes);
await app.register(spamRoutes);
// Jarvis: ayrı kimlik, ayrı kapı, salt okuma. Yapılandırılmamışsa
// uçlar 503 dönüyor — kurulmadan da uygulama normal çalışıyor.
await app.register(jarvisRoutes);

// Hata gövdesinde yığın izi sızmasın
app.setErrorHandler((error: unknown, req, reply) => {
  req.log.error({ err: error }, "istek hatası");
  const e = error as { statusCode?: number; message?: string };
  const status = e.statusCode ?? 500;
  reply.code(status).send({
    error: status >= 500 ? "Sunucu hatası" : (e.message ?? "İstek hatası"),
  });
});

async function shutdown(signal: string): Promise<void> {
  app.log.info(`${signal} alındı, kapanıyor`);
  await app.close();
  await closeDb();
  if (redis) redis.disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ port: env.PORT, host: env.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
