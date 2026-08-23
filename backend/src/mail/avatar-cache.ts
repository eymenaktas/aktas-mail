import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { senderAvatars } from "../db/schema.js";
import { bimiCoz, gravatarCoz, domainAyikla, type AvatarSonucu } from "./avatar.js";

export { domainAyikla };

/**
 * Avatar önbelleği — iki katmanlı.
 *
 *   BIMI     domain başına  ("tiktok.com")     — aynı domainden 50 mail
 *                                                gelse tek DNS sorgusu
 *   Gravatar adres başına   ("ali@ornek.com")  — kişiye özel
 *
 * Önbellek yalnızca hız için değil GİZLİLİK için de gerekli: her mail
 * açılışında dışarı istek gitmesi, uzak görselleri engellememizin
 * sebebiyle aynı sinyali verir ("bu mail okundu").
 */

const TAZE_MS = 30 * 24 * 60 * 60 * 1000; // bulunanlar
const BOS_TAZE_MS = 3 * 24 * 60 * 60 * 1000; // bulunamayanlar

const BULUNAMADI: AvatarSonucu = { image: null, verified: false, source: "none" };

/** Aynı anahtar için eşzamanlı istekleri tek aramada birleştirir. */
const ucusta = new Map<string, Promise<AvatarSonucu>>();

async function onbellektenOku(anahtar: string): Promise<AvatarSonucu | null> {
  const [kayit] = await db
    .select()
    .from(senderAvatars)
    .where(eq(senderAvatars.key, anahtar))
    .limit(1);
  if (!kayit) return null;

  const yas = Date.now() - kayit.fetchedAt.getTime();
  if (yas >= (kayit.image ? TAZE_MS : BOS_TAZE_MS)) return null;

  return {
    image: kayit.image,
    verified: kayit.verified,
    source: kayit.source as AvatarSonucu["source"],
  };
}

async function onbellegeYaz(anahtar: string, sonuc: AvatarSonucu): Promise<void> {
  await db
    .insert(senderAvatars)
    .values({
      key: anahtar,
      image: sonuc.image,
      verified: sonuc.verified,
      source: sonuc.source,
      fetchedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: senderAvatars.key,
      set: {
        image: sonuc.image,
        verified: sonuc.verified,
        source: sonuc.source,
        fetchedAt: new Date(),
      },
    })
    .catch(() => {}); // önbellek yazılamazsa da sonuç döner
}

/** Bir anahtarı çözer; eşzamanlı çağrıları birleştirir, sonucu önbelleğe yazar. */
function coz(anahtar: string, uret: () => Promise<AvatarSonucu>): Promise<AvatarSonucu> {
  let bekleyen = ucusta.get(anahtar);
  if (!bekleyen) {
    bekleyen = (async () => {
      const sonuc = await uret().catch(() => BULUNAMADI);
      await onbellegeYaz(anahtar, sonuc);
      return sonuc;
    })().finally(() => ucusta.delete(anahtar));
    ucusta.set(anahtar, bekleyen);
  }
  return bekleyen;
}

export async function avatarGetir(adres: string): Promise<AvatarSonucu> {
  const temiz = adres.trim().toLowerCase();
  const domain = domainAyikla(temiz);
  if (!domain) return BULUNAMADI;

  // 1) BIMI — kurumsal ve doğrulanmış. Bir domain BIMI yayınlıyorsa o kazanır.
  const bimi =
    (await onbellektenOku(domain)) ??
    (await coz(domain, async () => (await bimiCoz(domain)) ?? BULUNAMADI));
  if (bimi.image) return bimi;

  // 2) Gravatar — kişisel, doğrulanmamış.
  return (
    (await onbellektenOku(temiz)) ??
    (await coz(temiz, async () => (await gravatarCoz(temiz)) ?? BULUNAMADI))
  );
}

/** Bir liste için adresleri tekilleştirip toplu çözer. */
export async function avatarlariGetir(
  adresler: Array<string | null | undefined>,
): Promise<Record<string, AvatarSonucu>> {
  const tekil = [
    ...new Set(
      adresler
        .map((a) => a?.trim().toLowerCase())
        .filter((a): a is string => !!a && a.includes("@")),
    ),
  ];
  const ciftler = await Promise.all(tekil.map(async (a) => [a, await avatarGetir(a)] as const));
  return Object.fromEntries(ciftler);
}
