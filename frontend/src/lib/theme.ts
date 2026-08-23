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

/**
 * Arka plan temaları (Gmail'in "temalar" özelliği gibi).
 *
 * Dış görsel YOK, hepsi CSS gradyanı. İki sebep: uygulamanın CSP'si
 * dış kaynak yüklemiyor, ve gradyan hem hafif hem de her ekran
 * boyutunda keskin duruyor.
 *
 * > [!note] Okuma paneli bundan ETKİLENMEZ — bilerek
 * > Arka plan yalnızca kabuğa (kenar çubuğu + liste) uygulanıyor.
 * > Mail gövdesi düz zemin üzerinde kalıyor, çünkü gelen mailin kendi
 * > renkleri var ve desenli bir zemin üstünde okunaksız hâle geliyor.
 * > Eymen'in istediği de buydu: "arka plan olsun ama maili açınca düz
 * > bir şey olsun, temaya göre."
 */
/**
 * Arka plan = RENK x DESEN, iki bağımsız seçim.
 *
 * Önce tek listeydi ("Okyanus", "Izgara"...) ama o zaman desenler kendi
 * sabit renklerine hapsoluyordu: ızgarayı beğenip rengini seçemiyordun.
 * Ayırınca 11 renk x 9 desen = 99 kombinasyon çıkıyor ve desenler
 * nötr alfa ile çizildiği için her rengin üstünde çalışıyor.
 */
export type Arkaplan =
  | "yok"
  | "gece"
  | "okyanus"
  | "orman"
  | "gunbatimi"
  | "mor"
  | "kiraz"
  | "lavanta"
  | "bakir"
  | "nane"
  | "kadife"
  | "kuzey";

export type Desen =
  | "yok"
  | "cizgi"
  | "izgara"
  | "nokta"
  | "altigen"
  | "ucgen"
  | "baklava"
  | "dalga"
  | "devre";

export const ARKAPLANLAR: Array<{ id: Arkaplan; ad: string; ozel?: boolean }> = [
  { id: "yok", ad: "Düz" },
  { id: "gece", ad: "Gece" },
  { id: "okyanus", ad: "Okyanus" },
  { id: "orman", ad: "Orman" },
  { id: "gunbatimi", ad: "Gün batımı" },
  { id: "mor", ad: "Mor" },
  { id: "kiraz", ad: "Kiraz" },
  { id: "lavanta", ad: "Lavanta" },
  { id: "bakir", ad: "Bakır" },
  { id: "nane", ad: "Nane" },
  { id: "kadife", ad: "Kadife" },
  // Kuzey ışıkları kendi kompozisyonu olan ÖZEL bir arka plan: düz bir
  // renk ailesi değil, üst üste binen hareketli ışık perdeleri.
  { id: "kuzey", ad: "Kuzey ışıkları", ozel: true },
];

export const DESENLER: Array<{ id: Desen; ad: string }> = [
  { id: "yok", ad: "Desensiz" },
  { id: "cizgi", ad: "Çizgi" },
  { id: "izgara", ad: "Izgara" },
  { id: "nokta", ad: "Nokta" },
  { id: "altigen", ad: "Altıgen" },
  { id: "ucgen", ad: "Üçgen" },
  { id: "baklava", ad: "Baklava" },
  { id: "dalga", ad: "Dalga" },
  { id: "devre", ad: "Devre" },
];

const ARKAPLAN_ANAHTARI = "am_bg";
const DESEN_ANAHTARI = "am_desen";

export function aktifArkaplan(): Arkaplan {
  const v = document.documentElement.dataset["bg"];
  return (ARKAPLANLAR.find((a) => a.id === v)?.id ?? "yok") as Arkaplan;
}

export function aktifDesen(): Desen {
  const v = document.documentElement.dataset["desen"];
  return (DESENLER.find((d) => d.id === v)?.id ?? "yok") as Desen;
}

export function arkaplaniUygula(bg: Arkaplan): void {
  if (bg === "yok") delete document.documentElement.dataset["bg"];
  else document.documentElement.dataset["bg"] = bg;
  try {
    localStorage.setItem(ARKAPLAN_ANAHTARI, bg);
  } catch {
    /* gizli sekmede localStorage kapalı olabilir */
  }
}

export function deseniUygula(d: Desen): void {
  if (d === "yok") delete document.documentElement.dataset["desen"];
  else document.documentElement.dataset["desen"] = d;
  try {
    localStorage.setItem(DESEN_ANAHTARI, d);
  } catch {
    /* önemli değil */
  }
}

export function kayitliArkaplan(): Arkaplan {
  try {
    const v = localStorage.getItem(ARKAPLAN_ANAHTARI);
    return (ARKAPLANLAR.find((a) => a.id === v)?.id ?? "yok") as Arkaplan;
  } catch {
    return "yok";
  }
}

export function kayitliDesen(): Desen {
  try {
    const v = localStorage.getItem(DESEN_ANAHTARI);
    return (DESENLER.find((d) => d.id === v)?.id ?? "yok") as Desen;
  } catch {
    return "yok";
  }
}

/**
 * OKUMA TEMASI — mail gövdesinin açık/koyu'su.
 *
 * Uygulamanın temasından BAĞIMSIZ. Sebebi pratik: gelen mailler
 * çoğunlukla beyaz zemin varsayılarak tasarlanıyor, koyu arayüzde
 * okurken gövdeyi açık tutmak isteyebilirsin (ya da tersi).
 *
 * "auto" = uygulamanın temasını izle (varsayılan).
 * Üst çubuktaki düğme bunu değiştiriyor; uygulamanın kendi teması
 * Ayarlar > Görünüm'de.
 */
export type OkumaTemasi = "auto" | "light" | "dark";

const OKUMA_ANAHTARI = "am_okuma_tema";

export function kayitliOkumaTemasi(): OkumaTemasi {
  try {
    const v = localStorage.getItem(OKUMA_ANAHTARI);
    return v === "light" || v === "dark" || v === "auto" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function okumaTemasiniKaydet(t: OkumaTemasi): void {
  try {
    localStorage.setItem(OKUMA_ANAHTARI, t);
  } catch {
    /* önemli değil */
  }
}

/** Okuma temasının o anki gerçek değeri ("auto" çözülmüş hâli). */
export function cozulmusOkumaTemasi(secim: OkumaTemasi): Theme {
  return secim === "auto" ? aktifTema() : secim;
}

/**
 * HESAP SENKRONU
 *
 * Tercihler artık hesapta duruyor; localStorage yalnızca ÖNBELLEK.
 * Sıralama önemli:
 *   1. açılışta localStorage'dan hemen boya (sunucuyu beklemeden,
 *      yoksa her açılışta varsayılan temanın flaşı görünür)
 *   2. profil gelince sunucudaki değerle üzerine yaz
 *   3. kullanıcı değiştirince ikisine birden kaydet
 */
import type { Ayarlar } from "./api.js";

export function ayarlariTopla(): Ayarlar {
  return {
    tema: aktifTema(),
    arkaplan: aktifArkaplan(),
    desen: aktifDesen(),
    okumaTemasi: kayitliOkumaTemasi(),
  };
}

/** Sunucudan gelen tercihleri uygular (yerelde farklıysa üzerine yazar). */
export function ayarlariUygula(a: Ayarlar | null | undefined): void {
  if (!a) return;
  if (a.tema) temayiUygula(a.tema);
  if (a.arkaplan) arkaplaniUygula(a.arkaplan as Arkaplan);
  if (a.desen) deseniUygula(a.desen as Desen);
  if (a.okumaTemasi) okumaTemasiniKaydet(a.okumaTemasi);
}
