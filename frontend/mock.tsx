/**
 * GEÇİCİ — yalnızca arayüzü göz kontrolüyle denemek için.
 * Uygulama koduna dokunmaz: sadece fetch'i sahte cevaplarla değiştirip
 * <Mail> bileşenini gerçek veriymiş gibi çalıştırır.
 * İş bitince bu dosya ve mock.html silinir.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./src/styles/theme.css";
import "./src/styles/app.css";

const KUTULAR = [
  { path: "INBOX", name: "INBOX", specialUse: null, subscribed: true },
  { path: "Sent", name: "Sent", specialUse: "\\Sent", subscribed: true },
  { path: "Drafts", name: "Drafts", specialUse: "\\Drafts", subscribed: true },
  { path: "Junk", name: "Junk", specialUse: "\\Junk", subscribed: true },
  { path: "Trash", name: "Trash", specialUse: "\\Trash", subscribed: true },
];

const MESAJLAR = [
  {
    uid: 5, seq: 5, subject: "Sunucu yedeği tamamlandı",
    from: { name: "Yedekleme", address: "backup@akts.tr" },
    date: new Date().toISOString(),
    preview: "Gecelik yedek başarıyla alındı, 2.4 GB aktarıldı.",
    seen: false, flagged: false, hasAttachments: false,
  },
  {
    uid: 4, seq: 4, subject: "n8n iş akışı hata verdi",
    from: { name: "n8n", address: "no-reply@n8n.akts.tr" },
    date: new Date(Date.now() - 3600e3).toISOString(),
    preview: "Workflow 'Günlük rapor' 3. adımda durdu.",
    seen: false, flagged: true, hasAttachments: false,
  },
  {
    uid: 3, seq: 3, subject: "Fatura — Ağustos",
    from: { name: "Hosting", address: "fatura@ornek.com" },
    date: new Date(Date.now() - 86400e3).toISOString(),
    preview: "Ağustos ayı sunucu faturanız ektedir.",
    seen: true, flagged: false, hasAttachments: true,
  },
  {
    uid: 2, seq: 2, subject: "Merhaba",
    from: { name: "Ali Veli", address: "ali@ornek.com" },
    date: new Date(Date.now() - 3 * 86400e3).toISOString(),
    preview: "Geçen konuştuğumuz konu hakkında...",
    seen: true, flagged: false, hasAttachments: false,
  },
];

const gercekFetch = window.fetch.bind(window);
window.fetch = async (girdi: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof girdi === "string" ? girdi : girdi.toString();
  const json = (v: unknown) =>
    new Response(JSON.stringify(v), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  if (url.includes("/api/mailboxes")) return json({ mailboxes: KUTULAR });
  if (url.includes("/api/messages/") && url.includes("/flags")) return json({ status: "ok" });
  if (/\/api\/messages\/\d+/.test(url)) {
    const uid = Number(url.match(/\/api\/messages\/(\d+)/)?.[1] ?? 0);
    const m = MESAJLAR.find((x) => x.uid === uid) ?? MESAJLAR[0]!;
    return json({
      message: {
        ...m, to: [{ name: "Eymen", address: "eymen@akts.tr" }], cc: [],
        html: "<p>Örnek mail gövdesi.</p><p>İkinci paragraf.</p>",
        blockedImages: 1, externalLinks: 0,
      },
    });
  }
  if (url.includes("/api/messages") || url.includes("/api/search"))
    return json({ messages: MESAJLAR });
  return gercekFetch(girdi, init);
};

const { Mail } = await import("./src/components/Mail.js");

const el = document.getElementById("root")!;
createRoot(el).render(
  <StrictMode>
    <Mail
      me={{
        user: { email: "eymen@akts.tr", displayName: "Eymen", secondFactor: "passkey" },
        domain: "akts.tr",
        isAdmin: true,
      }}
      onLogout={() => {}}
    />
  </StrictMode>,
);
