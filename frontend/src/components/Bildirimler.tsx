import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

/**
 * Bildirim ayarları.
 *
 * Bildirim, mail teslim edildiği ANDA geliyor: Dovecot'un
 * `push_notification` eklentisi maili kutuya yazdığı anda sunucuya
 * haber veriyor. Yoklama yok, dolayısıyla "5 dakikada bir bakar"
 * gecikmesi de yok.
 *
 * Her cihaz ayrı abone oluyor; hesabına iki telefondan girdiysen
 * bildirim ikisine birden gider.
 */

/**
 * VAPID açık anahtarı base64url gelir, PushManager ham bayt ister.
 *
 * Dönüş tipi `ArrayBuffer`: TypeScript'in yeni lib tanımlarında
 * `Uint8Array` genel bir `ArrayBufferLike` taşıyor ve `BufferSource`
 * ile eşleşmiyor. Tamponu doğrudan vermek bu uyuşmazlığı çözüyor.
 */
function anahtariCevir(base64url: string): ArrayBuffer {
  const dolgu = "=".repeat((4 - (base64url.length % 4)) % 4);
  const b64 = (base64url + dolgu).replace(/-/g, "+").replace(/_/g, "/");
  const ham = atob(b64);
  const bayt = new Uint8Array(ham.length);
  for (let i = 0; i < ham.length; i += 1) bayt[i] = ham.charCodeAt(i);
  return bayt.buffer;
}

/** "iPhone · Safari" gibi kaba bir cihaz adı — listede ayırt etmek için. */
function cihazAdi(): string {
  const ua = navigator.userAgent;
  const cihaz = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : "Cihaz";
  const tarayici = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "tarayıcı";
  return `${cihaz} · ${tarayici}`;
}

type Durum = "yukleniyor" | "desteklenmiyor" | "kapali" | "acik" | "reddedildi";

/**
 * Brave, Google push servislerini VARSAYILAN OLARAK kapatıyor.
 * O hâlde `pushManager.subscribe()` "push service error" atıyor ve
 * hata mesajı sebebi hiç açıklamıyor. Tespit edip ne yapılacağını
 * söylemek, kullanıcıyı saatlerce aramaktan kurtarıyor.
 */
async function braveMi(): Promise<boolean> {
  const n = navigator as Navigator & { brave?: { isBrave?: () => Promise<boolean> } };
  try {
    return (await n.brave?.isBrave?.()) === true;
  } catch {
    return false;
  }
}

