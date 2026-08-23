import { createHash } from "node:crypto";
import { resolveTxt } from "node:dns/promises";

/**
 * Gönderen avatarı ve "mavi tik" — BIMI üzerinden.
 *
 * Gmail'den profil fotoğrafı çekmek MÜMKÜN DEĞİL: Google başkalarının
 * profil fotoğrafını veren public bir uç sunmuyor (People API yalnızca
 * kullanıcının kendi kişilerini döner ve OAuth ister).
 *
 * Ama Gmail'in gösterdiği marka logoları ve mavi tik zaten AÇIK bir
 * standarttan geliyor: BIMI. Domain şunu yayınlar:
 *
 *     default._bimi.example.com. TXT "v=BIMI1; l=https://…/logo.svg; a=https://…/vmc.pem"
 *
 *   l=  logonun SVG adresi
 *   a=  VMC (Verified Mark Certificate) — markayı bir sertifika otoritesi
 *       doğrulamış demek. MAVİ TİK BUDUR. `a=` boşsa logo var ama
 *       doğrulanmamış; sahtesi yapılabilir, tik gösterilmez.
 *
 * BIMI'nin ön koşulu domainin DMARC'ının `quarantine` ya da `reject`
 * olması. Yani BIMI logosu olan bir domain aynı zamanda kimlik sahtekârlığına
 * karşı korunuyor demektir — tik bu yüzden anlamlı.
 *
 * ## Gizlilik
 *
 * Aramalar SUNUCUDAN yapılır, tarayıcıdan değil. Kullanıcının IP'si
 * gönderene gitmez. Sonuç önbelleğe alınır; aksi halde her mail açılışı
 * gönderene "okundu" sinyali olurdu — uzak görselleri engellememizin
 * sebebiyle aynı sorun.
 */

export interface AvatarSonucu {
  /** data: URI, yoksa null (istemci harf avatarına düşer) */
  image: string | null;
  /** VMC doğrulanmış mı — mavi tik */
  verified: boolean;
  source: "bimi" | "dmarc" | "gravatar" | "none";
}

const BULUNAMADI: AvatarSonucu = { image: null, verified: false, source: "none" };

/** Logo indirme sınırı. Marka logoları küçüktür; büyüğü şüphelidir. */
const MAKS_BAYT = 256 * 1024;
const ZAMAN_ASIMI_MS = 4000;

/** SVG script çalıştırabilir. <img> içinde script çalışmaz ama yine de eliyoruz. */
const TEHLIKELI_SVG = /<\s*(script|foreignObject|iframe)\b|\bon[a-z]+\s*=|javascript:/i;

/** "Ali <ali@ornek.com>" değil, düz adres bekler: "ali@ornek.com". */
export function domainAyikla(adres: string): string | null {
  const at = adres.lastIndexOf("@");
  if (at === -1) return null;
  return adres.slice(at + 1).trim().toLowerCase() || null;
}

function gecerliDomain(domain: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domain);
}

