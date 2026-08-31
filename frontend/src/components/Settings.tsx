import { useEffect, useState } from "react";
import { api, ApiError, type Passkey } from "../lib/api.js";
import { passkeyRegister, wrapPassword, prfSupported } from "../lib/passkey.js";
import { AdminUsers } from "./AdminUsers.js";
import { ProfilePhoto } from "./ProfilePhoto.js";
import { Bildirimler } from "./Bildirimler.js";
import { Appearance } from "./Appearance.js";
import { SpamEgitim } from "./SpamEgitim.js";

type Sekme = "profil" | "gorunum" | "bildirim" | "spam" | "passkey" | "kullanicilar";
type Adim = "liste" | "parola" | "kaydediliyor";

/**
 * Ayarlar — sekmeli tek pencere, ayrı sayfa yok.
 * "Kullanıcılar" sekmesi yalnızca admin'e gösterilir.
 *
 * ÖNEMLİ: sekmenin gizlenmesi güvenlik DEĞİLDİR, sadece arayüz.
 * Yetki tamamen sunucuda: admin adresi env'den okunuyor (DB'den değil,
 * ki veritabanına yazabilen biri kendini admin yapamasın) ve yönetim
 * uçları admin olmayana 404 dönüyor — varlıklarını bile sızdırmıyor.
 */
