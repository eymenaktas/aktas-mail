import { useEffect, useState } from "react";
import {
  cozulmusOkumaTemasi,
  kayitliOkumaTemasi,
  okumaTemasiniKaydet,
  type OkumaTemasi,
  type Theme,
} from "../lib/theme.js";
import { api } from "../lib/api.js";

/**
 * MAİL GÖVDESİNİN açık/koyu düğmesi — uygulamanın temasından ayrı.
 *
 * Neden ayrı: gelen mailler çoğunlukla beyaz zemin varsayılarak
 * tasarlanıyor. Koyu arayüz kullanırken bile mailin kendisini açık
 * okumak isteyebilirsin; tersi de geçerli. Uygulamanın kendi teması
 * artık Ayarlar > Görünüm'de.
 *
 * Değişikliği `MessageView` bir pencere olayıyla duyuyor — iki bileşen
 * arasında ortak bir durum yöneticisi kurmaya değmeyecek kadar küçük
 * bir bağ.
 */
export const OKUMA_TEMA_OLAYI = "am:okuma-temasi";

const GUNES = (
  <>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.6v2.1M12 19.3v2.1M2.6 12h2.1M19.3 12h2.1M5.4 5.4l1.5 1.5M17.1 17.1l1.5 1.5M18.6 5.4l-1.5 1.5M6.9 17.1l-1.5 1.5" />
  </>
);
const AY = <path d="M20.5 14.4A8.6 8.6 0 0 1 9.6 3.5a8.7 8.7 0 1 0 10.9 10.9z" />;

export function ReadingThemeToggle({ className = "" }: { className?: string }) {
  const [secim, setSecim] = useState<OkumaTemasi>(() => kayitliOkumaTemasi());
  const [cozulmus, setCozulmus] = useState<Theme>(() =>
    cozulmusOkumaTemasi(kayitliOkumaTemasi()),
  );

  // "auto" seçiliyken uygulamanın teması değişirse gövde de değişmeli
  useEffect(() => {
    const gozlemci = new MutationObserver(() => {
      if (kayitliOkumaTemasi() === "auto") {
        setCozulmus(cozulmusOkumaTemasi("auto"));
        window.dispatchEvent(new CustomEvent(OKUMA_TEMA_OLAYI));
      }
    });
    gozlemci.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => gozlemci.disconnect();
  }, []);

  function degistir() {
    const yeni: OkumaTemasi = cozulmus === "dark" ? "light" : "dark";
    okumaTemasiniKaydet(yeni);
    // Hesaba da yaz ki diğer cihazda da aynı olsun
    void api.saveSettings({ okumaTemasi: yeni }).catch(() => {});
    setSecim(yeni);
    setCozulmus(yeni);
    window.dispatchEvent(new CustomEvent(OKUMA_TEMA_OLAYI));
  }

  const koyu = cozulmus === "dark";
  const ipucu = `Mail gövdesi: ${koyu ? "koyu" : "açık"}${
    secim === "auto" ? " (uygulamayı izliyor)" : ""
  } — değiştirmek için tıkla`;

  return (
    <button
      type="button"
      className={`icon-btn theme-btn ${className}`}
      onClick={degistir}
      title={ipucu}
      aria-label={ipucu}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {koyu ? GUNES : AY}
      </svg>
    </button>
  );
}
