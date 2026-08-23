import type { ImapFlow } from "imapflow";
import { audit } from "../lib/audit.js";
import { spamSkorla } from "./spam.js";
import { avatarGetir } from "./avatar-cache.js";
import { simpleParser } from "mailparser";
import { buildPreview, htmlToOnizleme } from "./mime.js";

/**
 * Gelen kutusu bakımı: spam taşıma ve eski spam temizliği.
 *
 * ## Neden istek sırasında çalışıyor, arka planda değil?
 *
 * Uygulama IMAP parolasını saklamıyor — oturum anahtarı yalnızca
 * istemcide (httpOnly çerez) duruyor ve sunucu her istekte alıp
 * kullanıp atıyor. Yani kullanıcı istekte bulunmadan posta kutusuna
 * erişilemiyor; zamanlanmış bir arka plan işi YAPISAL OLARAK mümkün
 * değil. Bakım bu yüzden gelen kutusu listelenirken tetikleniyor.
 *
 * ## Yanlış alarm riski
 *
 * Spam modeli küçük veriyle eğitildi ve gerçek gelen kutusunda
 * yanılıyor (ölçüm: `spam.ts`). Mail TAŞIMAK, rozet göstermekten çok
 * daha ağır bir karar — geri alınabilir ama kullanıcı mailin kaybolduğunu
 * fark etmeyebilir. Bu yüzden taşıma eşiği rozet eşiğinden ÇOK daha
 * yüksek ve dört ayrı emniyet var:
 *
 *   1. Yalnızca OKUNMAMIŞ mail taşınır — okuduğun bir şey yerinden oynamaz
 *   2. YILDIZLI mail asla taşınmaz
 *   3. DOĞRULANMIŞ gönderen (BIMI+VMC) asla taşınmaz — TikTok, PayPal,
 *      banka gibi kurumların maili spam'e düşmesin
 *   4. Her taşıma `audit_log`'a yazılır (konu + skor), yani neyin nereye
 *      gittiği sonradan bulunabilir
 */

/**
 * Taşıma eşiği — Eymen 0.7 istedi (2026-08-22).
 *
 * Üç kademeli sistem:
 *   %20 üstü -> uzak görseller açılmaz (takip pikseli riski)
 *   %50 üstü -> listede "spam? %62" rozeti
 *   %70 üstü -> Spam klasörüne TAŞINIR
 *
 * > [!warning] %70 agresif bir eşik
 * > Türkçe model kendi test kümesinde %97 doğru ama kusursuz değil.
 * > Bu eşikte gerçek bir mailin Spam'e düşmesi mümkün. Dört emniyet
 * > bunu sınırlıyor (okunmamış + yıldızsız + doğrulanmamış gönderen +
 * > her taşıma audit_log'a yazılıyor) ama sıfırlamıyor. Spam klasörünü
 * > ara sıra gözden geçir; yanlış giden olursa "Spam değil" de, model
 * > onu öğrenir.
 *
 * `SPAM_TASIMA_ESIGI` ile değiştirilebilir; 0'dan büyük değilse taşıma
 * tamamen kapanır.
 */
const TASIMA_ESIGI = Number(process.env["SPAM_TASIMA_ESIGI"] ?? 0.7);

/**
 * İNGİLİZCE İÇİN DAHA YÜKSEK EŞİK — 0.9.
 *
 * Türkçe model kullanıcının kendi arşiviyle eğitildi ve gerçek gelen
 * kutusunda ölçüldü. İngilizce modelin eğitim verisi ise ağırlıklı
 * olarak 2002-2006 dönemi külliyatlarından geliyor; modern işlem maili
 * (SaaS bildirimi, abonelik, doğrulama) o dönemde yoktu.
 *
 * 2026-08-24'te ölçüldü — dışarıda tutulmuş 690 GERÇEK modern mailde
 * yanlış alarm:
 *     eşik %50 -> %1.30
 *     eşik %70 -> %0.87
 *     eşik %90 -> %0.58   <- seçilen
 *
 * Ayrıca modern SPAM yakalama ÖLÇÜLEMEDİ: Gmail spam'i 30 günde
 * sildiği için arşivde yalnızca 4 İngilizce spam vardı. Yani bu modelin
 * kaçırma oranı bilinmiyor. Yüksek eşik bu bilinmezliğe karşı da
 * korunma: kaçırmak, meşru maili kaybetmekten iyidir.
 */
const TASIMA_ESIGI_EN = Number(process.env["SPAM_TASIMA_ESIGI_EN"] ?? 0.9);

