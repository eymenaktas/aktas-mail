-- Aktaş Mail — 2026-08-21 (ikinci delta)
-- Spam modeli eğitim verisi toplayıcı.
--
-- DİKKAT: postgres ile çalıştırırsan sonda OWNER satırı ŞART, yoksa
-- uygulamanın rolü tabloya erişemez ve uçlar sessizce 500 döner.
-- (Bir önceki deltada tam olarak bu yaşandı.)

CREATE TABLE IF NOT EXISTS spam_labels (
  id           serial PRIMARY KEY,
  user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        text NOT NULL,
  kaynak       text NOT NULL DEFAULT 'elle',
  subject      text NOT NULL DEFAULT '',
  body         text NOT NULL DEFAULT '',
  from_address text,
  model_skoru  double precision,
  model_dili   text,
  message_key  text NOT NULL,
  created_at   timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS spam_labels_user_idx ON spam_labels (user_id);

-- Aynı mail iki kez toplanmasın; fikir değişirse kayıt GÜNCELLENİR.
CREATE UNIQUE INDEX IF NOT EXISTS spam_labels_msg_key
  ON spam_labels (user_id, message_key);

ALTER TABLE spam_labels OWNER TO aktasmail;
ALTER SEQUENCE spam_labels_id_seq OWNER TO aktasmail;
