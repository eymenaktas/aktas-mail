import { useEffect, useRef, useState } from "react";
import { api, type Profile } from "../lib/api.js";
import { Avatar } from "./Avatar.js";

/**
 * Profil fotoğrafı.
 *
 * Küçültme ve WebP'ye çevirme BURADA, tarayıcıda yapılıyor. Sunucuya
 * hazır bir görüntü işleme kütüphanesi (sharp/ImageMagick) koymadık
 * bilerek: hazırlanmış görüntülerle tetiklenen bellek hataları o
 * kütüphanelerin klasik açığı ve gereksiz bir saldırı yüzeyi olurdu.
 * Sunucu yalnızca doğruluyor: tür, boyut, sihirli baytlar.
 *
 * > [!note] Bu fotoğraf dışarıya YANSIMAZ
 * > Yalnızca bu uygulamada görünür. Gmail'de görünmesi için `akts.tr`
 * > domaininin BIMI yayınlaması gerekir; Gmail bunu göstermek için VMC
 * > sertifikası da şart koşuyor (tescilli marka + yıllık ücret) ve ön
 * > koşulu DMARC'ın zorlamada olması.
 */

/** Profil değişince kenar çubuğunun haberi olsun diye yayınlanan olay. */
export const PROFIL_DEGISTI = "am:profil-degisti";

const HEDEF_BOYUT = 256;
const MAKS_GIRDI_BAYT = 8 * 1024 * 1024;

/** Dosyayı kareye kırpıp 256x256 WebP data URI'ye çevirir. */
async function kucult(dosya: File): Promise<string> {
  const bitmap = await createImageBitmap(dosya);
  try {
    // Kısa kenardan kare kırp — yüz ortada kalsın
    const kenar = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - kenar) / 2;
    const sy = (bitmap.height - kenar) / 2;

    const tuval = document.createElement("canvas");
    tuval.width = HEDEF_BOYUT;
    tuval.height = HEDEF_BOYUT;
    const ctx = tuval.getContext("2d");
    if (!ctx) throw new Error("Tarayıcı görüntü işleyemedi");
    ctx.drawImage(bitmap, sx, sy, kenar, kenar, 0, 0, HEDEF_BOYUT, HEDEF_BOYUT);

    return tuval.toDataURL("image/webp", 0.85);
  } finally {
    bitmap.close();
  }
}

export function ProfilePhoto({ email }: { email: string }) {
  const [profil, setProfil] = useState<Profile | null>(null);
  const [mesaj, setMesaj] = useState<string | null>(null);
  const [hata, setHata] = useState<string | null>(null);
  const [calisiyor, setCalisiyor] = useState(false);
  const dosyaRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .profile()
      .then((r) => setProfil(r.profile))
      .catch(() => setHata("Profil okunamadı"));
  }, []);

  async function secildi(e: React.ChangeEvent<HTMLInputElement>) {
    const dosya = e.target.files?.[0];
    e.target.value = ""; // aynı dosya tekrar seçilebilsin
    if (!dosya) return;

    setHata(null);
    setMesaj(null);

    if (!dosya.type.startsWith("image/")) {
      setHata("Yalnızca görüntü dosyası seçilebilir.");
      return;
    }
    if (dosya.size > MAKS_GIRDI_BAYT) {
      setHata("Dosya çok büyük (en fazla 8 MB).");
      return;
    }

    setCalisiyor(true);
    try {
      const kucuk = await kucult(dosya);
      await api.setAvatar(kucuk);
      setProfil((p) => (p ? { ...p, avatar: kucuk } : p));
      setMesaj("Profil fotoğrafı güncellendi.");
      window.dispatchEvent(new CustomEvent(PROFIL_DEGISTI));
    } catch (err) {
      setHata(err instanceof Error ? err.message : "Yüklenemedi");
    } finally {
      setCalisiyor(false);
    }
  }

  async function kaldir() {
    setHata(null);
    setMesaj(null);
    setCalisiyor(true);
    try {
      await api.clearAvatar();
      setProfil((p) => (p ? { ...p, avatar: null } : p));
      setMesaj("Profil fotoğrafı kaldırıldı.");
      window.dispatchEvent(new CustomEvent(PROFIL_DEGISTI));
    } catch (err) {
      setHata(err instanceof Error ? err.message : "Kaldırılamadı");
    } finally {
      setCalisiyor(false);
    }
  }

  return (
    <section>
      <p className="modal-sub">
        Bu fotoğraf yalnızca Aktaş Mail arayüzünde görünür.
      </p>

      <div className="pp-satir">
        {profil?.avatar ? (
          <img className="pp-onizleme" src={profil.avatar} alt="Profil fotoğrafın" />
        ) : (
          <Avatar name={profil?.displayName ?? ""} address={email} size={72} />
        )}

        <div>
          <button
            className="btn btn-primary"
            disabled={calisiyor}
            onClick={() => dosyaRef.current?.click()}
          >
            {calisiyor ? "Yükleniyor…" : profil?.avatar ? "Değiştir" : "Fotoğraf seç"}
          </button>
          {profil?.avatar && (
            <button className="btn" disabled={calisiyor} onClick={() => void kaldir()}>
              Kaldır
            </button>
          )}
          <input
            ref={dosyaRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(e) => void secildi(e)}
          />
        </div>
      </div>

      {mesaj && <p className="ok">{mesaj}</p>}
      {hata && <p className="err">{hata}</p>}

      <p className="pp-not">
        Fotoğraf tarayıcıda 256×256 WebP'ye küçültülüp öyle gönderiliyor;
        sunucuya büyük dosya çıkmıyor.
        <br />
        <strong>Dışarıya yansımaz.</strong> Gönderdiğin maillerde karşı tarafın
        gördüğü avatar onun kendi istemcisinden gelir — Gmail için bunu
        belirleyen şey <code>akts.tr</code> domaininin BIMI kaydı, bu fotoğraf
        değil.
      </p>
    </section>
  );
}
