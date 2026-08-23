import { arkaplaniUygula, kayitliArkaplan, deseniUygula, kayitliDesen } from "./lib/theme.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles/theme.css";
import "./styles/app.css";

const el = document.getElementById("root");
if (!el) throw new Error("#root bulunamadı");

arkaplaniUygula(kayitliArkaplan());
deseniUygula(kayitliDesen());

/**
 * Service worker kaydı.
 *
 * `public/sw.js` vardı ve sunuluyordu ama HİÇ KAYDEDİLMİYORDU
 * (2026-08-22'de bulundu). Sonucu: hem çevrimdışı kabuk hem de
 * bildirimler çalışmıyordu — `navigator.serviceWorker.ready` hiç
 * çözülmediği için `pushManager.subscribe()` takılıyor, kullanıcıya
 * "push error" olarak dönüyordu.
 *
 * Kayıt sayfa yüklendikten SONRA yapılıyor: açılış anındaki ağ ve CPU'yu
 * ilk boyamayla paylaşmasın.
 */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch((e: unknown) => {
      // Kayıt başarısızsa uygulama yine çalışır; yalnızca çevrimdışı
      // kabuk ve bildirimler devre dışı kalır.
      console.warn("service worker kaydedilemedi:", e);
    });
  });
}

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
