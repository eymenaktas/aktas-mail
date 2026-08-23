import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-node";

/**
 * Spam sınıflandırma — ML kampı Gün 1'de eğitilen modeller.
 *
 * Model: CountVectorizer + MultinomialNB, tek ONNX dosyasına paketlenmiş.
 * Ham metni kabul eder; vektörleştirici de içinde, ayrıca sözlük taşımak
 * gerekmiyor. Python ya da scikit-learn kurulu olmasına gerek yok.
 *
 * İki ayrı model var çünkü Türkçe sondan eklemeli: aynı kök birçok farklı
 * kelimeye dönüşüyor, İngilizce sözlükle eğitilmiş model Türkçe'yi tanımıyor.
 *
 * > [!warning] DENEYSEL — bu bir tavsiye, karar değil
 * > Modeller küçük veriyle eğitildi (5158 İngilizce SMS + 616 Türkçe
 * > e-posta) ve kendi test kümelerinde %99 / %94 alıyorlar. Ama gerçek
 * > gelen kutusu o veriye benzemiyor.
 * >
 * > 2026-08-21'de 10 gerçekçi mail başlığıyla ölçüldü:
 * >
 * > | metin | beklenen | model |
 * > |---|---|---|
 * > | "Siparişiniz kargoya verildi" | ham | **SPAM %100** ❌ |
 * > | "Your GitHub security alert" | ham | **SPAM %93** ❌ |
 * > | "SON ŞANS!!! Kredi ONAYLANDI" | spam | **ham %46** ❌ |
 * > | "Doğrulama kodunuz: 746628" | ham | ham %6 ✅ |
 * > | "TEBRİKLER! hediye çeki kazandınız" | spam | SPAM %82 ✅ |
 * >
 * > 10 örnekte 2 yanlış alarm + 1 kaçırma. Sebep: eğitim verisinde kargo,
 * > fatura ve güvenlik uyarısı maili YOK; model bunları hiç görmedi.
 * >
 * > Bu yüzden: hiçbir mail SİLİNMEZ, taşınmaz, gizlenmez. Yalnızca eşiği
 * > geçenlerde soru işaretli bir rozet çıkar ve skor gösterilir. Asıl spam
 * > filtresi Postfix tarafında olmalı (rspamd/SpamAssassin).
 */

/**
 * Rozet eşiği — modelin kendi karar noktası.
 *
 * Önce 0.9'a çekilmişti (yanlış alarmı azaltmak için) ama Eymen skorun
 * her hâlükârda görünmesini istedi: rozet artık yüzdeyi ÜZERİNDE yazıyor,
 * yani "%62 spam?" ile "%99 spam?" arasındaki farkı kullanıcı kendisi
 * görüyor. Eşiği saklamak yerine skoru göstermek daha dürüst.
 */
export const SPAM_ESIGI = 0.5;

/**
 * Şüpheli eşiği — bunun üstünde UZAK GÖRSELLER AÇILMAZ.
 *
 * Uzak görsel bir takip pikseli: açılınca gönderen mailin okunduğunu,
 * IP'yi ve saati öğreniyor. Spam ihtimali olan bir mailde bunu vermek
 * "bu adres canlı" sinyali demek ve daha çok spam çeker. Eşik bilerek
 * DÜŞÜK (%20): burada yanılmanın bedeli sadece "görselleri göster"e
 * basmak, tersi ise adresini spam listelerinde onaylatmak.
 */
export const GORSEL_ESIGI = Number(process.env["SPAM_GORSEL_ESIGI"] ?? 0.2);

const BURASI = path.dirname(fileURLToPath(import.meta.url));
// dist/mail/spam.js -> ../../models
const MODEL_KLASORU = path.resolve(BURASI, "..", "..", "models");

export type ModelDili = "tr" | "en";

