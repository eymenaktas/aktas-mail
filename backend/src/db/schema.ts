import {
  pgTable,
  jsonb,
  doublePrecision,
  serial,
  text,
  timestamp,
  boolean,
  integer,
  inet,
  index,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core";

/**
 * TEK PAROLA MODELİ (karar: 2026-08-18)
 *
 * Kullanıcı posta kutusunun parolasıyla girer; doğrulamayı Dovecot yapar.
 * Uygulamanın kendi parolası YOK — bu yüzden `password_hash` sütunu da yok.
 *
 * Parola doğrulandıktan sonra, kullanıcı ikinci faktör kurmuşsa ondan
 * geçmesi gerekir: TOTP, passkey ya da güvenilen cihaz ("HWID").
 */

export const secondFactorEnum = pgEnum("second_factor", [
  "none",
  "totp",
  "passkey",
  "device", // güvenilen cihaz anahtarı — "HWID"nin gerçek karşılığı
]);

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    /** Posta kutusunun tam adresi: eymen@akts.tr */
    email: text("email").notNull(),
    displayName: text("display_name"),

    /**
     * Kullanıcının kendi profil fotoğrafı — `data:image/...;base64,...`.
     * İstemci yüklemeden önce 256x256'ya küçültüp WebP'ye çeviriyor, o
     * yüzden sunucuda görüntü işleme kütüphanesi (sharp vb.) yok.
     * Boyut sınırı ve tür doğrulaması yükleme ucunda.
     */
    avatar: text("avatar"),

    /**
     * Cihazdan bağımsız kullanıcı tercihleri (tema, renk, desen...).
     *
     * Önce yalnızca localStorage'daydı, yani her cihazda ayrı ayrı
     * ayarlamak gerekiyordu. Artık hesapta duruyor; localStorage
     * yalnızca ilk boyamada beklememek için ÖNBELLEK olarak kalıyor.
     *
     * jsonb: şema değişmeden yeni tercih eklenebilsin diye. İçeriği
     * uygulama tarafında Zod ile doğrulanıyor.
     */
    settings: jsonb("settings"),

    /** Kullanıcının seçtiği ikinci faktör. "none" = sadece parola. */
    secondFactor: secondFactorEnum("second_factor").notNull().default("none"),

    /**
     * TOTP gizli anahtarı, ENCRYPTION_KEY ile AES-256-GCM şifreli.
     * Oturum anahtarıyla DEĞİL: giriş sırasında, henüz oturum yokken
     * çözülebilmesi gerekiyor.
     */
    totpSecretEnc: text("totp_secret_enc"),
    totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),

    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_key").on(t.email)],
);

/**
 * Cihaz bağlama. Özel anahtar cihazdan çıkmaz (Android Keystore /
 * non-extractable CryptoKey); burada yalnızca AÇIK anahtar durur.
 *
 * Mobilde "çıkış yapana kadar hatırla" bu tabloyla çalışır: cihaz bir kez
 * onaylanır, refresh token'ı ona bağlanır, kullanıcı çıkış yapana kadar
 * oturum yenilenmeye devam eder.
 */
export const devices = pgTable(
  "devices",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    label: text("label").notNull(),
    platform: text("platform").notNull(), // web | android
    publicKey: text("public_key").notNull(), // base64url SPKI

    /** Tanınmayan cihaz onay bekler; onaylanana kadar oturum açamaz. */
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    /** Android Keystore ile sarmalanmış IMAP parolası (passkey'deki ile aynı fikir). */
    wrappedSecret: text("wrapped_secret"),

    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastSeenIp: inet("last_seen_ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("devices_user_idx").on(t.userId),
    uniqueIndex("devices_pubkey_key").on(t.publicKey),
  ],
);

