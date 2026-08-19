/**
 * Tema yönetimi.
 *
 * Kaydedilmiş tercih varsa o, yoksa işletim sisteminin tercihi
 * (`prefers-color-scheme`). Kullanıcı düğmeye basınca tercih
 * kaydediliyor ve sistem tercihi artık dikkate alınmıyor — birini
 * seçtiyse ona saygı duyuyoruz.
 *
 * Not: temanın İLK uygulaması `index.html` içindeki küçük satır içi
 * script'te yapılıyor. Buraya bırakılsaydı sayfa önce yanlış temada
 * boyanıp sonra zıplardı (flash of wrong theme). Oradaki mantık bu
 * dosyayla aynı — biri değişirse diğeri de değişmeli.
 */

export type Theme = "light" | "dark";

const ANAHTAR = "am_theme";

/** Tarayıcı çubuğunun rengi — tema ile aynı zemin. */
const TARAYICI_RENGI: Record<Theme, string> = {
  light: "#ffffff",
  dark: "#1f1f1f",
};

export function sistemTercihi(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function kayitliTercih(): Theme | null {
  try {
    const v = localStorage.getItem(ANAHTAR);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    // Gizli sekmede localStorage kapalı olabilir
    return null;
  }
}

export function aktifTema(): Theme {
  const v = document.documentElement.dataset["theme"];
  return v === "dark" ? "dark" : "light";
}

export function temayiUygula(tema: Theme): void {
  document.documentElement.dataset["theme"] = tema;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", TARAYICI_RENGI[tema]);

  try {
    localStorage.setItem(ANAHTAR, tema);
  } catch {
    /* önemli değil — tema yine de bu oturumda geçerli */
  }
}

export function temayiDegistir(): Theme {
  const yeni: Theme = aktifTema() === "dark" ? "light" : "dark";
  temayiUygula(yeni);
  return yeni;
}

/**
 * Kullanıcı henüz bir tercih yapmadıysa sistem temasını izlemeye devam
 * et (gece moduna geçince uygulama da geçsin). Tercih yapılmışsa
 * dokunma. Geri temizleme fonksiyonu döner.
 */
export function sistemiIzle(degisince: (t: Theme) => void): () => void {
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (!mq) return () => {};

  const isle = () => {
    if (kayitliTercih() !== null) return;
    const t = sistemTercihi();
    document.documentElement.dataset["theme"] = t;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", TARAYICI_RENGI[t]);
    degisince(t);
  };

  mq.addEventListener("change", isle);
  return () => mq.removeEventListener("change", isle);
}
