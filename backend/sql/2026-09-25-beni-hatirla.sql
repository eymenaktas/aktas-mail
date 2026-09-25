-- "Beni hatırla": kalıcı çerez + kayan süre. Mevcut oturumlar hatırlanan sayılır.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS remember boolean NOT NULL DEFAULT true;