async function sinirliIndir(url: string, kabul: RegExp): Promise<{ tip: string; veri: Buffer } | null> {
  // SSRF koruması: yalnızca https, yönlendirme takip edilmez.
  if (!/^https:\/\//i.test(url)) return null;

  const kontrol = AbortSignal.timeout(ZAMAN_ASIMI_MS);
  const cevap = await fetch(url, { signal: kontrol, redirect: "error" }).catch(() => null);
  if (!cevap?.ok) return null;

  const tip = (cevap.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  if (!kabul.test(tip)) return null;

  const uzunluk = Number(cevap.headers.get("content-length") ?? 0);
  if (uzunluk > MAKS_BAYT) return null;

  const veri = Buffer.from(await cevap.arrayBuffer());
  if (veri.byteLength > MAKS_BAYT) return null;

  return { tip, veri };
}

/** `v=BIMI1; l=...; a=...` kaydını ayrıştırır. */
export function bimiAyristir(kayit: string): { l?: string; a?: string } | null {
  if (!/^\s*v\s*=\s*BIMI1\s*;/i.test(kayit)) return null;
  const alanlar: Record<string, string> = {};
  for (const parca of kayit.split(";")) {
    const [ad, ...deger] = parca.split("=");
    if (!ad) continue;
    alanlar[ad.trim().toLowerCase()] = deger.join("=").trim();
  }
  const sonuc: { l?: string; a?: string } = {};
  if (alanlar["l"]) sonuc.l = alanlar["l"];
  if (alanlar["a"]) sonuc.a = alanlar["a"];
  return sonuc;
}

/**
 * Çok parçalı uzantılar. Bunlar olmadan "sirket.com.tr" için
 * "com.tr" sorgulanır — anlamsız ve gereksiz.
 */
const COK_PARCALI = new Set([
  "com.tr", "net.tr", "org.tr", "edu.tr", "gov.tr", "co.uk", "org.uk",
  "ac.uk", "gov.uk", "com.au", "co.jp", "com.br", "co.in", "com.mx",
]);

/**
 * BIMI adayları: tam domainden kuruluş domainine doğru.
 *
 * Gerekli çünkü mailler alt domainden gelir: TikTok'un doğrulama maili
 * `noreply@account.tiktok.com` adresinden geliyor ama BIMI kaydı
 * `tiktok.com` üzerinde. Yalnızca tam domaine bakarsak logo bulunamaz.
 * BIMI şartnamesi de bu geri çekilmeyi tanımlıyor.
 */
export function bimiAdaylari(domain: string): string[] {
  const parcalar = domain.split(".");
  const adaylar: string[] = [];
  // Kuruluş domaini normalde son 2 parça, çok parçalı uzantıda 3.
  const son2 = parcalar.slice(-2).join(".");
  const taban = COK_PARCALI.has(son2) ? 3 : 2;

  for (let i = 0; i + taban <= parcalar.length; i += 1) {
    adaylar.push(parcalar.slice(i).join("."));
    if (adaylar.length >= 3) break; // en fazla 3 DNS sorgusu
  }
  return adaylar;
}

export async function bimiCoz(domain: string): Promise<AvatarSonucu | null> {
  for (const aday of bimiAdaylari(domain)) {
    const kayitlar = await resolveTxt(`default._bimi.${aday}`).catch(() => null);
    if (!kayitlar?.length) continue;

    for (const parcalar of kayitlar) {
      const bimi = bimiAyristir(parcalar.join(""));
      if (!bimi?.l) continue;

      const indirilen = await sinirliIndir(bimi.l, /^image\/svg\+xml$/i);
      if (!indirilen) continue;

      const svg = indirilen.veri.toString("utf8");
      if (TEHLIKELI_SVG.test(svg)) continue;

      return {
        image: `data:image/svg+xml;base64,${indirilen.veri.toString("base64")}`,
        // `a=` VARSA marka doğrulanmış. Sertifikanın kendisini doğrulamıyoruz
        // (bkz. dosya sonundaki not).
        verified: Boolean(bimi.a),
        source: "bimi",
      };
    }
  }
  return null;
}

/**
 * DMARC zorlaması — BIMI yayınlamayan kurumlar için ikinci kademe tik.
 *
 * Google, kendi işlem maillerinde BIMI YAYINLAMIYOR (ölçüldü 2026-08-22:
 * `default._bimi.google.com` boş). Ama `_dmarc.google.com` **p=reject**
 * diyor: o domaini taklit eden mail alıcı tarafından reddediliyor.
 * Yani "bu mail gerçekten google.com'dan" güvencesi VAR.
 *
 * Ayrımı bu kural kendiliğinden yapıyor:
 *   google.com          p=reject   -> tik  (yalnızca Google gönderebilir)
 *   accounts.google.com p=reject   -> tik
 *   gmail.com           p=none     -> TİK YOK (herkesin adresi, zorlama yok)
 *
 * > [!warning] VMC'den ZAYIF bir güvence
 * > VMC, markayı bir sertifika otoritesinin doğrulaması demek.
 * > DMARC yalnızca "bu domain taklit edilemez" diyor — domainin
 * > KİME ait olduğunu ve iyi niyetli olduğunu söylemiyor. Kötü niyetli
 * > biri de p=reject yayınlayabilir. Arayüzdeki ipucu metni bu yüzden
 * > dayanağı açıkça yazıyor.
 *
 * ## 2026-08-24: `quarantine` de kabul ediliyor
 *
 * Önce yalnızca `reject` kabul ediliyordu. GitHub bu yüzden tik
 * alamıyordu — ölçüldü:
 *
 *     github.com   p=quarantine; sp=reject   -> tik YOKtu
 *     google.com   p=reject                  -> tik vardı
 *
 * Oysa ayrım pratikte anlamlı değil: ikisi de ZORLAYICI politika.
 * `reject` sahte maili reddettiriyor, `quarantine` spam klasörüne
 * attırıyor — her iki durumda da taklit mail gelen kutusuna DÜŞMÜYOR.
 * Asıl ayrım `p=none` ile olan: o yalnızca rapor toplar, hiçbir
 * koruma vermez ve tik almaz (gmail.com böyle).
 */
async function dmarcZorluyorMu(domain: string): Promise<boolean> {
  // BIMI'deki gibi kuruluş domainine kadar geri çekil
  for (const aday of bimiAdaylari(domain)) {
    const kayitlar = await resolveTxt(`_dmarc.${aday}`).catch(() => null);
    if (!kayitlar?.length) continue;
    const kayit = kayitlar.map((k) => k.join("")).find((k) => /^\s*v=DMARC1/i.test(k));
    if (!kayit) continue;
    // Zorlayıcı politika: reject ya da quarantine. `none` koruma vermez.
    return /\bp\s*=\s*(reject|quarantine)\b/i.test(kayit);
  }
  return false;
}

/**
 * Gravatar — kişilerin fotoğrafı için tek gerçekçi kaynak.
 *
 * NEDEN GMAIL DEĞİL: Google, başkalarının profil fotoğrafını veren public
 * bir uç sunmuyor. Eski `google.com/s2/photos/profile` adresi kapandı;
 * People API yalnızca kullanıcının KENDİ kişilerini döner ve OAuth ister.
 * Hiçbir üçüncü taraf istemci Gmail'den fotoğraf çekemiyor — Thunderbird,
 * Apple Mail, Outlook da çekmiyor. Hepsi Gravatar ya da kendi rehberini
 * kullanır.
 *
 * Gravatar sağlayıcıdan bağımsız çalışır: e-postanın SHA-256'sı bir adrese
 * çevrilir. Kişi gravatar.com'a kayıtlıysa fotoğrafı gelir.
 *
 * GİZLİLİK BEDELİ: adres hash'i Automattic'e (Gravatar'ın sahibi) gider.
 * Hash geri çevrilemez ama yaygın adresler sözlük saldırısıyla bulunabilir.
 * Bu yüzden istek SUNUCUDAN atılır (kullanıcının IP'si sızmaz) ve sonuç
 * önbelleğe alınır. Kapatmak istersen `AVATAR_GRAVATAR=false`.
 */
export async function gravatarCoz(adres: string): Promise<AvatarSonucu | null> {
  if (process.env["AVATAR_GRAVATAR"] === "false") return null;

  const hash = createHash("sha256").update(adres.trim().toLowerCase()).digest("hex");
  // d=404: kayıt yoksa varsayılan görsel ÜRETME, 404 dön — böylece
  // "fotoğrafı var" ile "yok" ayırt edilebiliyor.
  const indirilen = await sinirliIndir(
    `https://gravatar.com/avatar/${hash}?s=128&d=404`,
    /^image\/(png|jpeg|gif|webp)$/i,
  );
  if (!indirilen) return null;

  return {
    image: `data:${indirilen.tip};base64,${indirilen.veri.toString("base64")}`,
    // Gravatar kimlik doğrulamaz, herkes istediği fotoğrafı koyar. Tik yok.
    verified: false,
    source: "gravatar",
  };
}

/**
 * Bir gönderen için avatar çözer. TAM ADRES ver ("ali@ornek.com"):
 * BIMI domaine, Gravatar tam adrese bakıyor.
 *
 * Önbellek ÇAĞIRANIN işi — bu fonksiyon her çağrıda ağa çıkar.
 */
export async function avatarCoz(adres: string): Promise<AvatarSonucu> {
  const temiz = adres.trim().toLowerCase();
  const domain = temiz.includes("@") ? (temiz.split("@").pop() ?? "") : temiz;
  if (!gecerliDomain(domain)) return BULUNAMADI;

  try {
    // Sıra önemli: BIMI kurumsal ve DOĞRULANMIŞ, Gravatar kişisel ve
    // doğrulanmamış. Bir domain BIMI yayınlıyorsa o kazanır.
    const bimi = await bimiCoz(domain);
    if (bimi) return bimi;

    // Gravatar tam adres ister; yalnızca domain verildiyse bakılamaz.
    if (temiz.includes("@")) {
      const gravatar = await gravatarCoz(temiz);
      if (gravatar) return { ...gravatar, verified: await dmarcZorluyorMu(domain) };
    }

    // Fotoğraf yok ama domain taklit edilemiyorsa yine de tik ver:
    // harf avatarı + mavi tik (Google'ın işlem mailleri böyle).
    if (await dmarcZorluyorMu(domain)) {
      return { image: null, verified: true, source: "dmarc" };
    }
    return BULUNAMADI;
  } catch {
    return BULUNAMADI;
  }
}

/**
 * > [!note] VMC gerçekten doğrulanmıyor
 * > `a=` alanının VARLIĞINA bakıyoruz, sertifikayı indirip zincirini
 * > doğrulamıyoruz. Yani kötü niyetli bir domain `a=` alanına geçerli
 * > olmayan bir adres yazıp tik alabilir.
 * >
 * > Tam doğrulama için VMC (PEM) indirilip imza zinciri BIMI'nin kabul
 * > ettiği CA kök listesine karşı kontrol edilmeli ve sertifikadaki
 * > logo hash'i indirilen SVG ile karşılaştırılmalı. Bu ayrı bir iş;
 * > yapılana kadar tik "domain BIMI'yi doğru kurmuş" anlamında okunmalı,
 * > "marka kanıtlanmış" anlamında değil.
 */