export interface SpamSonucu {
  /** Rozet gösterilsin mi (skor > SPAM_ESIGI) */
  spam: boolean;
  /** Spam olma olasılığı, 0..1 */
  skor: number;
  /** Hangi dil modeli kullanıldı */
  model: ModelDili;
}

/**
 * Modelin metni nasıl beklediği — `models/spam-model.json` içinde.
 *
 * NEDEN BAYRAK GEREKİYOR: Python'da "İ".lower() iki karakter üretir
 * (i + birleşen nokta), ONNX'in içindeki C++ küçültücü ise düz "i".
 * Yani sklearn "ACİL"i `aci` diye belirteçlerken ONNX `acil` diyor ve
 * aynı metinde farklı tahmin çıkıyor (ölçüldü: eşleşme %83).
 *
 * Yeni modeller bu yüzden küçültmeyi DIŞARIDA yapıp `lowercase=False`
 * ile eğitiliyor. Ama eski model normalizasyonsuz eğitildi — ona
 * normalize edilmiş metin vermek de yanlış olurdu. Bayrak ikisini
 * ayırıyor: dosya yoksa eski davranış.
 *
 * Bayrak DİL BAŞINA tutuluyor: Türkçe modeli yenileyip İngilizce'yi
 * eski bırakabiliyoruz (2026-08-21'de tam olarak bu oldu — Türkçe
 * model gerçekçi örnekleri geçti, İngilizce geçemedi).
 *
 * `araclar/spam_yeniden_egit.py` yeni model üretirken bu dosyayı da yazar.
 */
function normalizeBayraklari(): Record<string, boolean> {
  try {
    const ham = readFileSync(path.join(MODEL_KLASORU, "spam-model.json"), "utf8");
    const bilgi = JSON.parse(ham) as Record<string, { normalize?: boolean }>;
    return {
      tr: bilgi["tr"]?.normalize === true,
      en: bilgi["en"]?.normalize === true,
    };
  } catch {
    return { tr: false, en: false }; // dosya yok = iki model de eski
  }
}

const NORMALIZE = normalizeBayraklari();

/**
 * `araclar/spam_yeniden_egit.py` içindeki `turkce_normalize`'ın BİREBİR
 * karşılığı. İkisi ayrışırsa model sessizce kötü çalışır — hata vermez.
 * Doğrulandı (2026-08-21): altı Türkçe örnekte Node ve Python aynı çıktıyı
 * veriyor.
 */
const TR_KATLA: Record<string, string> = {
  "ç": "c", "ğ": "g", "ı": "i", "ö": "o", "ş": "s", "ü": "u",
};

export function normalizeMetin(metin: string): string {
  return metin
    .replace(/İ/g, "i")
    .toLowerCase()
    // Türkçe harfleri ASCII'ye katla. İki sebep:
    //  1. sklearn ve ONNX uzun Türkçe metinlerde farklı belirteçliyordu
    //     (ölçüldü: uyum %95.58 -> %100)
    //  2. Türkçe çoğu zaman şapkasız yazılıyor ("tesekkurler"); katlama
    //     iki yazımı da aynı kelime yapıyor
    .replace(/[çğıöşü]/g, (c) => TR_KATLA[c] ?? c);
}

const oturumlar = new Map<ModelDili, Promise<ort.InferenceSession>>();

function oturumAl(dil: ModelDili): Promise<ort.InferenceSession> {
  let mevcut = oturumlar.get(dil);
  if (!mevcut) {
    mevcut = ort.InferenceSession.create(path.join(MODEL_KLASORU, `spam_${dil}.onnx`));
    oturumlar.set(dil, mevcut);
  }
  return mevcut;
}