export function Settings({
  email,
  isAdmin,
  domain,
  domains,
  onClose,
}: {
  email: string;
  isAdmin: boolean;
  domain: string;
  domains: string[];
  onClose: () => void;
}) {
  const [sekme, setSekme] = useState<Sekme>("profil");

  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [adim, setAdim] = useState<Adim>("liste");
  const [parola, setParola] = useState("");
  const [etiket, setEtiket] = useState("");
  const [hata, setHata] = useState<string | null>(null);
  const [bilgi, setBilgi] = useState<string | null>(null);

  function yuklePasskeys() {
    api
      .passkeys()
      .then((r) => setPasskeys(r.passkeys))
      .catch((e: Error) => setHata(e.message));
  }

  useEffect(yuklePasskeys, []);

  async function passkeyEkle(e: React.FormEvent) {
    e.preventDefault();
    setHata(null);
    setBilgi(null);
    setAdim("kaydediliyor");

    try {
      // Yanlış parolayı sarmalamak, hatayı bir sonraki girişe erteler
      await api.verifyPassword(parola);

      const options = await api.passkeyRegisterOptions();
      const { response, prfOutput } = await passkeyRegister(options);

      // PRF varsa parolayı sarmala — parolasız girişi açan şey bu
      const wrapped = prfOutput ? await wrapPassword(parola, prfOutput) : null;

      await api.passkeyRegisterVerify(response, wrapped, etiket.trim() || undefined);

      setParola("");
      setEtiket("");
      setAdim("liste");
      setBilgi(
        wrapped
          ? "Passkey eklendi. Bundan sonra parola sorulmayacak."
          : "Passkey eklendi, ama bu cihaz PRF desteklemiyor — girişte parola istenecek.",
      );
      yuklePasskeys();
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        setHata("Passkey ekranı kapatıldı.");
      } else {
        setHata(err instanceof ApiError ? err.message : (err as Error).message);
      }
      setAdim("parola");
    }
  }

  return (
    <div className="modal-wrap" role="dialog" aria-label="Ayarlar">
      <div className="modal">
        <div className="modal-bar">
          <span>Ayarlar</span>
          <button className="icon-btn" onClick={onClose} title="Kapat">
            ✕
          </button>
        </div>

        <div className="sekmeler" role="tablist">
          <button
            role="tab"
            aria-selected={sekme === "profil"}
            className={`sekme ${sekme === "profil" ? "is-active" : ""}`}
            onClick={() => setSekme("profil")}
          >
            Profil
          </button>
          <button
            role="tab"
            aria-selected={sekme === "gorunum"}
            className={`sekme ${sekme === "gorunum" ? "is-active" : ""}`}
            onClick={() => setSekme("gorunum")}
          >
            Görünüm
          </button>
          {isAdmin && (
          <button
            role="tab"
            aria-selected={sekme === "spam"}
            className={`sekme ${sekme === "spam" ? "is-active" : ""}`}
            onClick={() => setSekme("spam")}
          >
            Spam modeli
          </button>
          )}
          <button
            role="tab"
            aria-selected={sekme === "bildirim"}
            className={`sekme ${sekme === "bildirim" ? "is-active" : ""}`}
            onClick={() => setSekme("bildirim")}
          >
            Bildirimler
          </button>
          <button
            role="tab"
            aria-selected={sekme === "passkey"}
            className={`sekme ${sekme === "passkey" ? "is-active" : ""}`}
            onClick={() => setSekme("passkey")}
          >
            Passkey'ler
          </button>
          {isAdmin && (
            <button
              role="tab"
              aria-selected={sekme === "kullanicilar"}
              className={`sekme ${sekme === "kullanicilar" ? "is-active" : ""}`}
              onClick={() => setSekme("kullanicilar")}
            >
              Kullanıcılar
            </button>
          )}
        </div>

        <div className="modal-body">
          {sekme === "profil" && (
            <>
              <h3>Profil fotoğrafı</h3>
              <ProfilePhoto email={email} />
            </>
          )}

          {sekme === "gorunum" && (
            <>
              <h3>Arka plan teması</h3>
              <Appearance />
            </>
          )}

          {sekme === "spam" && isAdmin && (
            <>
              <h3>Spam modeli eğitimi</h3>
              <SpamEgitim />
            </>
          )}

          {sekme === "bildirim" && (
            <>
              <h3>Bildirimler</h3>
              <Bildirimler isAdmin={isAdmin} />
            </>
          )}

          {sekme === "passkey" && (
            <>
              <h3>Passkey'ler</h3>
              <p className="modal-sub">
                Passkey ile parolasız girersin. Kayıtlı passkey iCloud veya Google
                hesabınla senkronlanır; aynı passkey telefonda da bilgisayarda da
                çalışır.
              </p>

              {passkeys.length === 0 ? (
                <p className="modal-empty">Henüz passkey yok.</p>
              ) : (
                <ul className="pk-list">
                  {passkeys.map((p) => (
                    <li key={p.id}>
                      <div>
                        <b>{p.label ?? "Adsız passkey"}</b>
                        <span>
                          {p.passwordlessLogin
                            ? "Parolasız giriş açık"
                            : "Girişte parola ister"}
                          {p.lastUsedAt
                            ? ` · son kullanım ${new Date(p.lastUsedAt).toLocaleDateString("tr-TR")}`
                            : ""}
                        </span>
                      </div>
                      {p.passwordlessLogin && <span className="pk-ok">✓</span>}
                    </li>
                  ))}
                </ul>
              )}

              {adim === "liste" && (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    setBilgi(null);
                    setAdim("parola");
                  }}
                  disabled={!prfSupported()}
                >
                  Passkey ekle
                </button>
              )}

              {(adim === "parola" || adim === "kaydediliyor") && (
                <form className="pk-form" onSubmit={(e) => void passkeyEkle(e)}>
                  <p className="modal-sub">
                    Parolan bir kez gerekiyor: passkey'den türeyen anahtarla
                    sarmalanacak. Sunucu bu sarmalı çözemez.
                  </p>
                  <label className="field">
                    <span>Posta parolası ({email})</span>
                    <input
                      type="password"
                      value={parola}
                      onChange={(ev) => setParola(ev.target.value)}
                      autoComplete="current-password"
                      required
                      autoFocus
                    />
                  </label>
                  <label className="field">
                    <span>Etiket (isteğe bağlı)</span>
                    <input
                      value={etiket}
                      onChange={(ev) => setEtiket(ev.target.value)}
                      placeholder="MacBook, iPhone…"
                    />
                  </label>
                  <div className="pk-form-foot">
                    <button className="btn btn-primary" disabled={adim === "kaydediliyor"}>
                      {adim === "kaydediliyor" ? "Bekleniyor…" : "Devam"}
                    </button>
                    <button
                      type="button"
                      className="btn-link"
                      onClick={() => {
                        setParola("");
                        setAdim("liste");
                        setHata(null);
                      }}
                    >
                      Vazgeç
                    </button>
                  </div>
                </form>
              )}

              {bilgi && <p className="modal-ok">{bilgi}</p>}
              {hata && <p className="modal-error">{hata}</p>}

              {!prfSupported() && (
                <p className="modal-error">Bu tarayıcı passkey desteklemiyor.</p>
              )}
            </>
          )}

          {sekme === "kullanicilar" && isAdmin && <AdminUsers domain={domain} domains={domains} />}
        </div>
      </div>
    </div>
  );
}
