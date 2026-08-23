import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { buildPreview, htmlToOnizleme } from "./mime.js";
import { spamSkorla, GORSEL_ESIGI, type SpamSonucu } from "./spam.js";
import { avatarGetir } from "./avatar-cache.js";
import { bakimYap, type BakimSonucu } from "./bakim.js";
import { env } from "../env.js";
import { sanitizeEmailHtml, plainTextToHtml } from "./sanitize.js";

/**
 * Uygulama kendi Dovecot'una 127.0.0.1 üzerinden bağlanır.
 * Kimlik bilgileri sunucudan hiç çıkmaz, üçüncü tarafa token verilmez —
 * Gmail/Outlook OAuth'una gerek yok. Eski plandaki en riskli parça
 * kendi posta sunucumuz olduğu için kendiliğinden ortadan kalktı.
 */

export interface MailboxCredentials {
  user: string; // eymen@akts.tr
  pass: string;
}

export interface MessageSummary {
  uid: number;
  seq: number;
  subject: string;
  from: { name: string; address: string } | null;
  date: string | null;
  preview: string;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  /** ML kampı Gün 1 modelinin tavsiyesi; yoksa sınıflandırma yapılmadı demektir */
  spam?: SpamSonucu;
}

export interface Attachment {
  filename: string;
  contentType: string;
  size: number;
}

export interface MessageDetail extends MessageSummary {
  to: Array<{ name: string; address: string }>;
  cc: Array<{ name: string; address: string }>;
  html: string;
  blockedImages: number;
  externalLinks: number;
  attachments: Attachment[];
  /** Gövdeye gömülü (cid:) görsel sayısı — uzak görselden farklı, takip riski yok */
  inlineImages: number;
  /** Uzak görseller spam şüphesi yüzünden engellendiyse true */
  gorselSpamNedeniyle: boolean;
  /**
   * Gönderen BIMI + VMC ile doğrulanmış mı (mavi tik). Doğrulanmışsa uzak
   * görseller otomatik yükleniyor — aşağıdaki nota bak.
   */
  senderVerified: boolean;
}

async function connect(creds: MailboxCredentials): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: env.IMAP_HOST,
    port: env.IMAP_PORT,
    secure: env.IMAP_SECURE,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
    // Yerel bağlantı; Dovecot STARTTLS sunuyorsa yükseltilir
    tls: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

/** Kimlik doğrulama testi: bağlanabiliyorsa parola doğru. */
export async function verifyCredentials(creds: MailboxCredentials): Promise<boolean> {
  let client: ImapFlow | null = null;
  try {
    client = await connect(creds);
    return true;
  } catch {
    return false;
  } finally {
    await client?.logout().catch(() => {});
  }
}

export async function listMailboxes(creds: MailboxCredentials) {
  const client = await connect(creds);
  try {
    const list = await client.list();

    /**
     * Okunmamış sayısı IMAP STATUS ile alınıyor — kutuyu açmaya
     * (SELECT) gerek yok, çok daha ucuz. Sayaç bir kutu için alınamazsa
     * o kutu 0 gösterir, liste yine döner.
     */
    return await Promise.all(
      list.map(async (m) => {
        let unseen = 0;
        try {
          const durum = await client.status(m.path, { unseen: true });
          unseen = durum.unseen ?? 0;
        } catch {
          // \Noselect kutuları (yalnızca klasör) sayaç vermez
        }
        return {
          path: m.path,
          name: m.name,
          specialUse: m.specialUse ?? null,
          subscribed: m.subscribed,
          unseen,
        };
      }),
    );
  } finally {
    await client.logout().catch(() => {});
  }
}

export interface ListeSonucu {
  messages: MessageSummary[];
  /** Bu istekte yapılan bakım (spam taşıma / eski spam temizliği) */
  bakim: BakimSonucu;
}

