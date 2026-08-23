/**
 * MIME gövde çözme — saf fonksiyonlar, dış bağımlılığı yok.
 *
 * imap.ts'ten ayrı duruyor: burası env/IMAP bağlantısı gerektirmediği için
 * doğrudan test edilebiliyor.
 */

/**
 * Gövde baytlarını doğru çözer.
 *
 * Eski kod `String.fromCharCode(parseInt(hex, 16))` yapıyordu: her baytı
 * ayrı bir Unicode karakteri sanıyordu. UTF-8'de "ğ" iki bayttır (C4 9F),
 * bu yüzden "Doğrulama" -> "DoÄrulama" çıkıyordu. Doğrusu: önce BAYTLARI
 * topla, sonra bildirilen charset ile çöz.
 */
function decodeQuotedPrintable(text: string): Buffer {
  const temiz = text.replace(/=\r?\n/g, ""); // yumuşak satır sonu
  const baytlar: number[] = [];
  for (let i = 0; i < temiz.length; i += 1) {
    if (temiz[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(temiz.slice(i + 1, i + 3))) {
      baytlar.push(parseInt(temiz.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      baytlar.push(temiz.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(baytlar);
}

export function decodeBody(ham: Buffer, encoding: string, charset: string): string {
  let baytlar: Buffer;
  if (encoding === "base64") baytlar = Buffer.from(ham.toString("ascii"), "base64");
  else if (encoding === "quoted-printable") baytlar = decodeQuotedPrintable(ham.toString("latin1"));
  else baytlar = ham;

  // Türkçe eski mailler ISO-8859-9 kullanır; UTF-8 varsayarsak bozulur.
  try {
    return new TextDecoder(charset || "utf-8").decode(baytlar);
  } catch {
    return baytlar.toString("utf8");
  }
}

interface TextLeaf {
  part: string;
  encoding: string;
  charset: string;
  isHtml: boolean;
}

/** bodyStructure ağacındaki metin yapraklarını bulur; text/plain tercih edilir. */
export function textLeaves(node: unknown): TextLeaf[] {
  if (!node || typeof node !== "object") return [];
  const n = node as {
    type?: string;
    part?: string;
    encoding?: string;
    parameters?: { charset?: string };
    childNodes?: unknown[];
  };
  if (n.childNodes?.length) return n.childNodes.flatMap((c) => textLeaves(c));

  const type = (n.type ?? "").toLowerCase();
  if (type !== "text/plain" && type !== "text/html") return [];
  return [
    {
      part: n.part ?? "1",
      encoding: (n.encoding ?? "").toLowerCase(),
      charset: n.parameters?.charset ?? "utf-8",
      isHtml: type === "text/html",
    },
  ];
}

/**
 * HTML'i önizleme metnine çevirir.
 *
 * Sadece etiketleri silmek YETMEZ: `<style>` ve `<script>` bloklarının
 * İÇERİĞİ de metindir ve etiket silindikten sonra geriye ham CSS kalır.
 * Pazarlama mailleri gövdeye devasa `<style>` blokları koyduğu için
 * önizleme "em { font-style: normal; ... }" diye başlıyordu.
 * Bu blokları içerikleriyle birlikte atıyoruz.
 */
export function htmlToOnizleme(html: string): string {
  return (
    html
      // önce görünmez blokları içeriğiyle beraber sil
      .replace(/<(style|script|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      // HTML yorumları (koşullu yorumlar dahil) da metin değil
      .replace(/<!--[\s\S]*?-->/g, " ")
      // kapanışı olmayan bozuk <style ...> için emniyet: kalan etiketleri sil
      .replace(/<[^>]*>/g, " ")
      // sık kullanılan varlıkları çöz, kalanları temizle
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&zwnj;|&#8203;|\u200b|\u200c/gi, "")
  );
}

/**
 * Liste önizlemesi. Tüm mesajın kaynağını indirmek pahalı olduğu için
 * yalnızca ilk iki gövde parçası çekiliyor ("1" düz yapı, "1.1" iç içe
 * multipart için) ve bodyStructure'dan gelen kodlama/charset ile çözülüyor.
 */
export function buildPreview(
  bodyParts: Map<string, Buffer> | undefined,
  bodyStructure: unknown,
): string {
  if (!bodyParts) return "";
  const yapraklar = textLeaves(bodyStructure);
  const sirali = [...yapraklar].sort((a, b) => Number(a.isHtml) - Number(b.isHtml));

  for (const yaprak of sirali) {
    const ham = bodyParts.get(yaprak.part);
    if (!ham) continue;
    const metin = decodeBody(ham, yaprak.encoding, yaprak.charset);
    const duz = (yaprak.isHtml ? htmlToOnizleme(metin) : metin)
      .replace(/\s+/g, " ")
      .trim();
    if (duz) return duz.slice(0, 200);
  }
  return "";
}
