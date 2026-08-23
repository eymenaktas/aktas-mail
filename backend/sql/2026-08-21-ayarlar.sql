-- Aktaş Mail — 2026-08-21
-- Cihazdan bağımsız kullanıcı tercihleri (tema, renk, desen).
--
-- Önce yalnızca localStorage'daydı, her cihazda ayrı ayarlamak
-- gerekiyordu. jsonb: yeni tercih eklerken şema değiştirmemek için.
ALTER TABLE users ADD COLUMN IF NOT EXISTS settings jsonb;

-- Sütun eklemede sahiplik değişmiyor (tablo zaten aktasmail'in), ama
-- yeni TABLO eklersen `ALTER TABLE ... OWNER TO aktasmail` şart:
-- 2026-08-21'de sender_avatars bu yüzden 16 kez 500 döndürmüştü.
