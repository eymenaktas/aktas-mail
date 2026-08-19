import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * API vite üzerinden proxy'leniyor.
 *
 * Neden: frontend 5173, backend 3001. Bunlar farklı origin olduğu için
 * `SameSite=Strict` oturum çerezi API'ye GERİ GÖNDERİLMİYORDU — giriş
 * başarılı olsa bile her istek 401 dönüyor, sonsuz döngü oluyordu.
 *
 * Proxy ile tarayıcı her şeyi tek origin (localhost:5173) olarak görür:
 * çerezler same-site olur, CORS'a gerek kalmaz, WebAuthn'un rpId'si de
 * tutarlı kalır. Üretimde zaten hepsi mail.akts.tr'de.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: false, // Host korunmalı: backend origin'i doğruluyor
      },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
