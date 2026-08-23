import { useEffect, useMemo, useRef, useState } from "react";
import { api, type MessageDetail } from "../lib/api.js";
import { cozulmusOkumaTemasi, kayitliOkumaTemasi } from "../lib/theme.js";
import { OKUMA_TEMA_OLAYI, ReadingThemeToggle } from "./ReadingThemeToggle.js";
import { Avatar } from "./Avatar.js";
import { QuickReplies } from "./QuickReplies.js";
import type { SenderAvatar } from "../lib/api.js";

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
  onForward,
  tamEkran = false,
  onTamEkran,
  onOkundu,
  onTasindi,
}: {
  uid: number;
  mailbox: string;
  onClose: () => void;
  onReply: (msg: MessageDetail, hazirMetin?: string) => void;
  onForward: (msg: MessageDetail) => void;
  tamEkran?: boolean;
  onTamEkran?: () => void;
  /** Mail okundu işaretlendiğinde — kenar çubuğu rozeti düşsün diye */
  onOkundu?: () => void;
  /** "Spam" / "Spam değil" sonrası mail başka kutuya taşındığında */
  onTasindi?: (hedef: string) => void;
}) {
  const [msg, setMsg] = useState<MessageDetail | null>(null);
  const [showImages, setShowImages] = useState(false);
  /**
   * iframe kendi belgesi: uygulamanın CSS değişkenlerini devralmıyor,
   * temayı elle geçiriyoruz.
   *
   * Burada UYGULAMANIN teması değil OKUMA teması kullanılıyor — ikisi
   * bağımsız. Üst çubuktaki düğme bunu değiştiriyor.
   */
  const [theme, setTheme] = useState<string>(() =>
    cozulmusOkumaTemasi(kayitliOkumaTemasi()),
  );
  const [error, setError] = useState<string | null>(null);
  /** Kullanıcının bu maile verdiği etiket (model eğitimi için toplanıyor) */
  const [etiket, setEtiket] = useState<"spam" | "ham" | null>(null);
  const [etiketHata, setEtiketHata] = useState<string | null>(null);
  /** Gönderenin BIMI logosu / Gravatar fotoğrafı ve mavi tiki */
  const [gonderenAvatar, setGonderenAvatar] = useState<SenderAvatar | undefined>();
  const [menuAcik, setMenuAcik] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // Okuma teması değişince iframe yeniden boyansın
  useEffect(() => {
    const guncelle = () => setTheme(cozulmusOkumaTemasi(kayitliOkumaTemasi()));
    window.addEventListener(OKUMA_TEMA_OLAYI, guncelle);
    return () => window.removeEventListener(OKUMA_TEMA_OLAYI, guncelle);
  }, []);

  useEffect(() => {
    let alive = true;
    setMsg(null);
    setError(null);
    setEtiket(null);
    setEtiketHata(null);
    setGonderenAvatar(undefined);
    api
      .message(uid, mailbox, showImages ? "allowed" : "blocked")
      .then((r) => {
        if (!alive) return;
        setMsg(r.message);
        if (!r.message.seen) {
          void api
            .setFlag(uid, "seen", true, mailbox)
            .then(() => onOkundu?.())
            .catch(() => {});
        }
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

    /**
     * CSP'nin `img-src`'i ile sunucunun temizlediği HTML AYNI kararı
     * vermeli. Sunucu doğrulanmış gönderende uzak görselleri geçiriyor;
     * burada CSP kapalı kalırsa görseller yine yüklenmez ve sebebi
     * anlaşılmaz olur.
     */
    const uzakGorselAcik = showImages || msg.senderVerified;

    return `<!doctype html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${uzakGorselAcik ? "https: data:" : "data:"}; style-src 'unsafe-inline'; font-src data:;">
<style>
  :root{color-scheme:${koyu ? "dark" : "light"}}
  /*
    iframe SAYDAM, zemin içerik kutusunda.

    Önce zemin body'deydi; iframe paneli doldurduğu için kısa bir mail
    bile ekranın tamamını kaplayan dolu bir kart gibi görünüyordu
    (içeriğin iki katı boşluk). Artık zemin yalnızca içeriğin kapladığı
    kadar; altında panelin kendi zemini görünüyor, kart içeriğin bittiği
    yerde bitiyor.

    iframe'in yüksekliğini ölçüp kısaltmak mümkün DEĞİL: sandbox
    allow-same-origin vermiyor (mailin HTML'i güvenilmez), o yüzden
    contentDocument'a erişilemiyor. Saydamlık bunu ölçmeden çözüyor.
  */
  html,body{background:transparent}
  body{margin:0;padding:0;
       font:14px/1.6 "Google Sans",Roboto,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
       color:${fg};word-wrap:break-word;overflow-wrap:break-word}
  /* Asıl mail kutusu — yüksekliği İÇERİĞE göre */
  .am-govde{background:${bg};color:${fg};padding:16px 24px;border-radius:16px}
  img{max-width:100%;height:auto}
  a{color:${link}}
  table{max-width:100%;border-collapse:collapse}
  pre{white-space:pre-wrap;overflow-x:auto}
  /*
    DAR EKRAN UYUMU — yatay kaydırmayı bitirir.

    Pazarlama mailleri gövdeyi 600-700px sabit genişlikli tablolara
    koyuyor. 375px ekranda bu, iframe'in yatay kaymasına yol açıyordu.
    Aşağısı o tabloları ekrana sığmaya zorluyor.

    !important ŞART: mailin kendi inline style'lari (width=600)
    normal kurallardan guclu, onlari baska turlu ezemiyoruz.
    (Bu yorum sablon dizesinin icinde - ters tirnak KULLANMA, dizeyi
     erken kapatiyor.)

    Bedeli: çok sütunlu tasarımlar alt alta düşebiliyor. Yatay kaydırmaya
    tercih edilir — mail okunur kalıyor.
  */
  @media (max-width:700px){
    *{max-width:100% !important;box-sizing:border-box}
    table,td,th{width:auto !important;max-width:100% !important}
    table{table-layout:auto !important}
    img{height:auto !important}
    .am-govde{padding:12px 14px;border-radius:12px}
    body{overflow-wrap:anywhere}
  }
  blockquote{margin:0 0 0 12px;padding-left:12px;border-left:2px solid ${cizgi};color:${soluk}}
</style></head><body><div class="am-govde">${msg.html}</div></body></html>`;
  }, [msg, showImages, theme]);

  // Avatar mesajdan AYRI çekiliyor: DNS + HTTP araması mailin
  // açılmasını bekletmemeli. Sonuç sunucuda önbellekli.
  useEffect(() => {
    const adres = msg?.from?.address;
    if (!adres) return;
    let alive = true;
    api
      .senderAvatars([adres])
      .then((r) => {
        if (alive) setGonderenAvatar(r.avatars[adres.toLowerCase()]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [msg?.from?.address]);

  // Daha önce etiketlenmiş mi? Öyleyse tekrar sorma.
  useEffect(() => {
    let alive = true;
    api
      .spamLabelGet(uid, mailbox)
      .then((r) => alive && setEtiket(r.label))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [uid, mailbox]);

  // Menü dışına tıklayınca kapansın
  useEffect(() => {
    if (!menuAcik) return;
    const kapat = () => setMenuAcik(false);
    window.addEventListener("click", kapat);
    return () => window.removeEventListener("click", kapat);
  }, [menuAcik]);

  async function etiketle(deger: "spam" | "ham") {
    setMenuAcik(false);
    setEtiketHata(null);
    // İyimser güncelleme: tıklama anında geri bildirim ver
    setEtiket(deger);
    try {
      const r = await api.spamLabel(uid, mailbox, deger);
      // Mail başka kutuya taşındıysa burada durmasının anlamı yok:
      // okuyucuyu kapat ve listeyi tazele.
      if (r.tasindi) onTasindi?.(r.tasindi);
    } catch (e) {
      setEtiket(null);
      setEtiketHata(e instanceof Error ? e.message : "Kaydedilemedi");
    }
  }

  /*
    iframe yüksekliği JS ile ÖLÇÜLMÜYOR — ölçülemez de.

    iframe `allow-same-origin` olmadan sandbox'lanmış (bilerek: mailin
    HTML'i saldırganın yazdığı içerik). Bu, üst pencerenin
    `frame.contentDocument`'a erişmesini tarayıcı düzeyinde engelliyor,
    yani "içeriğe göre boyutlandır" kodu sessizce hataya düşüyordu.

    Yerine CSS: sarmalayıcı panelin kalan yüksekliğini kaplıyor, iframe
    de onu dolduruyor. Uzun mailde iframe KENDİ İÇİNDE dikey kayıyor —
    sayfa değil. İstenen davranış da buydu.
  */

  if (error) return <div className="reader"><p className="empty">{error}</p></div>;
  if (!msg) return <div className="reader"><p className="empty">Yükleniyor…</p></div>;

  const from = msg.from;


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
        <button className="btn btn-ghost" onClick={() => onForward(msg)}>
          İlet
        </button>
        {/* Tam ekran yalnızca masaüstünde anlamlı; telefonda okuma
            paneli zaten ekranın tamamını kaplıyor (CSS'te gizli). */}
        {onTamEkran && (
          <button
            className="icon-btn tam-ekran-dugme"
            onClick={onTamEkran}
            title={tamEkran ? "Küçült (Esc)" : "Tam ekran"}
            aria-label={tamEkran ? "Küçült" : "Tam ekran"}
          >
            {tamEkran ? "⤡" : "⤢"}
          </button>
        )}

        {/*
          Üç nokta menüsü. Spam sorusu buraya taşındı: her mailin üstünde
          duran sabit bir çubuk olarak sürekli soruyordu, oysa bu ara sıra
          kullanılan bir işlem. Zaten cevaplanmışsa menüde işaretli görünüyor.
        */}
        <div className="menu-sarmal" onClick={(e) => e.stopPropagation()}>
          <button
            className="icon-btn"
            onClick={() => setMenuAcik((a) => !a)}
            title="Diğer işlemler"
            aria-haspopup="menu"
            aria-expanded={menuAcik}
          >
            ⋯
          </button>

          {menuAcik && (
            <div className="menu" role="menu">
              <div className="menu-baslik">
                Bu mail spam mı?
                {msg.spam && (
                  <span className="menu-skor">
                    model: %{Math.round(msg.spam.skor * 100)}
                  </span>
                )}
              </div>
              <button
                role="menuitem"
                className={`menu-ogesi ${etiket === "spam" ? "is-secili" : ""}`}
                onClick={() => void etiketle("spam")}
              >
                {etiket === "spam" ? "✓ " : ""}Spam olarak işaretle
              </button>
              <button
                role="menuitem"
                className={`menu-ogesi ${etiket === "ham" ? "is-secili" : ""}`}
                onClick={() => void etiketle("ham")}
              >
                {etiket === "ham" ? "✓ " : ""}Spam değil
              </button>
              {etiket && (
                <div className="menu-not">
                  Kaydedildi — model bunu öğrenecek.
                </div>
              )}
              {etiketHata && <div className="menu-not menu-hata">{etiketHata}</div>}
            </div>
          )}
        </div>
      </div>

      <div className="reader-head">
        <h2>{msg.subject}</h2>
        <div className="reader-from">
          <Avatar
            name={from?.name ?? ""}
            address={from?.address ?? ""}
            avatar={gonderenAvatar}
            size={40}
          />
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

      {/*
        Doğrulanmış gönderende AÇIKLAMA BANDI YOK.

        Önce "Bu domain logosunu BIMI ile yayınlamış…" diye uzun bir bant
        vardı ama her doğrulanmış mailde tekrar edip yer kaplıyordu.
        Aynı bilgi zaten avatarın üstündeki mavi tikte ve tikin
        tooltip'inde duruyor — iki kez söylemeye gerek yok.
      */}
      {msg.blockedImages > 0 && !showImages && (
        <div className={`banner ${msg.gorselSpamNedeniyle ? "is-supheli" : ""}`}>
          <span>
            <b>{msg.blockedImages} uzak görsel engellendi.</b>{" "}
            {msg.gorselSpamNedeniyle ? (
              <>
                Bu mail <b>%{Math.round((msg.spam?.skor ?? 0) * 100)}</b> spam
                ihtimalli. Görseli açmak gönderene adresinin çalıştığını
                doğrular — spam'de bu, daha çok spam demek.
              </>
            ) : (
              <>
                Uzak görseller gönderene mailin okunduğunu, IP'ni ve saati
                bildirir.
              </>
            )}
          </span>
          <button className="btn btn-ghost" onClick={() => setShowImages(true)}>
            Görselleri göster
          </button>
        </div>
      )}

      <div className="alt-cubuk">
        <QuickReplies msg={msg} onSec={(metin) => onReply(msg, metin)} />
        {/* Gövdenin açık/koyu'su — mailin hemen yanında dursun ki
            neyi değiştirdiği belli olsun. */}
        <ReadingThemeToggle className="alt-tema" />
      </div>

      <div className="reader-body-sarmal">
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
    </div>
  );
}
