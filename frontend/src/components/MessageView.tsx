import { useEffect, useMemo, useRef, useState } from "react";
import { api, type MessageDetail } from "../lib/api.js";

/**
 * Mail gövdesi ASLA doğrudan sayfaya basılmaz.
 *
 * Sunucu HTML'i temizliyor ama tek savunma katmanına güvenilmez:
 * burada ikinci katman olarak `sandbox` iframe var. `allow-scripts`
 * BİLEREK verilmiyor — sandbox'lı iframe'de script çalışmaz, aynı
 * origin'e erişemez, üst pencereye dokunamaz.
 */
export function MessageView({
  uid,
  mailbox,
  onClose,
  onReply,
}: {
  uid: number;
  mailbox: string;
  onClose: () => void;
  onReply: (msg: MessageDetail) => void;
}) {
  const [msg, setMsg] = useState<MessageDetail | null>(null);
  const [showImages, setShowImages] = useState(false);
  // iframe kendi belgesi: uygulamanın CSS değişkenlerini ve temasını
  // devralmaz, elle geçirmek gerekiyor.
  const [theme, setTheme] = useState(
    () => document.documentElement.dataset["theme"] ?? "light",
  );
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // Tema değişince iframe de yeniden boyansın
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setTheme(document.documentElement.dataset["theme"] ?? "light"),
    );
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    setMsg(null);
    setError(null);
    api
      .message(uid, mailbox, showImages ? "allowed" : "blocked")
      .then((r) => {
        if (!alive) return;
        setMsg(r.message);
        if (!r.message.seen) void api.setFlag(uid, "seen", true, mailbox).catch(() => {});
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [uid, mailbox, showImages]);

  /**
   * srcdoc içine kendi CSP'mizi de koyuyoruz: iframe sandbox zaten
   * script'i engelliyor, bu ikinci kilit.
   */
  const srcDoc = useMemo(() => {
    if (!msg) return "";
    const koyu = theme === "dark";
    // Gmail paletinin aynı değerleri — iframe içeriden var(--...) göremez
    const fg = koyu ? "#e3e3e3" : "#1f1f1f";
    const bg = koyu ? "#1f1f1f" : "#ffffff";
    const link = koyu ? "#8ab4f8" : "#1a73e8";
    const cizgi = koyu ? "#3c4043" : "#e0e3e7";
    const soluk = koyu ? "#9aa0a6" : "#5f6368";

    return `<!doctype html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${showImages ? "https: data:" : "data:"}; style-src 'unsafe-inline'; font-src data:;">
<style>
  :root{color-scheme:${koyu ? "dark" : "light"}}
  body{margin:0;padding:16px 24px;
       font:14px/1.6 "Google Sans",Roboto,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
       color:${fg};background:${bg};word-wrap:break-word;overflow-wrap:break-word}
  img{max-width:100%;height:auto}
  a{color:${link}}
  table{max-width:100%;border-collapse:collapse}
  pre{white-space:pre-wrap;overflow-x:auto}
  blockquote{margin:0 0 0 12px;padding-left:12px;border-left:2px solid ${cizgi};color:${soluk}}
</style></head><body>${msg.html}</body></html>`;
  }, [msg, showImages, theme]);

  // İçeriğe göre yüksekliği ayarla — iç kaydırma çubuğu çirkin durur
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !srcDoc) return;
    const onLoad = () => {
      try {
        const h = frame.contentDocument?.body?.scrollHeight;
        if (h) frame.style.height = `${h + 40}px`;
      } catch {
        // sandbox erişimi engellerse varsayılan yükseklikte kalsın
      }
    };
    frame.addEventListener("load", onLoad);
    return () => frame.removeEventListener("load", onLoad);
  }, [srcDoc]);

  if (error) return <div className="reader"><p className="empty">{error}</p></div>;
  if (!msg) return <div className="reader"><p className="empty">Yükleniyor…</p></div>;

  const from = msg.from;
  const initial = (from?.name || from?.address || "?").charAt(0).toUpperCase();

  return (
    <div className="reader">
      <div className="reader-bar">
        <button className="icon-btn" onClick={onClose} title="Kapat (Esc)">
          ✕
        </button>
        <div className="spacer" />
        <button
          className="icon-btn"
          onClick={() => void api.setFlag(msg.uid, "flagged", !msg.flagged, mailbox)}
          title="Yıldızla (s)"
        >
          {msg.flagged ? "★" : "☆"}
        </button>
        <button className="btn btn-ghost" onClick={() => onReply(msg)}>
          Yanıtla
        </button>
      </div>

      <div className="reader-head">
        <h2>{msg.subject}</h2>
        <div className="reader-from">
          <div className="avatar-sm">{initial}</div>
          <div className="reader-from-text">
            <b>{from?.name || from?.address || "(bilinmiyor)"}</b>
            {from?.name && <span>{from.address}</span>}
          </div>
          <time>{msg.date ? new Date(msg.date).toLocaleString("tr-TR") : ""}</time>
        </div>
        {msg.to.length > 0 && (
          <div className="reader-to">
            Kime: {msg.to.map((a) => a.address).join(", ")}
          </div>
        )}
      </div>

      {msg.blockedImages > 0 && !showImages && (
        <div className="banner">
          <span>
            <b>{msg.blockedImages} uzak görsel engellendi.</b> Uzak görseller
            gönderene mailin okunduğunu, IP'ni ve saati bildirir.
          </span>
          <button className="btn btn-ghost" onClick={() => setShowImages(true)}>
            Görselleri göster
          </button>
        </div>
      )}

      <iframe
        ref={frameRef}
        className="reader-body"
        title="Mail içeriği"
        // allow-scripts YOK: script çalışmaz, origin'e erişemez
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
      />
    </div>
  );
}
