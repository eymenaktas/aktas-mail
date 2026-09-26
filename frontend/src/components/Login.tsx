import { useState } from "react";
import { api, ApiError } from "../lib/api.js";
import { passkeyAuthenticate, unwrapPassword, prfSupported } from "../lib/passkey.js";
import { Logo } from "./Logo.js";
import { ThemeToggle } from "./ThemeToggle.js";

type Step = "start" | "password" | "totp" | "recovery";

/**
 * `onCancel` verilirse ekran "hesap ekle" kipinde: zaten açık bir hesap
 * var, yenisi onun yanına ekleniyor ve vazgeçip geri dönülebiliyor.
 */
export function Login({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const [step, setStep] = useState<Step>("start");
  /** "Beni hatırla" — kapalıysa oturum tarayıcı kapanınca biter. */
  const [hatirla, setHatirla] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  function fail(err: unknown) {
    setError(err instanceof ApiError ? err.message : (err as Error).message);
  }

  /** Parolasız giriş: passkey + PRF ile sarmalı çöz. */
  async function withPasskey() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const options = await api.passkeyLoginOptions();
      const { response, prfOutput } = await passkeyAuthenticate(options);
      const verified = await api.passkeyLoginVerify(response);

      if (verified.status === "password_required") {
        setEmail(verified.email);
        setStep("password");
        setNote("Bu passkey için kayıtlı sarmal yok — parola bir kez gerekiyor.");
        return;
      }

      if (!prfOutput) {
        setEmail(verified.email);
        setStep("password");
        setNote(
          "Cihazın PRF uzantısını desteklemiyor; parolasız giriş bu cihazda çalışmıyor.",
        );
        return;
      }

      // Sarmal burada, tarayıcıda çözülüyor. Sunucu çözemez.
      const pass = await unwrapPassword(verified.wrappedSecret, prfOutput);
      await api.passkeyLoginComplete(pass, hatirla);
      onDone();
    } catch (err) {
      // Kullanıcı passkey ekranını kapattıysa bu bir hata değil
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        setError(null);
      } else {
        fail(err);
      }
    } finally {
      setBusy(false);
    }
  }

  async function withPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(email.trim(), password, hatirla);
      if (result.status === "ok") {
        onDone();
        return;
      }
      if (result.method === "totp") setStep("totp");
      else setError("Bu hesap için desteklenmeyen doğrulama yöntemi: " + result.method);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function withSecondFactor(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (step === "totp") await api.loginTotp(code.trim(), hatirla);
      else await api.loginRecovery(code.trim(), hatirla);
      onDone();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  const hatirlaKutusu = (
    <label className="hatirla">
      <input
        type="checkbox"
        checked={hatirla}
        onChange={(e) => setHatirla(e.target.checked)}
      />
      <span>Beni hatırla</span>
    </label>
  );

  return (
    <div className="login">
      <aside className="login-hero" aria-hidden={!!onCancel}>
        <Logo size={56} />
        <h2>akts.tr posta kutun</h2>
        <p>Kendi sunucusunda çalışan, sade bir e-posta.</p>
        <ul>
          <li><b>Passkey ile giriş</b><span>Parola yok; parmak izi ya da yüz tanıma yeter.</span></li>
          <li><b>Kendi sunucusunda</b><span>Postfix ve Dovecot, üçüncü parti yok.</span></li>
          <li><b>Türkçe spam modeli</b><span>Gelen kutusu kendi eğittiğimiz modelle süzülüyor.</span></li>
          <li><b>Güvenli okuyucu</b><span>Gelen HTML yalıtılmış çerçevede açılıyor.</span></li>
        </ul>
      </aside>
      <div className="login-side">
      <div className="login-card">
        <div className="login-top">
          <Logo size={44} />
          <ThemeToggle />
        </div>
        <h1>{onCancel ? "Hesap ekle" : "Aktaş Mail"}</h1>

        {step === "start" && (
          <>
            <p className="login-sub">Passkey ile gir — parola gerekmiyor.</p>
            <button
              className="btn btn-primary btn-lg"
              onClick={() => void withPasskey()}
              disabled={busy || !prfSupported()}
            >
              {busy ? "Bekleniyor…" : "Passkey ile giriş"}
            </button>
            <button className="btn-link" onClick={() => setStep("password")}>
              Parolayla gir
            </button>
            {hatirlaKutusu}
          </>
        )}

        {step === "password" && (
          <form onSubmit={(e) => void withPassword(e)}>
            {note && <p className="login-note">{note}</p>}
            <label className="field">
              <span>E-posta</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                placeholder="eymen@akts.tr"
                required
                autoFocus={!email}
              />
            </label>
            <label className="field">
              <span>Parola</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                autoFocus={!!email}
              />
            </label>
            {hatirlaKutusu}
            <button className="btn btn-primary btn-lg" disabled={busy}>
              {busy ? "Kontrol ediliyor…" : "Giriş"}
            </button>
            <button type="button" className="btn-link" onClick={() => setStep("start")}>
              Passkey'e dön
            </button>
          </form>
        )}

        {(step === "totp" || step === "recovery") && (
          <form onSubmit={(e) => void withSecondFactor(e)}>
            <p className="login-sub">
              {step === "totp"
                ? "Authenticator uygulamandaki 6 haneli kod."
                : "Kurtarma kodlarından biri."}
            </p>
            <label className="field">
              <span>{step === "totp" ? "Kod" : "Kurtarma kodu"}</span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode={step === "totp" ? "numeric" : "text"}
                autoComplete="one-time-code"
                placeholder={step === "totp" ? "000000" : "XXXXX-XXXXX-XXXXX-XXXXX"}
                required
                autoFocus
              />
            </label>
            <button className="btn btn-primary btn-lg" disabled={busy}>
              {busy ? "Doğrulanıyor…" : "Doğrula"}
            </button>
            <button
              type="button"
              className="btn-link"
              onClick={() => {
                setCode("");
                setStep(step === "totp" ? "recovery" : "totp");
              }}
            >
              {step === "totp" ? "Kurtarma kodu kullan" : "Authenticator koduna dön"}
            </button>
          </form>
        )}

        {error && <p className="login-error">{error}</p>}

        {onCancel && (
          <button type="button" className="btn-link" onClick={onCancel}>
            Vazgeç, hesabıma dön
          </button>
        )}
      </div>
      <a className="login-studio" href="https://akts.tr">
        <img src="https://akts.tr/brand/akts-studio.svg" alt="" width="16" height="16" />
        Akts Studio
      </a>
      </div>
    </div>
  );
}