/** Passkey (WebAuthn) kimlik bilgileri. */
export const webauthnCredentials = pgTable(
  "webauthn_credentials",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    credentialId: text("credential_id").notNull(), // base64url
    publicKey: text("public_key").notNull(), // base64url COSE
    counter: integer("counter").notNull().default(0),
    transports: text("transports"), // JSON dizi
    label: text("label"),

    /**
     * IMAP parolası, passkey'in PRF uzantısından türeyen anahtarla
     * sarmalanmış. SUNUCU BUNU ÇÖZEMEZ — anahtar yalnızca authenticator
     * içinde üretilir. Sayesinde kullanıcı ilk girişten sonra bir daha
     * parola yazmaz.
     *
     * Sunucuda (istemcide değil) durmasının sebebi: passkey'ler iCloud /
     * Google hesabıyla senkronlanıyor, yani aynı passkey yeni bir
     * cihazda da çalışmalı. İstemcide saklansa yeni cihaz çözemezdi.
     */
    wrappedSecret: text("wrapped_secret"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [
    index("webauthn_user_idx").on(t.userId),
    uniqueIndex("webauthn_cred_key").on(t.credentialId),
  ],
);

/**
 * Kurtarma kodları. Yüksek entropili rastgele değerler olduğu için
 * SHA-256 yeterli (Argon2 düşük entropili insan parolaları içindir).
 */
export const recoveryCodes = pgTable(
  "recovery_codes",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("recovery_user_idx").on(t.userId)],
);

/**
 * Parola doğrulandı, ikinci faktör bekleniyor.
 * IMAP parolası burada da şifreli: anahtar istemcide, sunucuda değil.
 * Kısa ömürlü (5 dk).
 */
export const pendingLogins = pgTable("pending_logins", {
  id: text("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),

  /**
   * Parola akışında dolu. Passkey akışında BOŞ: parolayı istemci
   * sarmalı çözdükten sonra ikinci adımda gönderiyor.
   */
  imapPasswordEnc: text("imap_password_enc"),
  /** WebAuthn/cihaz imzası için tek kullanımlık challenge */
  challenge: text("challenge"),
  /** Passkey doğrulandı, parola bekleniyor mu */
  passkeyVerified: boolean("passkey_verified").notNull().default(false),

  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdIp: inet("created_ip"),
});

/**
 * Refresh token'lar cihaza bağlıdır ve DÖNER (rotation).
 * Aynı token ikinci kez kullanılırsa çalınmış demektir → o kullanıcının
 * tüm oturumları kapatılır (reuse detection).
 */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: integer("device_id").references(() => devices.id, { onDelete: "cascade" }),

    /**
     * IMAP parolası, oturum anahtarıyla şifreli.
     * Anahtar yalnızca istemcinin çerezinde — DB dökümü tek başına
     * posta parolasını vermez.
     */
    imapPasswordEnc: text("imap_password_enc").notNull(),

    /** Token'ın kendisi değil, SHA-256 özeti. */
    refreshTokenHash: text("refresh_token_hash").notNull(),
    /** Rotasyon zinciri: bu token hangisinin yerine geçti. */
    previousId: text("previous_id"),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Doluysa ve tekrar kullanılırsa: hırsızlık → tüm oturumlar kapanır. */
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdIp: inet("created_ip"),
  },
  (t) => [
    index("sessions_user_idx").on(t.userId),
    uniqueIndex("sessions_refresh_key").on(t.refreshTokenHash),
  ],
);