export function Bildirimler({ isAdmin = false }: { isAdmin?: boolean }) {
  const [durum, setDurum] = useState<Durum>("yukleniyor");
  const [cihazlar, setCihazlar] = useState<
    Array<{ endpoint: string; label: string | null; lastSentAt: string | null }>
  >([]);
  const [mesaj, setMesaj] = useState<string | null>(null);
  const [hata, setHata] = useState<string | null>(null);
  const [calisiyor, setCalisiyor] = useState(false);
  const [sunucuHazir, setSunucuHazir] = useState(true);

  const destekVar =
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  async function tazele() {
    try {
      const r = await api.pushDevices();
      setCihazlar(r.devices);
      setSunucuHazir(r.hazir);
    } catch {
      /* liste gelmezse sessiz geç */
    }
    if (!destekVar) return setDurum("desteklenmiyor");
    if (Notification.permission === "denied") return setDurum("reddedildi");

    const kayit = await navigator.serviceWorker.getRegistration();
    const abone = await kayit?.pushManager.getSubscription();
    setDurum(abone ? "acik" : "kapali");
  }

  useEffect(() => {
    void tazele();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ac() {
    setHata(null);
    setMesaj(null);
    setCalisiyor(true);
    try {
      const izin = await Notification.requestPermission();
      if (izin !== "granted") {
        setDurum(izin === "denied" ? "reddedildi" : "kapali");
        return;
      }

      const { key } = await api.pushKey();
      const kayit = await navigator.serviceWorker.ready;
      const abone = await kayit.pushManager.subscribe({
        // Sessiz push'a izin verilmiyor: her push bir bildirim göstermeli.
        userVisibleOnly: true,
        applicationServerKey: anahtariCevir(key),
      });

      await api.pushSubscribe(abone.toJSON(), cihazAdi());
      setMesaj("Bu cihaz için bildirimler açıldı.");
      await tazele();
    } catch (e) {
      const ham = e instanceof Error ? e.message : "Açılamadı";
      // "push service error" tek başına hiçbir şey anlatmıyor; sebebi
      // bilinen durumlarda onu söyle.
      if (await braveMi()) {
        setHata(
          `${ham} — Brave, Google push servisini varsayılan olarak kapatıyor. ` +
            `brave://settings/privacy adresinden "Use Google services for push messaging" ` +
            `seçeneğini açıp tarayıcıyı yeniden başlatman gerekiyor.`,
        );
      } else {
        setHata(ham);
      }
    } finally {
      setCalisiyor(false);
    }
  }

  async function kapat() {
    setHata(null);
    setMesaj(null);
    setCalisiyor(true);
    try {
      const kayit = await navigator.serviceWorker.getRegistration();
      const abone = await kayit?.pushManager.getSubscription();
      if (abone) {
        await api.pushUnsubscribe(abone.endpoint).catch(() => {});
        await abone.unsubscribe();
      }
      setMesaj("Bu cihazda bildirimler kapatıldı.");
      await tazele();
    } catch (e) {
      setHata(e instanceof Error ? e.message : "Kapatılamadı");
    } finally {
      setCalisiyor(false);
    }
  }

  /**
   * YEREL deneme — push servisini hiç kullanmadan bildirim gösterir.
   *
   * Teşhis için: sunucu "gönderildi" diyor ama ekranda bir şey
   * çıkmıyorsa sorun iki yerden birinde:
   *   - push teslimatı (tarayıcı ile Google/Apple arasında)
   *   - İŞLETİM SİSTEMİ izni (macOS'ta Chrome'a bildirim izni verilmemiş)
   *
   * Bu düğme ikinciyi eler: yerel bildirim de çıkmıyorsa sorun push'ta
   * değil, işletim sistemindedir.
   */
  async function yerelDene() {
    setHata(null);
    setMesaj(null);
    try {
      const kayit = await navigator.serviceWorker.ready;
      await kayit.showNotification("Aktaş Mail — yerel deneme", {
        body: "Bu bildirim push servisi kullanılmadan gösterildi.",
        icon: "/icon-192.png",
        tag: "aktas-mail-yerel",
      });
      setMesaj(
        "Yerel bildirim gönderildi. Ekranda GÖRÜNMEDİYSE sorun push'ta değil, " +
          "işletim sistemi izninde: macOS'ta Sistem Ayarları > Bildirimler > " +
          "tarayıcın için bildirimleri aç.",
      );
    } catch (e) {
      setHata(e instanceof Error ? e.message : "Yerel bildirim gösterilemedi");
    }
  }

  async function dene() {
    setHata(null);
    setMesaj(null);
    try {
      const r = await api.pushTest();
      setMesaj(
        r.gonderilen > 0
          ? `${r.gonderilen} cihaza gönderildi.`
          : "Kayıtlı cihaz yok — önce bu cihazda aç.",
      );
    } catch (e) {
      setHata(e instanceof Error ? e.message : "Gönderilemedi");
    }
  }

  if (durum === "yukleniyor") return <p className="modal-sub">Yükleniyor…</p>;

  return (
    <section>
      <p className="modal-sub">
        Mail <b>teslim edildiği anda</b> bildirim gelir — yoklama yok, gecikme
        yok. Bildirimde yalnızca gönderen ve konu yazar; mailin gövdesi
        gönderilmez.
      </p>

      {!sunucuHazir && (
        <p className="err">
          Sunucuda bildirim anahtarları tanımlı değil; bu özellik kapalı.
        </p>
      )}

      {durum === "desteklenmiyor" && (
        <p className="err">Bu tarayıcı web bildirimlerini desteklemiyor.</p>
      )}

      {durum === "reddedildi" && (
        <p className="err">
          Bildirim izni <b>reddedilmiş</b>. Tarayıcı ayarlarından
          mail.akts.tr için izni geri açman gerekiyor — sayfa üzerinden
          tekrar sorulamıyor.
        </p>
      )}

      {(durum === "acik" || durum === "kapali") && sunucuHazir && (
        <div className="pp-satir">
          {durum === "acik" ? (
            <>
              <button className="btn" disabled={calisiyor} onClick={() => void kapat()}>
                Bu cihazda kapat
              </button>
              {/* Deneme yalnızca yöneticide: sıradan kullanıcı için
                  gereksiz, kurulumun çalıştığını zaten ilk mailde görüyor. */}
              {isAdmin && (
                <>
                  <button className="btn btn-primary" onClick={() => void dene()}>
                    Deneme bildirimi
                  </button>
                  <button className="btn" onClick={() => void yerelDene()}>
                    Yerel deneme
                  </button>
                </>
              )}
            </>
          ) : (
            <button className="btn btn-primary" disabled={calisiyor} onClick={() => void ac()}>
              {calisiyor ? "Açılıyor…" : "Bu cihazda aç"}
            </button>
          )}
        </div>
      )}

      {mesaj && <p className="ok">{mesaj}</p>}
      {hata && <p className="err">{hata}</p>}

      {cihazlar.length > 0 && (
        <>
          <h4 className="gorunum-baslik">Kayıtlı cihazlar</h4>
          <ul className="model-liste">
            {cihazlar.map((c) => (
              <li key={c.endpoint}>
                {c.label ?? "Bilinmeyen cihaz"}
                {c.lastSentAt && (
                  <span className="model-not">
                    {" "}
                    — son bildirim {new Date(c.lastSentAt).toLocaleString("tr-TR")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="pp-not">
        <b>macOS:</b> Tarayıcıya izin vermek yetmiyor — macOS'un kendisi de
        tarayıcıya bildirim izni vermeli. Sistem Ayarları → Bildirimler →
        tarayıcını seç → "Bildirimlere İzin Ver" açık olmalı. Odaklanma
        (Focus/Rahatsız Etmeyin) açıksa da bildirimler gizlenir.
        <br />
        <b>iPhone/iPad:</b> Safari yalnızca <b>ana ekrana eklenmiş</b> siteler
        için bildirim veriyor. Paylaş → "Ana Ekrana Ekle" yapıp uygulamayı
        oradan açman gerekiyor, yoksa izin isteği bile çıkmaz.
      </p>
    </section>
  );
}
