-- Aktaş Mail — 2026-08-21
-- Avatar (BIMI/Gravatar) + profil fotoğrafı için şema deltası.
--
-- Proje `drizzle-kit push` kullanıyor, göç geçmişi tutmuyor. Bu dosya
-- canlıya elle uygulanabilsin diye yazıldı; hepsi IF NOT EXISTS, yani
-- iki kez çalıştırmak zararsız.
--
-- DİKKAT: `psql -U postgres` ile çalıştırırsan yeni tablo postgres'e ait
-- olur ve uygulamanın rolünün HİÇBİR yetkisi olmaz — uçlar sessizce 500
-- döner. Diğer tabloların hepsi `aktasmail`'e ait. Bu yüzden sonda
-- açıkça sahiplik veriliyor.

-- 1) Kullanıcının kendi profil fotoğrafı (data: URI, istemcide 256x256
--    WebP'ye küçültülmüş hâli). Boyut/tür doğrulaması uygulama tarafında.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar text;

-- 2) Gönderen avatarı önbelleği.
--    key: ya domain ("tiktok.com" — BIMI) ya tam adres ("ali@x.com" — Gravatar)
--    verified: VMC doğrulanmış marka, yani mavi tik
CREATE TABLE IF NOT EXISTS sender_avatars (
  key        text PRIMARY KEY,
  image      text,
  verified   boolean NOT NULL DEFAULT false,
  source     text NOT NULL DEFAULT 'none',
  fetched_at timestamp with time zone NOT NULL DEFAULT now()
);

-- 3) Sahiplik. Bu satır olmadan uygulama tabloya erişemez (2026-08-21'de
--    tam olarak bu yaşandı: /api/sender-avatars 16 kez 500 döndü).
ALTER TABLE sender_avatars OWNER TO aktasmail;