/** Mailin diline göre taşıma eşiği. */
function tasimaEsigi(dil: "tr" | "en"): number {
  return dil === "en" ? TASIMA_ESIGI_EN : TASIMA_ESIGI;
}

/** Spam kutusunda bu kadar günden eski mailler Çöp'e taşınır. */
const SPAM_OMRU_GUN = Number(process.env["SPAM_OMRU_GUN"] ?? 30);

/**
 * Aynı kullanıcı için bakımın en sık çalışma aralığı.
 *
 * 10 dakikaydı, 2026-08-24'te 2 dakikaya indirildi. Sebep: bakım
 * yalnızca kullanıcı gelen kutusunu açtığında çalışabiliyor (sunucu
 * IMAP parolasını saklamıyor, arka plan işi yapısal olarak imkânsız).
 * 10 dakikalık soğuma, "yeni gelen spam neden hâlâ duruyor?" sorusuna
 * yol açıyordu: 100 test spam'i geldiğinde bakım 4 dakika önce koşmuştu
 * ve sıradaki hakkı 6 dakika sonraydı.
 *
 * Maliyeti düşük: her koşu yalnızca son 50 OKUNMAMIŞ maile bakıyor ve
 * zaten kullanıcı listeleme yaparken tetikleniyor.
 */
const ARALIK_MS = Number(process.env["SPAM_BAKIM_ARALIK_MS"] ?? 2 * 60 * 1000);

const sonCalisma = new Map<string, number>();

export interface BakimSonucu {
  /** Spam'e taşınan mail sayısı */
  tasinan: number;
  /** Spam'den Çöp'e taşınan (süresi dolmuş) mail sayısı */
  temizlenen: number;
}

const BOS: BakimSonucu = { tasinan: 0, temizlenen: 0 };

/** specialUse bayrağına göre kutu yolunu bulur; yoksa isme bakar. */
async function kutuBul(
  client: ImapFlow,
  ozel: "\\Junk" | "\\Trash",
  yedekIsimler: string[],
): Promise<string | null> {
  const liste = await client.list();
  const ozelKutu = liste.find((m) => m.specialUse === ozel);
  if (ozelKutu) return ozelKutu.path;

  const isimle = liste.find((m) =>
    yedekIsimler.some((ad) => m.path.toLowerCase() === ad.toLowerCase()),
  );
  return isimle?.path ?? null;
}

/**
 * Gelen kutusundaki okunmamış maillerden eşiği geçenleri Spam'e taşır.
 * Taşınan UID'leri döner ki çağıran onları listeden düşürebilsin.
 */
