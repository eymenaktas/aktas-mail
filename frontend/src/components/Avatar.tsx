import { useMemo } from "react";
import type { SenderAvatar } from "../lib/api.js";

/**
 * Gönderen avatarı.
 *
 * Üç kaynak, bu sırayla:
 *   1. BIMI  — markanın DNS'te yayınladığı resmî logo. VMC sertifikası
 *              varsa MAVİ TİK gösterilir (Gmail'in tiki de budur).
 *   2. Gravatar — kişinin e-postasına bağlı fotoğraf. Doğrulanmamış,
 *              tik yok: Gravatar kimlik kanıtlamaz, herkes fotoğraf koyar.
 *   3. Harf avatarı — hiçbiri yoksa. Renk adresten türetiliyor, yani
 *              aynı gönderen her zaman aynı rengi alıyor.
 *
 * Gmail'in profil fotoğrafları çekilemiyor: Google başkalarının fotoğrafını
 * veren public bir uç sunmuyor.
 */

/** Okunabilir, birbirinden ayrılan tonlar. */
const RENKLER = [
  "#3b6ea5", "#a35f3b", "#4a7c59", "#8a4f7d",
  "#b07d2b", "#3f6f7d", "#8c3f4a", "#5b5ea6",
];

function renkSec(anahtar: string): string {
  let toplam = 0;
  for (let i = 0; i < anahtar.length; i += 1) toplam = (toplam * 31 + anahtar.charCodeAt(i)) >>> 0;
  return RENKLER[toplam % RENKLER.length] as string;
}

function basHarf(isim: string, adres: string): string {
  const kaynak = isim.trim() || adres.trim();
  const ilk = [...kaynak].find((c) => /\p{L}|\p{N}/u.test(c));
  return (ilk ?? "?").toLocaleUpperCase("tr-TR");
}

export function Avatar({
  name,
  address,
  avatar,
  size = 36,
}: {
  name: string;
  address: string;
  avatar?: SenderAvatar | undefined;
  size?: number;
}) {
  const renk = useMemo(() => renkSec(address || name), [address, name]);
  const harf = basHarf(name, address);
  const tikBoyu = Math.max(12, Math.round(size * 0.4));

  return (
    <span
      className="avatar"
      style={{ width: size, height: size }}
      /*
        İpucu metni DAYANAĞI söylüyor — iki tikin güvencesi farklı:
          bimi  = markayı bir sertifika otoritesi doğrulamış (güçlü)
          dmarc = domain taklit edilemiyor, ama kime ait olduğu
                  doğrulanmamış (zayıf)
      */
      title={
        !avatar?.verified
          ? address
          : avatar.source === "bimi"
            ? `${address} — logosu BIMI ile yayınlanmış ve bir sertifika otoritesince doğrulanmış (VMC)`
            : `${address} — bu domain DMARC'ı "reject"e almış, yani taklit edilemiyor. ` +
              `Mail gerçekten bu domainden geliyor. (Marka doğrulaması yok.)`
      }
    >
      {avatar?.image ? (
        <img className="avatar-img" src={avatar.image} alt="" width={size} height={size} />
      ) : (
        <span className="avatar-harf" style={{ background: renk, fontSize: size * 0.42 }}>
          {harf}
        </span>
      )}

      {avatar?.verified && (
        <svg
          className="avatar-tik"
          width={tikBoyu}
          height={tikBoyu}
          viewBox="0 0 24 24"
          aria-label="Doğrulanmış gönderen"
        >
          {/* Gmail'inkiyle aynı anlam: marka bir sertifika otoritesince doğrulanmış */}
          <path
            fill="#1a73e8"
            d="M12 1.5l2.6 2 3.2-.3 1 3.1 2.7 1.8-1.2 3 1.2 3-2.7 1.8-1 3.1-3.2-.3-2.6 2-2.6-2-3.2.3-1-3.1L2.5 15l1.2-3-1.2-3 2.7-1.8 1-3.1 3.2.3 2.6-2z"
          />
          <path
            fill="#fff"
            d="M10.8 15.4l-3-3 1.3-1.3 1.7 1.7 4.1-4.1 1.3 1.3-5.4 5.4z"
          />
        </svg>
      )}
    </span>
  );
}
