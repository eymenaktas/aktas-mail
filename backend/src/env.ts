import { z } from "zod";

/**
 * Tüm yapılandırma buradan geçer. Şema dışında kalan bir env değişkeni
 * uygulamaya sızmaz; eksik/bozuk değer varsa süreç AÇILIŞTA ölür —
 * yarım yapılandırmayla çalışan bir posta sunucusu, hiç çalışmayandan
 * daha tehlikelidir.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().default("127.0.0.1"),

  // PostgreSQL
  DATABASE_URL: z.string().url(),

  /**
   * Redis — rate limit sayaçları.
   * Boş bırakılırsa bellek içi sayaç kullanılır: tek süreçte doğru
   * çalışır ama PM2 ile çok örnekli çalıştırılırsa her örnek kendi
   * sayacını tutar ve limit sessizce N katına çıkar. mail.akts.tr'de
   * Cloudflare kalkanı olmadığı için üretimde bu ayarlanmalı.
   */
  REDIS_URL: z.string().url().optional(),

  // Oturum çerezi imzalama — en az 32 bayt rastgele
  COOKIE_SECRET: z.string().min(32, "COOKIE_SECRET en az 32 karakter olmalı"),

  /**
   * Sunucu tarafı sırlar için AES-256-GCM anahtarı (base64url, 32 bayt).
   * Sadece giriş sırasında oturum yokken çözülmesi gereken şeyler için:
   * TOTP gizli anahtarları. IMAP parolası bununla DEĞİL, istemcideki
   * oturum anahtarıyla şifrelenir.
   * DEĞİŞTİRİLİRSE kayıtlı TOTP kurulumları geçersiz olur.
   */
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64url").length === 32, {
      message: "ENCRYPTION_KEY base64url kodlu tam 32 bayt olmalı",
    }),

  // Dovecot (yerel) — uygulama dışarıya değil, kendi IMAP'ine bağlanır
  IMAP_HOST: z.string().default("127.0.0.1"),
  IMAP_PORT: z.coerce.number().int().default(143),
  IMAP_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // Postfix submission (yerel)
  SMTP_HOST: z.string().default("127.0.0.1"),
  SMTP_PORT: z.coerce.number().int().default(587),

  MAIL_DOMAIN: z.string().default("akts.tr"),

  /**
   * Yönetici adresi. DB'den değil env'den okunuyor: veritabanına
   * yazabilen biri kendini admin yapamasın.
   */
  ADMIN_EMAIL: z.string().email().default("eymen@akts.tr"),
  // Tarayıcı arayüzünün origin'i — CORS ve çerez kapsamı için
  APP_ORIGIN: z.string().url().default("https://mail.akts.tr"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Yapılandırma hatası — sunucu başlatılmadı:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
