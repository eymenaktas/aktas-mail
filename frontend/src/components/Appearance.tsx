import { useEffect, useState } from "react";
import {
  ARKAPLANLAR,
  DESENLER,
  aktifArkaplan,
  aktifDesen,
  aktifTema,
  arkaplaniUygula,
  deseniUygula,
  temayiUygula,
  type Arkaplan,
  type Desen,
  type Theme,
} from "../lib/theme.js";
import { api } from "../lib/api.js";

/**
 * Görünüm ayarları: tema (açık/koyu) + renk + desen. Üçü de bağımsız.
 *
 * Renk ve desen ayrıldı çünkü tek listedeyken desenler kendi sabit
 * renklerine hapsoluyordu — ızgarayı beğenip rengini seçemiyordun.
 *
 * Önizlemeler CSS'teki değerlerin AYNISINI kullanıyor: renk = zemin +
 * iki ışık, desen = nötr alfa katmanı. İkisi ayrışırsa seçtiğin şeyle
 * gördüğün şey farklı olur.
 */

/** id -> [zemin, ışık1, ışık2] — app.css'teki `--bg-*` ile birebir aynı. */
const RENK: Record<string, [string, string, string]> = {
  gece: ["#0b1a33", "70,130,240", "140,90,230"],
  okyanus: ["#062b38", "40,200,215", "40,120,200"],
  orman: ["#0c2417", "70,215,130", "180,200,60"],
  gunbatimi: ["#3a1428", "255,140,60", "230,60,120"],
  mor: ["#1e0f36", "170,90,255", "90,120,255"],
  kiraz: ["#2e0a18", "255,70,120", "255,150,90"],
  lavanta: ["#191534", "150,130,255", "220,140,255"],
  bakir: ["#2a1408", "255,150,60", "200,80,40"],
  nane: ["#07231d", "60,230,180", "60,180,220"],
  kadife: ["#131318", "160,160,200", "220,180,140"],
};

const ACIK_ZEMIN: Record<string, string> = {
  gece: "#e8eef9", okyanus: "#e4f5f9", orman: "#e9f5ea", gunbatimi: "#fdeee6",
  mor: "#f0e9fb", kiraz: "#fdeaf0", lavanta: "#eeeafb", bakir: "#fbeee0",
  nane: "#e6f8f1", kadife: "#f1f1f5",
};

function renkOnizleme(id: Arkaplan, koyu: boolean): string {
  if (id === "yok") return "var(--read-bg)";
  if (id === "kuzey") {
    return koyu
      ? "radial-gradient(ellipse 26% 62% at 18% 24%, rgba(64,240,190,.50), transparent 68%)," +
          "radial-gradient(ellipse 30% 58% at 58% 20%, rgba(80,150,255,.42), transparent 68%)," +
          "radial-gradient(ellipse 22% 50% at 82% 16%, rgba(180,110,255,.38), transparent 70%)," +
          "linear-gradient(#050d18,#050d18)"
      : "radial-gradient(ellipse 26% 62% at 18% 24%, rgba(40,210,165,.42), transparent 68%)," +
          "radial-gradient(ellipse 30% 58% at 58% 20%, rgba(70,140,240,.34), transparent 68%)," +
          "linear-gradient(#eaf3fb,#eaf3fb)";
  }
  const kayit = RENK[id];
  if (!kayit) return "var(--read-bg)";
  const [zemin, i1, i2] = kayit;
  const alfa = koyu ? 0.42 : 0.32;
  const arka = koyu ? zemin : (ACIK_ZEMIN[id] ?? zemin);
  return (
    `radial-gradient(ellipse 70% 50% at 12% 8%, rgba(${i1},${alfa}), transparent 62%),` +
    `radial-gradient(ellipse 65% 55% at 88% 22%, rgba(${i2},${alfa}), transparent 64%),` +
    `linear-gradient(${arka},${arka})`
  );
}

