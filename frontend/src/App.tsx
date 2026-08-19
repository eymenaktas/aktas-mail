import { useEffect, useState, useCallback } from "react";
import { api, ApiError, type Me } from "./lib/api.js";
import { Login } from "./components/Login.js";
import { Mail } from "./components/Mail.js";
import { Logo } from "./components/Logo.js";

/**
 * Daha önce oturum açıldı mı ipucu.
 *
 * Oturum çerezi `httpOnly` — JS okuyamaz, dolayısıyla açılışta oturum
 * olup olmadığını ancak sunucuya sorarak öğrenebiliriz. Hiç giriş
 * yapılmamışken bile `me` + `refresh` atmak iki gereksiz 401 üretiyordu.
 *
 * Bu bayrak SADECE bir ipucu; yetki hâlâ tamamen sunucuda. Yanlış
 * olsa bile en kötü ihtimalle fazladan bir istek atılır ya da giriş
 * ekranı gösterilir.
 */
const IPUCU = "am_session_hint";

function ipucuVar(): boolean {
  try {
    return localStorage.getItem(IPUCU) === "1";
  } catch {
    return false;
  }
}

function ipucuYaz(deger: boolean): void {
  try {
    if (deger) localStorage.setItem(IPUCU, "1");
    else localStorage.removeItem(IPUCU);
  } catch {
    /* gizli sekmede localStorage kapalı olabilir — önemli değil */
  }
}

/**
 * Oturumu çözer: varsa kullanıcıyı, yoksa null döner.
 *
 * Yükleme durumunu BİLEREK yönetmiyor — `loading`'i tek bir yerden
 * (çağıranın `finally`'si) kapatmak, "bir çıkış yolunda kapatmayı
 * unutma" hatasını yapısal olarak imkânsız kılıyor. Bu fonksiyonun
 * önceki hâlinde başarı yolunda kapatılmıyordu ve giriş başarılı olsa
 * bile ekran açılış logosunda takılı kalıyordu.
 */
async function oturumuCoz(): Promise<Me | null> {
  try {
    const bilgi = await api.me();
    ipucuYaz(true);
    return bilgi;
  } catch (err) {
    // 401 dışında bir hata (ağ, sunucu) → yeniden denemeye çalışma
    if (!(err instanceof ApiError) || err.status !== 401) return null;
  }

  // 401 geldi. Daha önce hiç giriş yapılmamışsa refresh denemeye değmez.
  if (!ipucuVar()) return null;

  // Oturum vardı: erişim süresi dolmuş olabilir, yenilemeyi dene.
  // "Çıkış yapana kadar açık kal" davranışı buradan geliyor.
  try {
    await api.refresh();
    const bilgi = await api.me();
    ipucuYaz(true);
    return bilgi;
  } catch {
    ipucuYaz(false);
    return null;
  }
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const check = useCallback(async () => {
    setLoading(true);
    try {
      setMe(await oturumuCoz());
    } finally {
      // Tek çıkış noktası: hangi yoldan gelinirse gelinsin kapanır
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  if (loading) {
    return (
      <div className="boot">
        <Logo size={44} className="boot-mark" />
      </div>
    );
  }

  if (!me) return <Login onDone={() => void check()} />;

  return (
    <Mail
      me={me}
      onLogout={() => {
        ipucuYaz(false);
        setMe(null);
      }}
    />
  );
}
