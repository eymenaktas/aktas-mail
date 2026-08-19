import { useState } from "react";
import { api, ApiError } from "../lib/api.js";

export interface Draft {
  to: string;
  subject: string;
  text: string;
}

export function Compose({
  draft,
  from,
  onClose,
  onSent,
}: {
  draft: Draft;
  from: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const [to, setTo] = useState(draft.to);
  const [cc, setCc] = useState("");
  const [ccOpen, setCcOpen] = useState(false);
  const [subject, setSubject] = useState(draft.subject);
  const [text, setText] = useState(draft.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** "a@b.c, d@e.f" → ["a@b.c","d@e.f"] */
  function adresler(s: string): string[] {
    return s
      .split(/[,;]/)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  async function gonder(e: React.FormEvent) {
    e.preventDefault();
    const alicilar = adresler(to);
    if (alicilar.length === 0) {
      setError("En az bir alıcı gerekiyor.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const cclar = adresler(cc);
      const res = await api.send({
        to: alicilar,
        ...(cclar.length ? { cc: cclar } : {}),
        subject,
        text,
      });
      if (!res.savedToSent) {
        // Gönderim başarılı ama Sent'e yazılamadı — sessizce geçme
        console.warn("Mail gönderildi ama Gönderilenler klasörüne yazılamadı");
      }
      onSent();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="compose-wrap" role="dialog" aria-label="Yeni mesaj">
      <form className="compose" onSubmit={(e) => void gonder(e)}>
        <div className="compose-bar">
          <span>Yeni mesaj</span>
          <button type="button" className="icon-btn" onClick={onClose} title="Kapat">
            ✕
          </button>
        </div>

        <div className="compose-from">
          <span>Kimden</span>
          <b>{from}</b>
        </div>

        <label className="compose-field">
          <span>Kime</span>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="ornek@site.com, ikinci@site.com"
            autoFocus={!to}
            required
          />
          {!ccOpen && (
            <button type="button" className="btn-link cc-toggle" onClick={() => setCcOpen(true)}>
              Cc
            </button>
          )}
        </label>

        {ccOpen && (
          <label className="compose-field">
            <span>Cc</span>
            <input value={cc} onChange={(e) => setCc(e.target.value)} />
          </label>
        )}

        <label className="compose-field">
          <span>Konu</span>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            autoFocus={!!to}
          />
        </label>

        <textarea
          className="compose-body"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Mesajını yaz…"
        />

        {error && <p className="compose-error">{error}</p>}

        <div className="compose-foot">
          <button className="btn btn-primary" disabled={busy}>
            {busy ? "Gönderiliyor…" : "Gönder"}
          </button>
          <button type="button" className="btn-link" onClick={onClose}>
            Vazgeç
          </button>
        </div>
      </form>
    </div>
  );
}
