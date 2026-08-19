import { useEffect, useState } from "react";
import { api, ApiError, type AdminUser } from "../lib/api.js";

/**
 * Kullanıcı yönetimi — yalnızca admin görür.
 *
 * Sunucuda posta kutusu açmak root yetkisi gerektiriyor; uygulama root
 * değil. Araya dar kapsamlı bir yardımcı script konuldu (sudo ile
 * yalnızca o çalıştırılabiliyor) ve script girdiyi kendi başına yeniden
 * doğruluyor. Buradaki doğrulama sadece kullanıcıya erken geri bildirim.
 */
export function AdminUsers({ domain }: { domain: string }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [ekleAcik, setEkleAcik] = useState(false);
  const [kullanici, setKullanici] = useState("");
  const [parola, setParola] = useState("");
  /** Yöneticinin KENDİ parolası — her yönetim işleminde yeniden istenir. */
  const [adminParola, setAdminParola] = useState("");
  const [busy, setBusy] = useState(false);
  const [hata, setHata] = useState<string | null>(null);
  const [bilgi, setBilgi] = useState<string | null>(null);
  const [silinecek, setSilinecek] = useState<string | null>(null);

  function yukle() {
    api
      .adminUsers()
      .then((r) => setUsers(r.users))
      .catch((e: Error) => setHata(e.message));
  }

  useEffect(yukle, []);

  async function ekle(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setHata(null);
    setBilgi(null);
    try {
      const adres = `${kullanici.trim().toLowerCase()}@${domain}`;
      await api.adminAddUser(adres, parola, adminParola);
      setBilgi(`${adres} açıldı. Kişiye ilk parolasını ilet, kendisi değiştirsin.`);
      setKullanici("");
      setParola("");
      setAdminParola("");
      setEkleAcik(false);
      yukle();
    } catch (err) {
      setHata(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sil(email: string) {
    setBusy(true);
    setHata(null);
    setBilgi(null);
    try {
      const r = await api.adminRemoveUser(email, adminParola);
      setBilgi(r.message);
      setSilinecek(null);
      setAdminParola("");
      yukle();
    } catch (err) {
      setHata(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3>Kullanıcılar</h3>
      <p className="modal-sub">
        Bu alan adındaki posta kutuları. Kutu silindiğinde <b>posta verisi
        diskte kalır</b> — geri alınamaz bir silme yapılmıyor.
      </p>

      <ul className="pk-list">
        {users.map((u) => (
          <li key={u.email}>
            <div>
              <b>{u.email}</b>
              <span>
                {u.isAdmin ? "Yönetici" : u.hasLoggedIn ? "Aktif" : "Henüz giriş yapmadı"}
              </span>
            </div>
            {!u.isAdmin &&
              (silinecek === u.email ? (
                <span className="onay">
                  <input
                    type="password"
                    className="onay-parola"
                    value={adminParola}
                    onChange={(ev) => setAdminParola(ev.target.value)}
                    placeholder="Kendi parolan"
                    autoFocus
                  />
                  <button
                    className="btn-tehlike"
                    onClick={() => void sil(u.email)}
                    disabled={busy || !adminParola}
                  >
                    Sil
                  </button>
                  <button
                    className="btn-link"
                    onClick={() => {
                      setSilinecek(null);
                      setAdminParola("");
                    }}
                  >
                    Vazgeç
                  </button>
                </span>
              ) : (
                <button className="btn-link" onClick={() => setSilinecek(u.email)}>
                  Kaldır
                </button>
              ))}
          </li>
        ))}
      </ul>

      {!ekleAcik ? (
        <button className="btn btn-primary" onClick={() => setEkleAcik(true)}>
          Kullanıcı ekle
        </button>
      ) : (
        <form className="pk-form" onSubmit={(e) => void ekle(e)}>
          <label className="field">
            <span>Kullanıcı adı</span>
            <div className="adres-satir">
              <input
                value={kullanici}
                onChange={(ev) => setKullanici(ev.target.value)}
                placeholder="ornek"
                pattern="[a-z0-9][a-z0-9._-]*"
                title="Küçük harf, rakam, nokta, tire ve alt çizgi"
                required
                autoFocus
              />
              <span className="adres-domain">@{domain}</span>
            </div>
          </label>
          <label className="field">
            <span>İlk parola (en az 10 karakter)</span>
            <input
              type="password"
              value={parola}
              onChange={(ev) => setParola(ev.target.value)}
              minLength={10}
              required
            />
          </label>
          <label className="field">
            <span>Kendi parolan (işlemi doğrulamak için)</span>
            <input
              type="password"
              value={adminParola}
              onChange={(ev) => setAdminParola(ev.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <div className="pk-form-foot">
            <button className="btn btn-primary" disabled={busy}>
              {busy ? "Açılıyor…" : "Kutuyu aç"}
            </button>
            <button
              type="button"
              className="btn-link"
              onClick={() => {
                setEkleAcik(false);
                setParola("");
                setAdminParola("");
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
    </>
  );
}