async function spameTasi(
  client: ImapFlow,
  spamKutusu: string,
  userId: number,
): Promise<{ tasinan: number; uidler: number[] }> {
  if (!(TASIMA_ESIGI > 0)) return { tasinan: 0, uidler: [] };

  // Yalnızca okunmamışlar: okuduğun bir mail yerinden oynamamalı.
  const bulunan = await client.search({ seen: false }, { uid: true });
  const okunmamis = Array.isArray(bulunan) ? bulunan : [];
  if (okunmamis.length === 0) return { tasinan: 0, uidler: [] };

  /*
    Koşu başına bakılacak en fazla okunmamış mail.

    50'ydi ve fazla temkinliymiş: 2026-08-24'te ölçüldü, bir koşuda
    47 mail 148 ms'de işlendi. Yani sınır 200'e çıkınca gelen kutusu
    listelemesine eklenen gecikme yarım saniye civarında kalıyor ve
    yalnızca gerçekten biriktiğinde ödeniyor.

    Sınır neden var: bakım gelen kutusu listelenirken çalışıyor
    (sunucu IMAP parolası saklamadığı için arka plan işi yapısal olarak
    imkânsız), yani her koşu kullanıcının beklediği süreye ekleniyor.
  */
  const BAKILACAK_SINIR = Number(process.env["SPAM_BAKIM_SINIR"] ?? 200);
  const bakilacak = okunmamis.slice(-BAKILACAK_SINIR);

  interface Aday {
    uid: number;
    konu: string;
    metin: string;
    yildizli: boolean;
    adres: string;
  }
  const adaylar: Aday[] = [];

  for await (const msg of client.fetch(
    bakilacak.join(","),
    { uid: true, envelope: true, flags: true, bodyStructure: true, bodyParts: ["1", "1.1"] },
    { uid: true },
  )) {
    const bayraklar = msg.flags ?? new Set<string>();
    // Yıldızlı mail asla taşınmaz.
    if (bayraklar.has("\\Flagged")) continue;

    const konu = msg.envelope?.subject ?? "";
    adaylar.push({
      uid: msg.uid,
      konu,
      metin: `${konu} ${buildPreview(msg.bodyParts, msg.bodyStructure)}`.trim(),
      yildizli: false,
      adres: msg.envelope?.from?.[0]?.address ?? "",
    });
  }

  if (adaylar.length === 0) return { tasinan: 0, uidler: [] };

  const skorlar = await spamSkorla(adaylar.map((a) => a.metin));

  const tasinacak: Array<{ uid: number; konu: string; skor: number }> = [];
  for (let i = 0; i < adaylar.length; i += 1) {
    const aday = adaylar[i];
    const onSkor = skorlar[i]?.skor ?? 0;
    // Ön eleme en DÜŞÜK eşikle yapılıyor; dile özel (daha yüksek) eşik
    // gövdeyle yeniden skorlandıktan sonra uygulanıyor. Tersi olsaydı
    // İngilizce mailler daha ucuza elenirdi.
    if (!aday || onSkor < Math.min(TASIMA_ESIGI, TASIMA_ESIGI_EN)) continue;

    /**
     * TAŞIMADAN ÖNCE TAM GÖVDEYLE YENİDEN ÖLÇ.
     *
     * Ön eleme `konu + önizleme` ile yapılıyor; önizleme bazı maillerde
     * boş kalıyor (iç içe multipart, tuhaf bodyStructure) ve o zaman
     * karar neredeyse yalnızca KONUYA dayanıyor. Model konu+gövde ile
     * eğitildi, tek başına konu güvenilmez.
     *
     * 2026-08-22'de gerçekten oldu: Gmail'in yönlendirme onay maili
     * ön elemede %90 aldı ve Spam'e taşındı; tam gövdeyle skoru %0'dı.
     * Kullanıcı onu bulamayabilirdi.
     *
     * Taşıma en ağır karar, o yüzden en pahalı ölçümü hak ediyor.
     * Yalnızca eşiği geçen AZ sayıda mail için tam gövde çekiliyor.
     */
    const { skor, dil } = await tamGovdeSkoru(client, aday.uid, aday.konu, onSkor);


    /**
     * İngilizce model 2026-08-24'te gerçek e-posta verisiyle yeniden
     * eğitildi; taşıma kısıtı o gün KALKTI.
     *
     * Önceki hâli SMS spam'iyle eğitilmişti ve gerçek maile her şeye
     * spam diyordu — 2026-08-22'de Gmail'in yönlendirme onay maili bu
     * yüzden Spam'e düşmüştü. Yeni model 28.460 gerçek e-posta ile
     * eğitildi (TREC 2005/2006, SpamAssassin, kimlik avı külliyatları +
     * kullanıcının kendi arşivinden 3.460 modern mail).
     *
     * Kısıt yerine artık DAHA YÜKSEK EŞİK var (bkz. TASIMA_ESIGI_EN):
     * ölçülen yanlış alarm %0.58. Eşiği aşmayan İngilizce mail
     * taşınmıyor, rozeti yine görünüyor.
     */
    if (skor < tasimaEsigi(dil)) continue;

    // Doğrulanmış gönderen (BIMI+VMC) asla taşınmaz: markasını sertifika
    // otoritesine doğrulatmış ve DMARC'ı zorlamada olan bir kurumdan
    // geliyorsa, model ne derse desin gelen kutusunda kalır.
    const avatar = aday.adres ? await avatarGetir(aday.adres).catch(() => null) : null;
    if (avatar?.verified) continue;

    tasinacak.push({ uid: aday.uid, konu: aday.konu, skor });
  }

  if (tasinacak.length === 0) return { tasinan: 0, uidler: [] };

  await client.messageMove(
    { uid: tasinacak.map((t) => t.uid).join(",") },
    spamKutusu,
    { uid: true },
  );

  // Neyin nereye gittiği bulunabilsin: konu ve skor kayda giriyor.
  await audit({
    userId,
    action: "spam.moved",
    detail: tasinacak
      .map((t) => `%${Math.round(t.skor * 100)} ${t.konu.slice(0, 60)}`)
      .join(" | "),
  });

  return { tasinan: tasinacak.length, uidler: tasinacak.map((t) => t.uid) };
}

/**
 * Bir mailin tam gövdesiyle spam skorunu yeniden hesaplar.
 *
 * Gövde okunamazsa ön skor korunuyor — ölçemediğimiz için kararı
 * değiştirmek doğru olmaz, ama en azından bilgi kaybı olmuyor.
 */