export async function listMessages(
  creds: MailboxCredentials,
  opts: { mailbox?: string; limit?: number; before?: number; userId?: number } = {},
): Promise<ListeSonucu> {
  const mailbox = opts.mailbox ?? "INBOX";
  const limit = Math.min(opts.limit ?? 30, 100);

  const client = await connect(creds);
  try {
    /**
     * Bakım listelemeden ÖNCE çalışıyor ki taşınan mailler zaten listede
     * görünmesin. Kilit almadan önce olmalı — bakım kendi kilitlerini alıyor.
     * En fazla 10 dakikada bir çalışır, her istekte değil.
     */
    const bakim =
      mailbox === "INBOX" && opts.userId !== undefined
        ? await bakimYap(client, opts.userId, creds.user)
        : { tasinan: 0, temizlenen: 0 };

    const lock = await client.getMailboxLock(mailbox);
    try {
      const status = client.mailbox;
      if (!status || status.exists === 0) return { messages: [], bakim };

      // En yeni `limit` mesaj
      const start = Math.max(1, status.exists - limit + 1);
      const range = `${start}:*`;

      const out: MessageSummary[] = [];
      for await (const msg of client.fetch(range, {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true,
        // Önizleme için ilk metin parçası: "1" düz yapıda, "1.1" iç içe
        // multipart'ta (multipart/related > multipart/alternative) doğru olan.
        bodyParts: ["1", "1.1"],
      })) {
        const env_ = msg.envelope;
        const fromEntry = env_?.from?.[0];
        const flags = msg.flags ?? new Set<string>();


        out.push({
          uid: msg.uid,
          seq: msg.seq,
          subject: env_?.subject ?? "(konu yok)",
          from: fromEntry
            ? { name: fromEntry.name ?? "", address: fromEntry.address ?? "" }
            : null,
          date: env_?.date ? new Date(env_.date).toISOString() : null,
          preview: buildPreview(msg.bodyParts, msg.bodyStructure),
          seen: flags.has("\\Seen"),
          flagged: flags.has("\\Flagged"),
          hasAttachments: hasAttachments(msg.bodyStructure),
        });
      }

      await spamIsaretle(out);
      return { messages: out.reverse(), bakim }; // en yeni üstte
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function getMessage(
  creds: MailboxCredentials,
  uid: number,
  opts: { mailbox?: string; allowRemoteImages?: boolean } = {},
): Promise<MessageDetail | null> {
  const mailbox = opts.mailbox ?? "INBOX";
  const client = await connect(creds);

  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, envelope: true, flags: true, source: true, bodyStructure: true },
        { uid: true },
      );
      if (!msg || !msg.source) return null;

      /**
       * MIME ayrıştırma mailparser'a bırakıldı (2026-08-21).
       *
       * Elle yazılmış ayrıştırıcı iki şeyi yanlış yapıyordu:
       *  1. quoted-printable'ı BAYT olarak değil KARAKTER olarak çözüyordu,
       *     "Doğrulama" -> "DoÄrulama". Türkçe her mailde bozuktu.
       *  2. `cid:` gömülü görselleri hiç çözmüyordu — tarayıcı `cid:` URL'ini
       *     yükleyemediği için mailin logosu kırık simge olarak görünüyordu.
       *
       * mailparser ikisini de çözüyor, ayrıca UTF-8 dışı charset'leri
       * (Türkçe eski mailler ISO-8859-9 kullanır) ve iç içe multipart'ı
       * doğru işliyor.
       */
      const parsed = await simpleParser(msg.source, {
        // cid: görselleri data: URI'ye çevir; sanitizer img'de data'ya izin veriyor
        skipImageLinks: false,
      });

      const inlineImages = parsed.attachments.filter((a) => a.contentDisposition === "inline").length;

      /**
       * Doğrulanmış göndereninin görselleri otomatik yükleniyor.
       *
       * Uzak görsel varsayılan olarak engelli, çünkü takip pikseli olabilir.
       * Ama BIMI + VMC'si olan bir domain, markasını bir sertifika
       * otoritesine doğrulatmış VE DMARC'ını zorlamaya almış demektir —
       * yani o adresten gelen mail gerçekten o markadan geliyor.
       *
       * > [!note] Bu takibi ortadan kaldırmaz, sadece kimliği garantiler
       * > Doğrulanmış marka da açılma takibi yapabilir. Buradaki takas
       * > bilinçli: tanınan kurumların mailleri düzgün görünsün diye
       * > takip engeli o gönderenler için gevşetiliyor. Doğrulanmamış
       * > herkeste engel aynen duruyor.
       */
      const gonderenAdres = msg.envelope?.from?.[0]?.address ?? "";
      const gonderenAvatar = gonderenAdres
        ? await avatarGetir(gonderenAdres).catch(() => null)
        : null;
      const senderVerified = gonderenAvatar?.verified ?? false;

      /**
       * Uzak görsel kararı, üç kuralın birleşimi:
       *   1. Kullanıcı açıkça "göster" dediyse -> aç
       *   2. Gönderen BIMI+VMC doğrulanmışsa -> aç
       *   3. Spam ihtimali eşiği geçiyorsa -> KAPAT (1 ve 2'yi de ezer
       *      değil; doğrulanmış gönderen zaten spam çıkmaz, ama model
       *      yanılırsa kullanıcının açık isteği öncelikli kalır)
       */
      const [govdeSkoru] = await spamSkorla([
        `${msg.envelope?.subject ?? ""} ${htmlToOnizleme(parsed.html || parsed.text || "")}`
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 4000),
      ]);
      const supheli = (govdeSkoru?.skor ?? 0) > GORSEL_ESIGI;

      const gorselleriAc =
        (opts.allowRemoteImages ?? false) || (senderVerified && !supheli);

      const cleaned = parsed.html
        ? sanitizeEmailHtml(parsed.html, { allowRemoteImages: gorselleriAc })
        : {
            html: plainTextToHtml(parsed.text ?? ""),
            blockedImages: 0,
            externalLinks: 0,
          };

      const env_ = msg.envelope;
      const fromEntry = env_?.from?.[0];
      const flags = msg.flags ?? new Set<string>();

      return {
        uid: msg.uid,
        seq: msg.seq,
        subject: env_?.subject ?? "(konu yok)",
        from: fromEntry
          ? { name: fromEntry.name ?? "", address: fromEntry.address ?? "" }
          : null,
        to: (env_?.to ?? []).map((a) => ({ name: a.name ?? "", address: a.address ?? "" })),
        cc: (env_?.cc ?? []).map((a) => ({ name: a.name ?? "", address: a.address ?? "" })),
        date: env_?.date ? new Date(env_.date).toISOString() : null,
        preview: "",
        seen: flags.has("\\Seen"),
        flagged: flags.has("\\Flagged"),
        hasAttachments: hasAttachments(msg.bodyStructure),
        html: cleaned.html,
        blockedImages: cleaned.blockedImages,
        externalLinks: cleaned.externalLinks,
        inlineImages,
        senderVerified,
        spam: govdeSkoru,
        /** Görseller spam şüphesi yüzünden mi engellendi */
        gorselSpamNedeniyle: supheli && !(opts.allowRemoteImages ?? false),
        attachments: parsed.attachments
          .filter((a) => a.contentDisposition !== "inline")
          .map((a) => ({
            filename: a.filename ?? "(isimsiz)",
            contentType: a.contentType,
            size: a.size,
          })),
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Sunucu tarafı arama — IMAP SEARCH.
 *
 * İstemci tarafı filtre yalnızca ekrana yüklenmiş mesajlara bakar;
 * bu, kutunun TAMAMINI arar. Sunucu aramayı kendi indeksiyle yaptığı
 * için binlerce mesajı istemciye indirmek gerekmiyor.
 */
export async function searchMessages(
  creds: MailboxCredentials,
  query: string,
  opts: { mailbox?: string; limit?: number } = {},
): Promise<MessageSummary[]> {
  const mailbox = opts.mailbox ?? "INBOX";
  const limit = Math.min(opts.limit ?? 50, 200);
  const terim = query.trim();
  if (!terim) return [];

  const client = await connect(creds);
  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      /**
       * `or` ile konu, gönderen, alıcı ve gövdede arıyoruz.
       * imapflow bunu IMAP SEARCH ifadesine çeviriyor — terim
       * doğrudan protokole gömülmüyor, kaçış kütüphanede.
       */
      const uids = await client.search(
        {
          or: [
            { header: { subject: terim } },
            { header: { from: terim } },
            { header: { to: terim } },
            { body: terim },
          ],
        },
        { uid: true },
      );

      if (!uids || uids.length === 0) return [];

      // En yeni sonuçlar önce; çok fazlaysa kırp
      const seçilen = uids.slice(-limit);

      const out: MessageSummary[] = [];
      for await (const msg of client.fetch(
        seçilen.join(","),
        { uid: true, envelope: true, flags: true, bodyStructure: true, bodyParts: ["1", "1.1"] },
        { uid: true },
      )) {
        const env_ = msg.envelope;
        const fromEntry = env_?.from?.[0];
        const flags = msg.flags ?? new Set<string>();

        out.push({
          uid: msg.uid,
          seq: msg.seq,
          subject: env_?.subject ?? "(konu yok)",
          from: fromEntry
            ? { name: fromEntry.name ?? "", address: fromEntry.address ?? "" }
            : null,
          date: env_?.date ? new Date(env_.date).toISOString() : null,
          preview: buildPreview(msg.bodyParts, msg.bodyStructure),
          seen: flags.has("\\Seen"),
          flagged: flags.has("\\Flagged"),
          hasAttachments: hasAttachments(msg.bodyStructure),
        });
      }

      await spamIsaretle(out);
      return out.reverse();
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function setFlag(
  creds: MailboxCredentials,
  uid: number,
  flag: "\\Seen" | "\\Flagged",
  value: boolean,
  mailbox = "INBOX",
): Promise<void> {
  const client = await connect(creds);
  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      if (value) {
        await client.messageFlagsAdd({ uid: String(uid) }, [flag], { uid: true });
      } else {
        await client.messageFlagsRemove({ uid: String(uid) }, [flag], { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

// ── yardımcılar ─────────────────────────────────────────────

/**
 * Listeye spam tavsiyesi ekler. Konu + önizleme birlikte veriliyor:
 * spam maillerinde sinyal çoğunlukla konuda ("TEBRİKLER! KAZANDINIZ").
 *
 * Sınıflandırma başarısız olursa mail listesi yine döner — bu bir
 * süsleme, akışın parçası değil.
 */
async function spamIsaretle(mesajlar: MessageSummary[]): Promise<void> {
  if (mesajlar.length === 0) return;
  try {
    const skorlar = await spamSkorla(
      mesajlar.map((m) => `${m.subject} ${m.preview}`.trim()),
    );

    /**
     * Doğrulanmış gönderende (BIMI + VMC) rozet HİÇ gösterilmiyor.
     *
     * O domain markasını bir sertifika otoritesine doğrulatmış ve
     * DMARC'ını zorlamaya almış demek — mail gerçekten o kurumdan
     * geliyor. Modelin "TikTok doğrulama kodu %53 spam" demesi
     * kullanıcıya bilgi değil gürültü veriyor.
     *
     * Avatar aramaları önbellekli ve adres başına tekilleştiriliyor,
     * yani listede 50 mail olsa da birkaç sorgu oluyor.
     */
    const adresler = [
      ...new Set(
        mesajlar
          .map((m) => m.from?.address?.toLowerCase())
          .filter((a): a is string => !!a),
      ),
    ];
    const dogrulanmis = new Set<string>();
    await Promise.all(
      adresler.map(async (adres) => {
        const avatar = await avatarGetir(adres).catch(() => null);
        if (avatar?.verified) dogrulanmis.add(adres);
      }),
    );

    mesajlar.forEach((m, i) => {
      const adres = m.from?.address?.toLowerCase();
      if (adres && dogrulanmis.has(adres)) return; // mavi tikte rozet yok
      const s = skorlar[i];
      if (s) m.spam = s;
    });
  } catch {
    // sessiz geç
  }
}

function hasAttachments(structure: unknown): boolean {
  if (!structure || typeof structure !== "object") return false;
  const node = structure as { disposition?: string; childNodes?: unknown[] };
  if (node.disposition?.toLowerCase() === "attachment") return true;
  return (node.childNodes ?? []).some((c) => hasAttachments(c));
}



/**
 * Klasördeki tüm okunmamışları okundu işaretler.
 *
 * IMAP'in kendi toplu bayrak komutunu kullanıyor: mesajları tek tek
 * dolaşmak binlerce mesajlı bir kutuda hem yavaş hem gereksiz.
 */
export async function tumunuOkunduYap(
  creds: MailboxCredentials,
  mailbox = "INBOX",
): Promise<number> {
  const client = await connect(creds);
  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      // search() kutu boşsa `false` dönebiliyor — dizi olduğunu doğrula
      const bulunan = await client.search({ seen: false }, { uid: true });
      const uidler = Array.isArray(bulunan) ? bulunan : [];
      if (uidler.length === 0) return 0;
      await client.messageFlagsAdd({ uid: uidler.join(",") }, ["\\Seen"], { uid: true });
      return uidler.length;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Klasör başına okunmamış sayıları — kenar çubuğundaki rozetler için.
 *
 * IMAP STATUS komutu kutuyu AÇMADAN sayıyı veriyor, yani her klasör
 * için tam liste çekmeye gerek yok.
 */
export async function okunmamisSayilari(
  creds: MailboxCredentials,
): Promise<Record<string, number>> {
  const client = await connect(creds);
  try {
    const sonuc: Record<string, number> = {};
    for (const kutu of await client.list()) {
      // \Noselect olan kutular (yalnızca klasör) sayılamaz
      if (kutu.flags?.has("\\Noselect")) continue;
      try {
        const durum = await client.status(kutu.path, { unseen: true });
        sonuc[kutu.path] = durum.unseen ?? 0;
      } catch {
        // Tek bir kutu okunamazsa diğerleri yine dönsün
      }
    }
    return sonuc;
  } finally {
    await client.logout().catch(() => {});
  }
}


/**
 * specialUse bayrağına göre kutu yolunu bulur; yoksa isme bakar.
 *
 * Kutu adları sunucudan sunucuya değişiyor (Junk / Spam / Çöp), o yüzden
 * önce IMAP'in standart bayrağına, sonra bilinen isimlere bakılıyor.
 */
export async function ozelKutuBul(
  creds: MailboxCredentials,
  ozel: "\\Junk" | "\\Trash" | "\\Archive",
  yedekIsimler: string[],
): Promise<string | null> {
  const client = await connect(creds);
  try {
    const liste = await client.list();
    const bayrakla = liste.find((m) => m.specialUse === ozel);
    if (bayrakla) return bayrakla.path;
    const isimle = liste.find((m) =>
      yedekIsimler.some((ad) => m.path.toLowerCase() === ad.toLowerCase()),
    );
    return isimle?.path ?? null;
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Tek bir maili başka kutuya taşır.
 *
 * Kullanıcı "spam" / "spam değil" dediğinde çağrılıyor: etiketi
 * kaydetmek tek başına yetmiyordu, mail bulunduğu klasörde kalıyordu.
 * Kullanıcının beklediği şey mailin GİTMESİ.
 */
export async function mesajiTasi(
  creds: MailboxCredentials,
  uid: number,
  kaynak: string,
  hedef: string,
): Promise<boolean> {
  if (kaynak === hedef) return false;
  const client = await connect(creds);
  try {
    const lock = await client.getMailboxLock(kaynak);
    try {
      await client.messageMove({ uid: String(uid) }, hedef, { uid: true });
      return true;
    } finally {
      lock.release();
    }
  } catch {
    return false;
  } finally {
    await client.logout().catch(() => {});
  }
}