/**
 * Dil tahmini — iki dilin sık İŞLEV kelimelerini sayıp orana bakar.
 *
 * ÖNCEKİ HÂLİ HATALIYDI: "metinde bir tane Türkçe harf ya da Türkçe
 * kelime varsa tr" diyordu. Tek bir `ö` yetiyordu — imzasında
 * "Eymen Aktaş" geçen ya da gövdesinde bozuk kodlanmış bir karakter
 * bulunan İNGİLİZCE mail Türkçe sayılıyordu.
 *
 * Sonucu sessiz bir kaçak: İngilizce spam Türkçe modele gidiyor, o
 * model İngilizce spam'i hiç görmediği için ~%0 veriyor ve mail gelen
 * kutusunda kalıyor. 2026-08-24'te 20 gerçek spam'le denendi, 3'ü tam
 * bu yüzden kaçtı ("Save $30k even if you've refi'd" -> tr, %0).
 *
 * Doğrusu tek işaret aramak değil ORAN bakmak: hangi dilin işlev
 * kelimeleri baskınsa mailin dili odur. Türkçe'ye özgü harfler tek
 * başına karar vermiyor, yalnızca Türkçe tarafına ağırlık ekliyor.
 */
const TR_HARF = /[şğıİĞŞÇÖÜçöü]/g;
const TR_KELIME =
  /\b(ve|bir|için|bu|ile|olarak|değil|daha|çok|var|yok|merhaba|sayın|teşekkür|lütfen|tarih|kargo|sipariş|hesab\w*|gün|saat|kayıt|üye|indirim|tutar)\b/gi;
const EN_KELIME =
  /\b(the|and|you|your|for|with|this|that|are|from|have|will|our|please|thank|account|order|click|view|team|has|been|new|help|free|now)\b/gi;

export function diliTahminEt(metin: string): ModelDili {
  const ornek = metin.slice(0, 4000);
  const trKelime = (ornek.match(TR_KELIME) ?? []).length;
  const enKelime = (ornek.match(EN_KELIME) ?? []).length;
  // Türkçe harfler tek başına karar vermiyor; sayıları Türkçe tarafına
  // ölçülü bir katkı yapıyor (her 3 harf ~ 1 kelime ağırlığında).
  const trHarf = (ornek.match(TR_HARF) ?? []).length;
  const tr = trKelime + trHarf / 3;
  return enKelime > tr ? "en" : "tr";
}

/**
 * Bir grup metni tek seferde sınıflandırır.
 *
 * Dile göre gruplanıp her model bir kez çağrılır — mesaj başına ayrı
 * çıkarım yapmak 30 mesajlık bir listede gereksiz pahalı olurdu.
 */
export async function spamSkorla(metinler: string[]): Promise<SpamSonucu[]> {
  const sonuc: SpamSonucu[] = new Array(metinler.length);
  const gruplar = new Map<ModelDili, number[]>();

  metinler.forEach((metin, i) => {
    const dil = diliTahminEt(metin);
    const grup = gruplar.get(dil) ?? [];
    grup.push(i);
    gruplar.set(dil, grup);
  });

  await Promise.all(
    [...gruplar.entries()].map(async ([dil, indeksler]) => {
      try {
        const oturum = await oturumAl(dil);
        const girdi = new ort.Tensor(
          "string",
          indeksler.map((i) => {
            const ham = metinler[i] ?? "";
            return NORMALIZE[dil] ? normalizeMetin(ham) : ham;
          }),
          [indeksler.length, 1],
        );
        const cikti = await oturum.run({ [oturum.inputNames[0] as string]: girdi });
        const olasiliklar = cikti["probabilities"]?.data as Float32Array | undefined;

        indeksler.forEach((hedef, sira) => {
          // Sınıflar alfabetik: 0 = ham, 1 = spam
          const skor = olasiliklar ? (olasiliklar[sira * 2 + 1] ?? 0) : 0;
          sonuc[hedef] = { spam: skor > SPAM_ESIGI, skor, model: dil };
        });
      } catch {
        // Model yüklenemezse mail akışı durmaz — sınıflandırma sessizce atlanır.
        for (const hedef of indeksler) sonuc[hedef] = { spam: false, skor: 0, model: dil };
      }
    }),
  );

  return sonuc;
}
