import { useEffect, useState, useCallback } from "react";
import { api, type Me, type Mailbox, type MessageSummary, type MessageDetail } from "../lib/api.js";
import { MessageView } from "./MessageView.js";
import { Compose, type Draft } from "./Compose.js";
import { Logo } from "./Logo.js";
import { Settings } from "./Settings.js";

/** IMAP özel klasörlerini Türkçe adlara ve sıraya çevir. */
const KLASOR: Record<string, { ad: string; ikon: string; sira: number }> = {
  "\\Inbox": { ad: "Gelen Kutusu", ikon: "▤", sira: 0 },
  "\\Sent": { ad: "Gönderilenler", ikon: "➤", sira: 1 },
  "\\Drafts": { ad: "Taslaklar", ikon: "✎", sira: 2 },
  "\\Junk": { ad: "Spam", ikon: "⚠", sira: 3 },
  "\\Trash": { ad: "Çöp", ikon: "🗑", sira: 4 },
  "\\Archive": { ad: "Arşiv", ikon: "▣", sira: 5 },
};

/** Gelen Kutusu her zaman en üstte; sonra bilinen özel klasörler, sonra gerisi. */
function kutuSira(b: Mailbox): number {
  if (b.path.toUpperCase() === "INBOX") return -1;
  if (!b.specialUse) return 9;
  return KLASOR[b.specialUse]?.sira ?? 9;
}

function kutuAdi(b: Mailbox): string {
  if (b.path.toUpperCase() === "INBOX") return "Gelen Kutusu";
  return (b.specialUse && KLASOR[b.specialUse]?.ad) || b.name;
}

function kutuIkon(b: Mailbox): string {
  if (b.path.toUpperCase() === "INBOX") return "▤";
  return (b.specialUse && KLASOR[b.specialUse]?.ikon) || "▸";
}

function tarih(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const simdi = new Date();
  const ayniGun = d.toDateString() === simdi.toDateString();
  if (ayniGun) return d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
  if (d.getFullYear() === simdi.getFullYear())
    return d.toLocaleDateString("tr-TR", { day: "numeric", month: "short" });
  return d.toLocaleDateString("tr-TR", { year: "numeric", month: "short" });
}