async function tamGovdeSkoru(
  client: ImapFlow,
  uid: number,
  konu: string,
  onSkor: number,
): Promise<{ skor: number; dil: "tr" | "en" }> {
  try {
    const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
    if (!msg || !msg.source) return { skor: onSkor, dil: "tr" };

    const parsed = await simpleParser(msg.source);
    const duz = htmlToOnizleme(parsed.html || parsed.text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!duz) return { skor: onSkor, dil: "tr" };

    const [yeni] = await spamSkorla([`${konu} ${duz}`.slice(0, 4000)]);
    return { skor: yeni?.skor ?? onSkor, dil: yeni?.model ?? "tr" };
  } catch {
    return { skor: onSkor, dil: "tr" };
  }
}

/**
 * Spam kutusundaki süresi dolmuş mailleri ÇÖP'E taşır.
 *
 * > [!note] Kalıcı silme yapılmıyor — bilerek
 * > "Temizlensin" isteği Çöp'e taşıyarak karşılanıyor, EXPUNGE ile değil.
 * > Model yanılabildiği için spam'e düşmüş gerçek bir mailin kalıcı olarak
 * > yok olması kabul edilebilir bir sonuç değil. Çöp'ten geri alınabilir;
 * > Çöp'ün kendi temizliği Dovecot tarafında ayarlanabilir.
 */
async function eskiSpamiTemizle(
  client: ImapFlow,
  spamKutusu: string,
  copKutusu: string,
  userId: number,
): Promise<number> {
  if (!(SPAM_OMRU_GUN > 0) || spamKutusu === copKutusu) return 0;

  const sinir = new Date(Date.now() - SPAM_OMRU_GUN * 24 * 60 * 60 * 1000);
  // imapflow arama başarısız olursa `false` döndürüyor, dizi değil
  const bulunan = await client.search({ before: sinir }, { uid: true });
  const uidler = Array.isArray(bulunan) ? bulunan : [];
  if (uidler.length === 0) return 0;

  await client.messageMove({ uid: uidler.join(",") }, copKutusu, { uid: true });

  await audit({
    userId,
    action: "spam.expired",
    detail: `${uidler.length} mail (${SPAM_OMRU_GUN} günden eski) Çöp'e taşındı`,
  });

  return uidler.length;
}

/**
 * Bakımı çalıştırır. Kilit ÇAĞIRANDA olmamalı — bu fonksiyon kendi
 * kutu kilitlerini alıyor.
 */
export async function bakimYap(
  client: ImapFlow,
  userId: number,
  kullanici: string,
): Promise<BakimSonucu> {
  const son = sonCalisma.get(kullanici) ?? 0;
  if (Date.now() - son < ARALIK_MS) return BOS;
  sonCalisma.set(kullanici, Date.now());

  const basladi = Date.now();
  try {
    const spamKutusu = await kutuBul(client, "\\Junk", ["Junk", "Spam"]);
    if (!spamKutusu) return BOS;

    let tasinan = 0;
    const inboxKilit = await client.getMailboxLock("INBOX");
    try {
      ({ tasinan } = await spameTasi(client, spamKutusu, userId));
    } finally {
      inboxKilit.release();
    }

    let temizlenen = 0;
    const copKutusu = await kutuBul(client, "\\Trash", ["Trash", "Çöp", "Deleted Messages"]);
    if (copKutusu) {
      const spamKilit = await client.getMailboxLock(spamKutusu);
      try {
        temizlenen = await eskiSpamiTemizle(client, spamKutusu, copKutusu, userId);
      } finally {
        spamKilit.release();
      }
    }

    /*
      Bakımın çalıştığı GÖRÜNÜR olmalı.

      2026-08-24'te 100 test spam'i taşınmadı ve sebebini anlamak için
      log yerine veritabanındaki denetim kaydına bakmak gerekti —
      "bakım koştu ama taşıyacak şey bulamadı" ile "bakım hiç koşmadı"
      dışarıdan aynı görünüyordu. Artık ayırt edilebiliyor.
    */
    console.log(
      JSON.stringify({
        olay: "bakim",
        kullanici,
        tasinan,
        temizlenen,
        sureMs: Date.now() - basladi,
      }),
    );
    return { tasinan, temizlenen };
  } catch (hata) {
    // Bakım bir ek hizmet; başarısız olursa mail listesi yine dönmeli.
    // Ama SESSİZ kalmamalı: eskiden `catch {}` idi ve bir çökme,
    // "yapacak iş yoktu" ile birebir aynı görünüyordu.
    console.error(
      JSON.stringify({
        olay: "bakim.hata",
        kullanici,
        hata: hata instanceof Error ? hata.message : String(hata),
      }),
    );
    return BOS;
  }
}
