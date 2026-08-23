import { useEffect, useState, useCallback, useRef } from "react";
import { api, type Me, type Mailbox, type MessageSummary, type MessageDetail, type SenderAvatar, type Bakim } from "../lib/api.js";
import { Avatar } from "./Avatar.js";
import { PROFIL_DEGISTI } from "./ProfilePhoto.js";
import { ayarlariUygula } from "../lib/theme.js";
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

/**
 * Sayfa başına mesaj.
 *
 * 50'de kaldı: liste zaten kendi içinde kayıyor ve daha büyük sayfa
 * ilk açılışı yavaşlatıyor (her mesaj için gövde parçası çekiliyor).
 */
const SAYFA_BOYU = 50;

export function Mail({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [boxes, setBoxes] = useState<Mailbox[]>([]);
  const [mailbox, setMailbox] = useState("INBOX");
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [sayfa, setSayfa] = useState(0);
  const [toplam, setToplam] = useState(0);
  /** Seçim kipi: boş küme = kip kapalı. */
  const [secili, setSecili] = useState<Set<number>>(new Set());
  /** "Klasördeki TÜM mailler" seçildi mi (sayfadakiler değil). */
  const [tumuSecili, setTumuSecili] = useState(false);
  const [tasiniyor, setTasiniyor] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [query, setQuery] = useState("");
  const [ayarlar, setAyarlar] = useState(false);
  const [sonuclar, setSonuclar] = useState<MessageSummary[] | null>(null);
  /** Gönderen adresine göre avatarlar; liste geldikten SONRA dolar. */
  const [avatarlar, setAvatarlar] = useState<Record<string, SenderAvatar>>({});
  /** Bu istekte spam'e taşınan / Çöp'e temizlenen sayıları; yoksa null */
  const [bakim, setBakim] = useState<Bakim | null>(null);
  /** Kullanıcının kendi profil fotoğrafı (Ayarlar > Profil'den yüklenen) */
  const [kendiAvatar, setKendiAvatar] = useState<string | null>(null);
  /** Masaüstünde okuma panelini tam ekrana açar (Gmail'deki gibi) */
  const [tamEkran, setTamEkran] = useState(false);
  /** Canlı akıştan "yeni mail" geldiğinde artıyor; listeyi tetikliyor. */
  const [canliSurum, setCanliSurum] = useState(0);
  /** Kısa bilgi mesajı (taşıma vb.) — birkaç saniye görünüp kayboluyor. */
  const [bilgi, setBilgi] = useState<string | null>(null);

  useEffect(() => {
    if (!bilgi) return;
    const z = setTimeout(() => setBilgi(null), 4000);
    return () => clearTimeout(z);
  }, [bilgi]);

  // Profil bir kez okunuyor; Ayarlar'da değiştirilince pencere olayıyla
  // haberdar oluyoruz (ortak durum yöneticisi kurmaya değmeyecek kadar küçük).
  useEffect(() => {
    const yukle = () => {
      void api
        .profile()
        .then((r) => {
          setKendiAvatar(r.profile?.avatar ?? null);
          // Hesaptaki tercihler yereli EZER — cihazlar arası tutarlılık
          // için doğru kaynak sunucu. (Yerel önbellek yalnızca ilk
          // boyamada beklememek içindi.)
          ayarlariUygula(r.profile?.settings);
        })
        .catch(() => {});
    };
    yukle();
    window.addEventListener(PROFIL_DEGISTI, yukle);
    return () => window.removeEventListener(PROFIL_DEGISTI, yukle);
  }, []);
  const [araniyor, setAraniyor] = useState(false);
  /**
   * Telefonda klasör çubuğu ekrana sığmadığı için çekmeceye dönüşüyor.
   * Geniş ekranda bu durum hiç kullanılmıyor — çubuk zaten sabit.
   */
  const [menuAcik, setMenuAcik] = useState(false);

  useEffect(() => {
    api
      .mailboxes()
      .then((r) => {
        setBoxes([...r.mailboxes].sort((a, b) => kutuSira(a) - kutuSira(b)));
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  /**
   * Klasör rozetlerini tazeler.
   *
   * Kutu listesi yalnızca açılışta çekiliyordu, bu yüzden bir maili
   * okuduğunda kenar çubuğundaki sayı olduğu gibi kalıyordu
   * (2026-08-22'de fark edildi). Ayrı ve ucuz bir uç kullanıyoruz:
   * IMAP STATUS kutuyu açmadan sayıyı veriyor, tüm mesajları çekmiyor.
   */
  const sayaclariTazele = useCallback(() => {
    void api
      .unreadCounts()
      .then((r) => {
        setBoxes((onceki) =>
          onceki.map((b) => ({ ...b, unseen: r.counts[b.path] ?? b.unseen })),
        );
      })
      .catch(() => {
        // Rozet bir süsleme; başarısız olursa eski sayı kalsın
      });
  }, []);

  /** Bu klasördeki tüm okunmamışları okundu yap. */
  const tumunuOku = useCallback(async () => {
    try {
      const r = await api.readAll(mailbox);
      if (r.okunan > 0) {
        // Listeyi ve rozetleri yeniden çekmek yerine yerelde işaretle:
        // sunucuda zaten yapıldı, ekranın beklemesine gerek yok.
        setMessages((m) => m.map((x) => ({ ...x, seen: true })));
        setSonuclar((m) => (m ? m.map((x) => ({ ...x, seen: true })) : m));
        sayaclariTazele();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "İşaretlenemedi");
    }
  }, [mailbox, sayaclariTazele]);

  /**
   * Canlı olay akışı — yeni mail geldiği anda liste tazelensin.
   *
   * Bildirim zaten anında gidiyordu ama LİSTE sayfa yenilenene kadar
   * eski kalıyordu. Aynı teslimat kancası artık açık sekmelere de haber
   * veriyor (SSE); burada onu dinleyip listeyi çekiyoruz.
   *
   * Kopan bağlantıyı EventSource kendisi geri kuruyor, o yüzden ayrı
   * bir yeniden bağlanma mantığı yok.
   */
  useEffect(() => {
    let kaynak: EventSource | null = null;
    try {
      kaynak = new EventSource("/api/events");
    } catch {
      return; // Tarayıcı desteklemiyorsa sessizce vazgeç
    }

    kaynak.onmessage = (olay) => {
      try {
        const veri = JSON.parse(olay.data) as { tip?: string };
        if (veri.tip === "yeni-mail") {
          // Doğrudan `yukle` çağırmak yerine sürüm sayacını artırıyoruz:
          // `yukle` mailbox'a bağlı ve bu efektin ona bağımlı olması
          // her klasör değişiminde akışı yeniden kurardı.
          setCanliSurum((n) => n + 1);
        }
      } catch {
        /* bozuk olay: yoksay */
      }
    };

    return () => kaynak?.close();
  }, []);

  const yukle = useCallback(() => {
    setLoading(true);
    setError(null);
    sayaclariTazele();
    api
      .messages(mailbox, SAYFA_BOYU, sayfa)
      .then((r) => {
        setMessages(r.messages);
        setToplam(r.toplam);
        // Bakım bir şey yaptıysa kısa bir bilgi göster, yoksa sessiz kal
        setBakim(r.bakim && (r.bakim.tasinan || r.bakim.temizlenen) ? r.bakim : null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [mailbox, sayfa, sayaclariTazele]);

  useEffect(() => {
    setSelected(null);
    setQuery("");
    yukle();
  }, [yukle]);

  // Klasör değişince ilk sayfaya dön — yoksa 5. sayfadayken başka
  // klasöre geçildiğinde boş liste görünüyor.
  useEffect(() => {
    setSayfa(0);
  }, [mailbox]);

  // Canlı akıştan haber gelince listeyi tazele. Seçili mail ve arama
  // korunuyor — kullanıcının yaptığı iş bölünmesin.
  useEffect(() => {
    if (canliSurum === 0) return;
    yukle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canliSurum]);

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
        // Çekmece açıksa önce onu kapat — Esc en üstteki katmanı kapatmalı
        if (menuAcik) setMenuAcik(false);
        else if (tamEkran) setTamEkran(false);
        else setSelected(null);
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
  }, [yukle, loading, menuAcik, tamEkran]);

  async function cikis() {
    await api.logout().catch(() => {});
    onLogout();
  }

  function yanitla(msg: MessageDetail, hazirMetin?: string) {
    setDraft({
      to: msg.from?.address ?? "",
      subject: msg.subject.startsWith("Re:") ? msg.subject : `Re: ${msg.subject}`,
      // Hazır cevap seçildiyse metnin başına konuyor; kullanıcı
      // göndermeden önce düzenleyebiliyor.
      text: `${hazirMetin ? `${hazirMetin}\n` : ""}\n\n--- ${
        msg.from?.name || msg.from?.address
      } yazdı ---\n`,
    });
  }

  /**
   * İlet. Yanıtla'dan iki farkı var: alıcı BOŞ başlıyor (kime
   * ileteceğini kullanıcı seçer) ve orijinal mailin başlıkları
   * gövdeye ekleniyor — ilet edilen mailde "bu kimden geldi"
   * bilgisi kaybolmamalı.
   */
  function ilet(msg: MessageDetail) {
    const govde = msg.html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    setDraft({
      to: "",
      subject: msg.subject.startsWith("Fwd:") ? msg.subject : `Fwd: ${msg.subject}`,
      text:
        `\n\n---------- İletilen mesaj ----------\n` +
        `Kimden: ${msg.from?.name || ""} <${msg.from?.address ?? ""}>\n` +
        `Tarih: ${msg.date ? new Date(msg.date).toLocaleString("tr-TR") : ""}\n` +
        `Konu: ${msg.subject}\n` +
        `Kime: ${msg.to.map((a) => a.address).join(", ")}\n\n` +
        govde.slice(0, 4000),
    });
  }

  const gosterilen = sonuclar ?? messages;
  const secimKipi = secili.size > 0 || tumuSecili;

  /** Spam klasörünün yolu — "boşalt" düğmesi yalnızca orada çıksın. */
  const spamKutusu =
    boxes.find((b) => b.specialUse === "\\Junk")?.path ??
    boxes.find((b) => ["junk", "spam"].includes(b.path.toLowerCase()))?.path ??
    null;

  const secimiBirak = useCallback(() => {
    setSecili(new Set());
    setTumuSecili(false);
  }, []);

  const secimiCevir = useCallback((uid: number) => {
    setTumuSecili(false);
    setSecili((onceki) => {
      const yeni = new Set(onceki);
      if (yeni.has(uid)) yeni.delete(uid);
      else yeni.add(uid);
      return yeni;
    });
  }, []);

  /*
    UZUN BASMA ile seçim.

    `pointerdown` ile 450 ms sayaç başlıyor; parmak/fare kalkmadan
    dolarsa seçim kipine giriliyor. Kalkarsa ya da parmak kayarsa
    iptal — yoksa listede kaydırırken yanlışlıkla seçim başlıyor.

    Masaüstünde de çalışıyor (fare basılı tutmak), ayrıca satırdaki
    onay kutusuyla tek tıkla seçilebiliyor.
  */
  const basmaSayaci = useRef<number | null>(null);
  const basmaKaydi = useRef(false);

  const basmaBasla = useCallback(
    (uid: number) => {
      basmaKaydi.current = false;
      basmaSayaci.current = window.setTimeout(() => {
        basmaKaydi.current = true;
        secimiCevir(uid);
        // Kısa bir dokunsal geri bildirim — destekleyen cihazlarda
        navigator.vibrate?.(12);
      }, 450);
    },
    [secimiCevir],
  );

  const basmaBitir = useCallback(() => {
    if (basmaSayaci.current !== null) {
      clearTimeout(basmaSayaci.current);
      basmaSayaci.current = null;
    }
  }, []);

  /** Bu sayfadaki tüm mailleri seç. */
  const sayfayiSec = useCallback(() => {
    setTumuSecili(false);
    setSecili(new Set(gosterilen.map((m) => m.uid)));
  }, [gosterilen]);

  /** Spam klasörünü boşalt — Çöp'e taşıyor, kalıcı silmiyor. */
  const spamiBosalt = useCallback(async () => {
    if (!spamKutusu || tasiniyor) return;
    if (
      !window.confirm(
        `Spam klasöründeki ${toplam.toLocaleString("tr-TR")} mail Çöp'e taşınsın mı?\n` +
          `Kalıcı silinmiyor, Çöp'ten geri alabilirsin.`,
      )
    )
      return;
    setTasiniyor(true);
    try {
      const r = await api.topluTasi(spamKutusu, "cop", [], true);
      setBilgi(`${r.tasinan} mail Çöp'e taşındı.`);
      setSelected(null);
      yukle();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTasiniyor(false);
    }
  }, [spamKutusu, toplam, tasiniyor, yukle]);

  /** Seçilenleri spam / spam değil diye işaretle (taşır + modele yazar). */
  const secilenleriIsaretle = useCallback(
    async (hedef: "spam" | "gelen") => {
      if (tasiniyor || secili.size === 0) return;
      setTasiniyor(true);
      try {
        const r = await api.topluTasi(mailbox, hedef, [...secili], false);
        setBilgi(
          hedef === "spam"
            ? `${r.tasinan} mail Spam'e taşındı ve model öğrendi.`
            : `${r.tasinan} mail gelen kutusuna döndü ve model öğrendi.`,
        );
        secimiBirak();
        setSelected(null);
        yukle();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setTasiniyor(false);
      }
    },
    [mailbox, secili, tasiniyor, secimiBirak, yukle],
  );

  /** Seçilenleri (ya da tüm klasörü) Çöp'e taşı. */
  const secilenleriSil = useCallback(async () => {
    if (tasiniyor) return;
    const adet = tumuSecili ? toplam : secili.size;
    const soru = tumuSecili
      ? `${mailbox} klasöründeki ${adet.toLocaleString("tr-TR")} mailin TAMAMI Çöp'e taşınsın mı?`
      : `${adet} mail Çöp'e taşınsın mı?`;
    if (!window.confirm(soru)) return;

    setTasiniyor(true);
    try {
      const r = await api.topluTasi(mailbox, "cop", [...secili], tumuSecili);
      setBilgi(`${r.tasinan} mail Çöp'e taşındı.`);
      secimiBirak();
      setSelected(null);
      yukle();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTasiniyor(false);
    }
  }, [mailbox, secili, tumuSecili, toplam, tasiniyor, secimiBirak, yukle]);

  /**
   * Avatarları listeden AYRI çekiyoruz.
   *
   * BIMI bir DNS sorgusu + logo indirmesi demek; bunu mail listesinin
   * içine koysaydık liste o aramaları beklerdi. Böylece mailler anında
   * geliyor, avatarlar birkaç yüz ms sonra yerine oturuyor.
   *
   * Zaten bilinen adresler tekrar sorulmuyor — kutu değiştirip geri
   * geldiğinde ağa çıkılmıyor.
   */
  useEffect(() => {
    const eksik = [
      ...new Set(
        gosterilen
          .map((m) => m.from?.address?.toLowerCase())
          .filter((a): a is string => !!a && !(a in avatarlar)),
      ),
    ];
    if (eksik.length === 0) return;

    let alive = true;
    api
      .senderAvatars(eksik.slice(0, 100))
      .then((r) => {
        if (!alive) return;
        // Bulunamayanları da yazıyoruz ki tekrar tekrar sorulmasın.
        const yeni: Record<string, SenderAvatar> = {};
        for (const adres of eksik) {
          yeni[adres] = r.avatars[adres] ?? { image: null, verified: false, source: "none" };
        }
        setAvatarlar((onceki) => ({ ...onceki, ...yeni }));
      })
      .catch(() => {
        // Avatar bir süsleme; başarısız olursa harf avatarında kalırız.
      });
    return () => {
      alive = false;
    };
  }, [gosterilen, avatarlar]);
  const yukleniyor = araniyor || loading;

  return (
    /**
     * `is-reading`: telefonda okuyucu tam ekran kaplasın diye.
     * Geniş ekranda üç panel yan yana durduğu için bu sınıfın etkisi yok.
     */
    <div className={`app ${selected !== null ? "is-reading" : ""}`}>
      {/* Çekmece açıkken arka planı karart ve dışa tıklamayı yakala */}
      {menuAcik && (
        <button
          className="drawer-backdrop"
          aria-label="Menüyü kapat"
          onClick={() => setMenuAcik(false)}
        />
      )}

      {/* ── Sol: klasörler ── */}
      <aside className={`sidebar ${menuAcik ? "is-open" : ""}`}>
        <div className="brand">
          <Logo size={30} />
          <span>Aktaş Mail</span>
        </div>

        <nav className="folders">
          {boxes.map((b) => (
            <button
              key={b.path}
              className={`folder ${b.path === mailbox ? "is-active" : ""} ${
                b.unseen > 0 ? "has-unseen" : ""
              }`}
              onClick={() => {
                setMailbox(b.path);
                setMenuAcik(false); // telefonda seçim sonrası çekmece kapansın
              }}
            >
              <span className="folder-ico">{kutuIkon(b)}</span>
              <span className="folder-name">{kutuAdi(b)}</span>
              {/* Okunmamış sayısı — Gmail'de olduğu gibi klasör adı da kalınlaşır */}
              {b.unseen > 0 && <span className="folder-unseen">{b.unseen}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="who">
            {kendiAvatar ? (
              <img className="avatar-sm avatar-sm-img" src={kendiAvatar} alt="" />
            ) : (
              <div className="avatar-sm">{me.user.email.charAt(0).toUpperCase()}</div>
            )}
            <div className="who-text">
              <b>{me.user.displayName ?? me.user.email.split("@")[0]}</b>
              <span>{me.user.email}</span>
            </div>
          </div>
          <div className="foot-actions">
            <button
              className="btn-link"
              onClick={() => {
                // Telefonda çekmece açıkken pencere onun altında kalıyordu;
                // z-index düzeltildi ama çekmeceyi kapatmak zaten doğru
                // davranış — pencere açılınca arkada duran menü kalmasın.
                setMenuAcik(false);
                setAyarlar(true);
              }}
            >
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
          {/* Yalnızca telefonda görünür (CSS); çekmeceyi açar */}
          <button
            className="icon-btn menu-btn"
            onClick={() => setMenuAcik(true)}
            aria-label="Klasörleri aç"
            aria-expanded={menuAcik}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round" aria-hidden="true">
              <path d="M3 6h18" />
              <path d="M3 12h18" />
              <path d="M3 18h18" />
            </svg>
          </button>
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

          {/* Spam'i boşalt — yalnızca Spam klasöründe ve doluyken.
              Kalıcı silmiyor, Çöp'e taşıyor. */}
          {spamKutusu && mailbox === spamKutusu && toplam > 0 && (
            <button
              className="icon-btn"
              onClick={() => void spamiBosalt()}
              disabled={tasiniyor}
              title="Spam'i boşalt (Çöp'e taşır)"
              aria-label="Spam'i boşalt"
            >
              🗑
            </button>
          )}

          {/* Okunmamış varsa göster; hepsi okunmuşsa düğme gereksiz yer kaplar */}
          {gosterilen.some((m) => !m.seen) && (
            <button
              className="icon-btn"
              onClick={() => void tumunuOku()}
              title="Tümünü okundu işaretle"
              aria-label="Tümünü okundu işaretle"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                   strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M1.5 12.5l4 4L13 9" />
                <path d="M8.5 12.5l4 4L22 7" />
              </svg>
            </button>
          )}
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

        {/* Otomatik bakım sessizce yapılmasın — ne olduğu söylensin */}
        {bakim && (
          <p className="bakim-note">
            {bakim.tasinan > 0 && (
              <>
                <b>{bakim.tasinan} mail Spam'e taşındı.</b> Model yanılmış
                olabilir — Spam klasörüne bakıp "Spam değil" diyebilirsin.{" "}
              </>
            )}

        {bilgi && <p className="search-note">{bilgi}</p>}
            {bakim.temizlenen > 0 && (
              <>{bakim.temizlenen} eski spam Çöp'e taşındı.</>
            )}
          </p>
        )}

        {/*
          SEÇİM ÇUBUĞU — yalnızca seçim kipindeyken.

          Üç seçenek: sayfadakilerin tamamı, klasörün tamamı, ve silme.
          "Klasörün tamamı" ayrı tutuluyor çünkü sunucuya farklı gidiyor
          (uid listesi değil, `tumu` bayrağı) — 20 bin maili uid uid
          göndermek anlamsız olurdu.
        */}
        {secimKipi && (
          <div className="secim-bar">
            <span className="secim-sayi">
              {tumuSecili
                ? `${toplam.toLocaleString("tr-TR")} mail (tüm klasör)`
                : `${secili.size} seçili`}
            </span>
            <div className="secim-eylem">
              {!tumuSecili && secili.size < gosterilen.length && (
                <button className="btn" onClick={sayfayiSec}>
                  Sayfayı seç
                </button>
              )}
              {!tumuSecili && toplam > gosterilen.length && (
                <button className="btn" onClick={() => setTumuSecili(true)}>
                  Tümü ({toplam.toLocaleString("tr-TR")})
                </button>
              )}
              {/* Spam işaretleme yalnızca tekil seçimde: `tumu` ile
                  binlerce satır eğitim verisine yazılmıyor. */}
              {!tumuSecili && spamKutusu && mailbox !== spamKutusu && (
                <button
                  className="btn"
                  onClick={() => void secilenleriIsaretle("spam")}
                  disabled={tasiniyor}
                >
                  Spam
                </button>
              )}
              {!tumuSecili && spamKutusu && mailbox === spamKutusu && (
                <button
                  className="btn"
                  onClick={() => void secilenleriIsaretle("gelen")}
                  disabled={tasiniyor}
                >
                  Spam değil
                </button>
              )}
              <button
                className="btn btn-tehlike"
                onClick={() => void secilenleriSil()}
                disabled={tasiniyor}
              >
                {tasiniyor ? "Taşınıyor…" : "Çöp'e taşı"}
              </button>
              <button className="btn" onClick={secimiBirak}>
                Vazgeç
              </button>
            </div>
          </div>
        )}

        <div className="rows">
          {gosterilen.map((m) => (
            <button
              key={m.uid}
              className={
                `row ${m.seen ? "" : "is-unread"} ` +
                `${selected === m.uid ? "is-selected" : ""} ` +
                `${secili.has(m.uid) || tumuSecili ? "is-secili" : ""}`
              }
              onPointerDown={() => basmaBasla(m.uid)}
              onPointerUp={basmaBitir}
              onPointerLeave={basmaBitir}
              onPointerCancel={basmaBitir}
              onContextMenu={(e) => {
                // Masaüstünde sağ tık da seçsin; tarayıcı menüsü çıkmasın
                e.preventDefault();
                secimiCevir(m.uid);
              }}
              onClick={() => {
                // Uzun basma seçim yaptıysa aynı olayda mail açılmasın
                if (basmaKaydi.current) {
                  basmaKaydi.current = false;
                  return;
                }
                if (secimKipi) secimiCevir(m.uid);
                else setSelected(m.uid);
              }}
            >
              {secimKipi && (
                <span
                  className={`row-secim ${secili.has(m.uid) || tumuSecili ? "is-isaretli" : ""}`}
                  aria-hidden="true"
                >
                  ✓
                </span>
              )}
              <Avatar
                name={m.from?.name ?? ""}
                address={m.from?.address ?? ""}
                avatar={avatarlar[(m.from?.address ?? "").toLowerCase()]}
              />
              <div className="row-body">
                <div className="row-top">
                  <span className="row-from">
                    {m.from?.name || m.from?.address || "(bilinmiyor)"}
                  </span>
                  {/*
                    Rozet KONU yanında değil GÖNDEREN yanında.
                    Konu satırı uzun olduğunda `text-overflow: ellipsis`
                    ile kırpılıyor ve rozet görünmez oluyordu; gönderen
                    satırında ise rozete sabit yer ayrılıyor.
                  */}
                  {m.spam?.spam && (
                    <span
                      className={`row-spam ${m.spam.skor >= 0.85 ? "is-yuksek" : ""}`}
                      title={
                        `Spam ihtimali: %${Math.round(m.spam.skor * 100)} ` +
                        `(${m.spam.model === "tr" ? "Türkçe" : "İngilizce"} model)\n\n` +
                        `DENEYSEL — bu model küçük bir veriyle eğitildi ve gerçek ` +
                        `gelen kutusunda yanılabiliyor. Mail taşınmadı, silinmedi.`
                      }
                    >
                      spam? %{Math.round(m.spam.skor * 100)}
                    </span>
                  )}
                  {m.flagged && <span className="row-star">★</span>}
                  {m.hasAttachments && <span className="row-clip">📎</span>}
                  <time className="row-date">{tarih(m.date)}</time>
                </div>
                <div className="row-subject">
                  {m.subject}

                </div>
                <div className="row-preview">{m.preview}</div>
              </div>
            </button>
          ))}

        {/*
          SAYFALAMA — yalnızca aramada değilken.

          Arama sunucu tarafında tüm kutuyu tarıyor ve kendi sonuç
          kümesini döndürüyor; onu sayfalara bölmek yanıltıcı olurdu.
        */}
        {sonuclar === null && toplam > SAYFA_BOYU && (
          <div className="sayfalama">
            <button
              className="btn sayfa-btn"
              disabled={sayfa === 0 || loading}
              onClick={() => setSayfa((s) => Math.max(0, s - 1))}
              aria-label="Daha yeni mesajlar"
            >
              ‹ Yeni
            </button>
            <span className="sayfa-bilgi">
              {sayfa * SAYFA_BOYU + 1}–{Math.min((sayfa + 1) * SAYFA_BOYU, toplam)}
              <span className="sayfa-toplam"> / {toplam.toLocaleString("tr-TR")}</span>
            </span>
            <button
              className="btn sayfa-btn"
              disabled={(sayfa + 1) * SAYFA_BOYU >= toplam || loading}
              onClick={() => setSayfa((s) => s + 1)}
              aria-label="Daha eski mesajlar"
            >
              Eski ›
            </button>
          </div>
        )}
        </div>

      </section>

      {/* ── Sağ: okuyucu ── */}
      <section className={`pane ${tamEkran ? "is-tam-ekran" : ""}`}>
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
            tamEkran={tamEkran}
            onTamEkran={() => setTamEkran((t) => !t)}
            onClose={() => {
              setSelected(null);
              setTamEkran(false);
            }}
            onTasindi={(hedef) => {
              // Mail bu kutudan çıktı: okuyucuyu kapat, listeden düşür,
              // rozetleri tazele. Yeniden çekmeye gerek yok.
              setSelected(null);
              setTamEkran(false);
              setMessages((m) => m.filter((x) => x.uid !== selected));
              setSonuclar((m) => (m ? m.filter((x) => x.uid !== selected) : m));
              setBilgi(
                hedef === "INBOX"
                  ? "Gelen kutusuna taşındı."
                  : "Spam klasörüne taşındı.",
              );
              sayaclariTazele();
            }}
            onOkundu={() => {
              // Mail açılınca okundu işaretleniyor; rozet de düşsün
              setMessages((m) =>
                m.map((x) => (x.uid === selected ? { ...x, seen: true } : x)),
              );
              sayaclariTazele();
            }}
            onReply={yanitla}
            onForward={ilet}
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