export function Mail({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [boxes, setBoxes] = useState<Mailbox[]>([]);
  const [mailbox, setMailbox] = useState("INBOX");
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [query, setQuery] = useState("");
  const [ayarlar, setAyarlar] = useState(false);
  const [sonuclar, setSonuclar] = useState<MessageSummary[] | null>(null);
  const [araniyor, setAraniyor] = useState(false);

  useEffect(() => {
    api
      .mailboxes()
      .then((r) => {
        setBoxes([...r.mailboxes].sort((a, b) => kutuSira(a) - kutuSira(b)));
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const yukle = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .messages(mailbox, 50)
      .then((r) => setMessages(r.messages))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [mailbox]);

  useEffect(() => {
    setSelected(null);
    setQuery("");
    yukle();
  }, [yukle]);

  /**
   * Sunucu tarafı arama — kutunun TAMAMINI tarar.
   * Her tuşta istek atmamak için 350 ms bekliyor; kullanıcı yazmaya
   * devam ederse önceki istek iptal ediliyor (yoksa geç dönen eski
   * bir cevap yeni sonuçların üstüne yazabilir).
   */
  useEffect(() => {
    const terim = query.trim();
    if (!terim) {
      setSonuclar(null);
      setAraniyor(false);
      return;
    }

    let iptal = false;
    setAraniyor(true);
    const zaman = setTimeout(() => {
      api
        .search(terim, mailbox, 50)
        .then((r) => {
          if (!iptal) setSonuclar(r.messages);
        })
        .catch((e: Error) => {
          if (!iptal) {
            setError(e.message);
            setSonuclar([]);
          }
        })
        .finally(() => {
          if (!iptal) setAraniyor(false);
        });
    }, 350);

    return () => {
      iptal = true;
      clearTimeout(zaman);
    };
  }, [query, mailbox]);

  // Gmail kısayolları
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "c") {
        e.preventDefault();
        setDraft({ to: "", subject: "", text: "" });
      } else if (e.key === "Escape") {
        setSelected(null);
      } else if (e.key === "u") {
        setSelected(null);
      } else if (e.key === "r" && !loading) {
        e.preventDefault();
        yukle();
      } else if (e.key === "/") {
        e.preventDefault();
        document.getElementById("ara")?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [yukle, loading]);

  async function cikis() {
    await api.logout().catch(() => {});
    onLogout();
  }

  function yanitla(msg: MessageDetail) {
    setDraft({
      to: msg.from?.address ?? "",
      subject: msg.subject.startsWith("Re:") ? msg.subject : `Re: ${msg.subject}`,
      text: `\n\n--- ${msg.from?.name || msg.from?.address} yazdı ---\n`,
    });
  }

  const gosterilen = sonuclar ?? messages;
  const yukleniyor = araniyor || loading;

  return (
    <div className="app">
      {/* ── Sol: klasörler ── */}
      <aside className="sidebar">
        <div className="brand">
          <Logo size={30} />
          <span>Aktaş Mail</span>
        </div>

        <nav className="folders">
          {boxes.map((b) => (
            <button
              key={b.path}
              className={`folder ${b.path === mailbox ? "is-active" : ""}`}
              onClick={() => setMailbox(b.path)}
            >
              <span className="folder-ico">{kutuIkon(b)}</span>
              <span className="folder-name">{kutuAdi(b)}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="who">
            <div className="avatar-sm">{me.user.email.charAt(0).toUpperCase()}</div>
            <div className="who-text">
              <b>{me.user.displayName ?? me.user.email.split("@")[0]}</b>
              <span>{me.user.email}</span>
            </div>
          </div>
          <div className="foot-actions">
            <button className="btn-link" onClick={() => setAyarlar(true)}>
              Ayarlar
            </button>
            <button className="btn-link" onClick={() => void cikis()}>
              Çıkış yap
            </button>
          </div>
        </div>
      </aside>

      {/* ── Orta: mesaj listesi ── */}
      <section className="list">
        <div className="list-bar">
          <input
            id="ara"
            className="search"
            placeholder="Postada ara  ( / )"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="icon-btn" onClick={() => setQuery("")} title="Aramayı temizle">
              ✕
            </button>
          )}
          <button className="icon-btn" onClick={yukle} title="Yenile (r)" disabled={loading}>
            ↻
          </button>
        </div>

        {error && <p className="empty">{error}</p>}
        {!error && yukleniyor && (
          <p className="empty">{araniyor ? "Aranıyor…" : "Yükleniyor…"}</p>
        )}
        {!error && !yukleniyor && gosterilen.length === 0 && (
          <p className="empty">
            {query.trim() ? `"${query.trim()}" için sonuç yok.` : "Bu klasör boş."}
          </p>
        )}
        {!error && !yukleniyor && sonuclar && sonuclar.length > 0 && (
          <p className="search-note">{sonuclar.length} sonuç · tüm klasör tarandı</p>
        )}

        <div className="rows">
          {gosterilen.map((m) => (
            <button
              key={m.uid}
              className={`row ${m.seen ? "" : "is-unread"} ${selected === m.uid ? "is-selected" : ""}`}
              onClick={() => setSelected(m.uid)}
            >
              <div className="row-top">
                <span className="row-from">
                  {m.from?.name || m.from?.address || "(bilinmiyor)"}
                </span>
                {m.flagged && <span className="row-star">★</span>}
                {m.hasAttachments && <span className="row-clip">📎</span>}
                <time className="row-date">{tarih(m.date)}</time>
              </div>
              <div className="row-subject">{m.subject}</div>
              <div className="row-preview">{m.preview}</div>
            </button>
          ))}
        </div>
      </section>

      {/* ── Sağ: okuyucu ── */}
      <section className="pane">
        {selected === null ? (
          <div className="pane-empty">
            <Logo size={44} muted />
            <p>Okumak için bir mesaj seç.</p>
            <p className="hint">
              <kbd>c</kbd> yaz · <kbd>r</kbd> yenile · <kbd>/</kbd> ara · <kbd>Esc</kbd> kapat
            </p>
          </div>
        ) : (
          <MessageView
            uid={selected}
            mailbox={mailbox}
            onClose={() => setSelected(null)}
            onReply={yanitla}
          />
        )}
      </section>

      <button
        className={`compose-fab ${draft ? "is-hidden" : ""}`}
        onClick={() => setDraft({ to: "", subject: "", text: "" })}
        title="Yeni mesaj (c)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
        Yaz
      </button>

      {ayarlar && (
        <Settings
          email={me.user.email}
          isAdmin={me.isAdmin}
          domain={me.domain}
          onClose={() => setAyarlar(false)}
        />
      )}

      {draft && (
        <Compose
          draft={draft}
          from={me.user.email}
          onClose={() => setDraft(null)}
          onSent={() => {
            setDraft(null);
            yukle();
          }}
        />
      )}
    </div>
  );
}