/** Desen önizlemesi seçili rengin ÜSTÜNDE gösteriliyor. */
function desenKatmani(id: Desen, koyu: boolean): string {
  if (id === "yok") return "";
  const d = koyu ? "rgba(255,255,255,.16)" : "rgba(0,0,0,.12)";
  const harita: Record<string, string> = {
    cizgi: `repeating-linear-gradient(45deg, ${d} 0 2px, transparent 2px 14px)`,
    izgara: `linear-gradient(${d} 1px, transparent 1px) 0 0/13px 13px, linear-gradient(90deg, ${d} 1px, transparent 1px) 0 0/13px 13px`,
    nokta: `radial-gradient(${d} 1.5px, transparent 1.6px) 0 0/11px 11px`,
    altigen: `repeating-linear-gradient(60deg, ${d} 0 1px, transparent 1px 15px), repeating-linear-gradient(-60deg, ${d} 0 1px, transparent 1px 15px)`,
    ucgen: `linear-gradient(45deg, ${d} 25%, transparent 25% 75%, ${d} 75%) 0 0/17px 17px`,
    baklava: `repeating-linear-gradient(45deg, ${d} 0 1px, transparent 1px 11px), repeating-linear-gradient(-45deg, ${d} 0 1px, transparent 1px 11px)`,
    dalga: `repeating-linear-gradient(0deg, ${d} 0 1px, transparent 1px 8px)`,
    devre: `repeating-linear-gradient(90deg, ${d} 0 1px, transparent 1px 21px), repeating-linear-gradient(0deg, ${d} 0 1px, transparent 1px 21px)`,
  };
  return harita[id] ?? "";
}

export function Appearance() {
  const [renk, setRenk] = useState<Arkaplan>(() => aktifArkaplan());
  const [desen, setDesen] = useState<Desen>(() => aktifDesen());
  const [tema, setTema] = useState<Theme>(() => aktifTema());

  // Tema üst çubuktan da değişebiliyor; senkron kalalım
  useEffect(() => {
    const gozlemci = new MutationObserver(() => setTema(aktifTema()));
    gozlemci.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => gozlemci.disconnect();
  }, []);

  const koyu = tema === "dark";
  const zemin = renkOnizleme(renk, koyu);

  /**
   * Tercihi hesaba yaz. Başarısız olursa SESSİZ geçiyoruz: değişiklik
   * yerelde zaten uygulandı, kullanıcı ekranda görüyor. Ağ hatası için
   * uyarı göstermek burada gereksiz gürültü olurdu — en kötü ihtimalle
   * diğer cihaza yansımaz.
   */
  function kaydet(ayar: Parameters<typeof api.saveSettings>[0]) {
    void api.saveSettings(ayar).catch(() => {});
  }

  return (
    <section>
      <h4 className="gorunum-baslik">Tema</h4>
      <div className="tema-secim" role="radiogroup" aria-label="Tema">
        {(["light", "dark"] as const).map((t) => (
          <button
            key={t}
            role="radio"
            aria-checked={tema === t}
            className={`tema-dugme ${tema === t ? "is-secili" : ""}`}
            onClick={() => {
              temayiUygula(t);
              setTema(t);
              kaydet({ tema: t });
            }}
          >
            <span className={`tema-ornek tema-ornek-${t === "light" ? "acik" : "koyu"}`} />
            {t === "light" ? "Açık" : "Koyu"}
          </button>
        ))}
      </div>

      <h4 className="gorunum-baslik">Renk</h4>
      <div className="bg-secenekler">
        {ARKAPLANLAR.map((a) => (
          <button
            key={a.id}
            className={`bg-secenek ${renk === a.id ? "is-secili" : ""}`}
            onClick={() => {
              arkaplaniUygula(a.id);
              setRenk(a.id);
              kaydet({ arkaplan: a.id });
            }}
            aria-pressed={renk === a.id}
          >
            <span className="bg-onizleme" style={{ background: renkOnizleme(a.id, koyu) }} />
            <span className="bg-ad">
              {a.ad}
              {a.ozel && (
                <span className="bg-ozel" title="Özel kompozisyon — kendi ışıkları var">
                  {" ✦"}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>

      <h4 className="gorunum-baslik">Desen</h4>
      <p className="modal-sub">
        Desenler seçtiğin rengin üstüne biniyor — ikisi bağımsız.
      </p>
      <div className="bg-secenekler">
        {DESENLER.map((d) => {
          const katman = desenKatmani(d.id, koyu);
          return (
            <button
              key={d.id}
              className={`bg-secenek ${desen === d.id ? "is-secili" : ""}`}
              onClick={() => {
                deseniUygula(d.id);
                setDesen(d.id);
                kaydet({ desen: d.id });
              }}
              aria-pressed={desen === d.id}
            >
              <span
                className="bg-onizleme"
                style={{ background: katman ? `${katman}, ${zemin}` : zemin }}
              />
              <span className="bg-ad">{d.ad}</span>
            </button>
          );
        })}
      </div>

      <p className="pp-not">
        Arka plan kenar çubuğuna ve mail listesine uygulanır.{" "}
        <b>Mail okuma paneli düz kalır</b> — gelen mailin kendi renkleri var,
        desenli zeminde okunaksız olurdu.
      </p>
    </section>
  );
}