/** Denetim kaydı — içerik değil, yalnızca metadata. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),

    action: text("action").notNull(), // login.ok, login.fail, 2fa.ok, device.add, mail.send ...
    detail: text("detail"),
    ip: inet("ip"),
    userAgent: text("user_agent"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_user_time_idx").on(t.userId, t.createdAt)],
);

/**
 * Gönderen avatarı önbelleği (BIMI).
 *
 * Gmail'in gönderen logolarını ve "mavi tik"ini nereden aldığı sorusunun
 * cevabı: BIMI (Brand Indicators for Message Identification). Domain
 * `default._bimi.<domain>` TXT kaydında logosunun SVG adresini yayınlar.
 * Kayıtta `a=` ile bir VMC (Verified Mark Certificate) varsa marka bir
 * sertifika otoritesi tarafından doğrulanmış demektir — mavi tik budur.
 * Gmail'den veri çekmiyoruz; Gmail'in de kullandığı AÇIK kaynağa bakıyoruz.
 *
 * Önbellek şart: her mail açılışında DNS + HTTP isteği atmak hem yavaş
 * hem de gönderene "bu mail okundu" sinyali verir. Aramalar sunucudan
 * yapılır, tarayıcıdan değil — kullanıcının IP'si gönderene sızmaz.
 */
export const senderAvatars = pgTable(
  "sender_avatars",
  {
    /** Ya bir domain ("tiktok.com" — BIMI) ya tam adres ("ali@x.com" — Gravatar) */
    key: text("key").primaryKey(),
    /** data: URI olarak logo/fotoğraf; bulunamadıysa null */
    image: text("image"),
    /** VMC doğrulanmış mı — arayüzdeki mavi tik */
    verified: boolean("verified").notNull().default(false),
    /** bimi | gravatar | none */
    source: text("source").notNull().default("none"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * Spam eğitim verisi — kullanıcının elle işaretlediği mailler.
 *
 * Mevcut model (ML kampı Gün 1) SMS spam'i ve küçük bir Türkçe e-posta
 * kümesiyle eğitildi; gerçek gelen kutusunda yanılıyor (kargo maillerine
 * spam diyor, bazı gerçek spam'i kaçırıyor). Doğru çözüm eşikle oynamak
 * değil, MODELİ GERÇEK VERİYLE YENİDEN EĞİTMEK. Bu tablo o veriyi
 * biriktiriyor.
 *
 * Ne saklanıyor: konu + gövdenin ilk kısmı (düz metin). Tam mail
 * saklanmıyor — eğitim için gerekmiyor ve gereksiz kopya risk demek.
 * `modelSkoru` da yazılıyor ki sonradan "model nerede yanılmış"
 * sorusu cevaplanabilsin.
 */
export const spamLabels = pgTable(
  "spam_labels",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** "spam" | "ham" */
    label: text("label").notNull(),
    /** İşaret nereden geldi: "elle" (düğme) | "tasima" (kullanıcı klasör değiştirdi) */
    kaynak: text("kaynak").notNull().default("elle"),

    subject: text("subject").notNull().default(""),
    /** Gövdenin düz metin hâli, kırpılmış */
    body: text("body").notNull().default(""),
    fromAddress: text("from_address"),

    /** İşaretlendiği andaki model skoru — "nerede yanılmış" analizi için */
    modelSkoru: doublePrecision("model_skoru"),
    modelDili: text("model_dili"),

    /** Aynı maili iki kez toplamamak için */
    messageKey: text("message_key").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("spam_labels_user_idx").on(t.userId),
    uniqueIndex("spam_labels_msg_key").on(t.userId, t.messageKey),
  ],
);

/**
 * Web push abonelikleri.
 *
 * Her cihaz (tarayıcı profili) için ayrı bir kayıt: aynı hesap iki
 * telefondan açıldıysa iki abonelik olur ve bildirim ikisine de gider.
 *
 * `endpoint` tarayıcının push servisinin adresi (Chrome için FCM, Safari
 * için Apple) ve KİMLİK görevi görüyor — birincil anahtar o.
 * `p256dh` + `auth` ise şifreleme anahtarları: push servisi mesajın
 * içeriğini OKUYAMIYOR, yalnızca cihaza iletiyor.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    endpoint: text("endpoint").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    /** Hangi cihaz olduğunu ayırt etmek için (Ayarlar'da listelenir) */
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  },
  (t) => [index("push_user_idx").on(t.userId)],
);
