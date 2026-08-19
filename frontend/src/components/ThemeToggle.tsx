import { useEffect, useState } from "react";
import { aktifTema, temayiDegistir, sistemiIzle, type Theme } from "../lib/theme.js";

const GUNES = (
  <>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.6v2.1M12 19.3v2.1M2.6 12h2.1M19.3 12h2.1M5.4 5.4l1.5 1.5M17.1 17.1l1.5 1.5M18.6 5.4l-1.5 1.5M6.9 17.1l-1.5 1.5" />
  </>
);

const AY = <path d="M20.5 14.4A8.6 8.6 0 0 1 9.6 3.5a8.7 8.7 0 1 0 10.9 10.9z" />;

/**
 * Tema düğmesi. Koyu temadayken güneş (aydınlığa geç), açık temadayken
 * ay gösterir — yani simge yapacağı işi anlatır, bulunduğun yeri değil.
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const [tema, setTema] = useState<Theme>(() => aktifTema());

  // Kullanıcı henüz seçim yapmadıysa sistem temasını izlemeye devam et
  useEffect(() => sistemiIzle(setTema), []);

  const koyu = tema === "dark";

  return (
    <button
      type="button"
      className={`icon-btn theme-btn ${className}`}
      onClick={() => setTema(temayiDegistir())}
      title={koyu ? "Açık temaya geç" : "Koyu temaya geç"}
      aria-label={koyu ? "Açık temaya geç" : "Koyu temaya geç"}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {koyu ? GUNES : AY}
      </svg>
    </button>
  );
}
