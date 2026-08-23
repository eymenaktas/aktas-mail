/**
 * MIME çözme regresyon testleri.
 *
 * 2026-08-21: gelen Türkçe maillerde "Doğrulama" yerine "DoÄrulama"
 * görünüyordu ve gömülü logolar kırık simge çıkıyordu. Sebep elle yazılmış
 * ayrıştırıcıydı: quoted-printable'ı bayt değil karakter olarak çözüyor,
 * `cid:` görselleri hiç çözmüyordu. Bu dosya ikisinin de geri gelmemesi için.
 */
import assert from "node:assert/strict";
import { simpleParser } from "mailparser";
import { decodeBody, buildPreview, textLeaves, htmlToOnizleme } from "./mime.js";

let gecti = 0;
let kaldi = 0;
function test(ad: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${ad}`);
      gecti += 1;
    })
    .catch((e: Error) => {
      console.log(`  ✗ ${ad}\n      ${e.message}`);
      kaldi += 1;
    });
}

const mesaj = (satirlar: string[]) => satirlar.join("\r\n");

console.log("\nMIME çözme");

await test("quoted-printable UTF-8: ğ iki bayttır, tek karakter değil", () => {
  const cozulmus = decodeBody(
    Buffer.from("Do=C4=9Frulama l=C3=BCtfen", "latin1"),
    "quoted-printable",
    "utf-8",
  );
  assert.equal(cozulmus, "Doğrulama lütfen");
});

await test("quoted-printable yumuşak satır sonu birleştiriliyor", () => {
  const cozulmus = decodeBody(
    Buffer.from("l=C3=\r\n=BCtfen", "latin1"),
    "quoted-printable",
    "utf-8",
  );
  assert.equal(cozulmus, "lütfen");
});

await test("ISO-8859-9 (eski Türkçe mailler) doğru çözülüyor", () => {
  const cozulmus = decodeBody(
    Buffer.from("Do=F0rulama l=FCtfen", "latin1"),
    "quoted-printable",
    "ISO-8859-9",
  );
  assert.equal(cozulmus, "Doğrulama lütfen");
});

await test("base64 gövde çözülüyor", () => {
  const b64 = Buffer.from("Doğrulama Kodu", "utf8").toString("base64");
  assert.equal(decodeBody(Buffer.from(b64), "base64", "utf-8"), "Doğrulama Kodu");
});

await test("kodlama başlığı yoksa gövde olduğu gibi okunuyor", () => {
  assert.equal(decodeBody(Buffer.from("Doğrulama", "utf8"), "", "utf-8"), "Doğrulama");
});

await test("bilinmeyen charset çökertmiyor, UTF-8'e düşüyor", () => {
  assert.equal(decodeBody(Buffer.from("Doğrulama", "utf8"), "", "x-uydurma"), "Doğrulama");
});

await test("iç içe multipart'ta cid: görsel data: URI'ye çevriliyor", async () => {
  const ham = mesaj([
    'Content-Type: multipart/related; boundary="OUT"',
    "",
    "--OUT",
    'Content-Type: multipart/alternative; boundary="IN"',
    "",
    "--IN",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    '<p>Do=C4=9Frulama</p><img src=3D"cid:logo">',
    "--IN--",
    "--OUT",
    "Content-Type: image/png",
    "Content-ID: <logo>",
    "Content-Transfer-Encoding: base64",
    "",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "--OUT--",
    "",
  ]);
  const parsed = await simpleParser(ham);
  assert.ok(parsed.html?.includes("Doğrulama"), "Türkçe çözülmeli");
  assert.ok(!parsed.html?.includes("Ä"), "mojibake olmamalı");
  assert.ok(parsed.html?.includes("data:image/png"), "cid: -> data: olmalı");
  assert.ok(!parsed.html?.includes("cid:"), "çözülmemiş cid: kalmamalı");
});

await test("bodyStructure'da text/plain, text/html'e tercih ediliyor", () => {
  const yapraklar = textLeaves({
    type: "multipart/alternative",
    childNodes: [
      { type: "text/html", part: "2", encoding: "quoted-printable", parameters: {} },
      { type: "text/plain", part: "1", encoding: "quoted-printable", parameters: {} },
    ],
  });
  assert.equal(yapraklar.length, 2);
  assert.ok(yapraklar.some((y) => !y.isHtml));
});

await test("önizleme çözülüyor ve HTML etiketleri düşüyor", () => {
  const parcalar = new Map([
    ["1", Buffer.from("<p>Do=C4=9Frulama    Kodu</p>", "latin1")],
  ]);
  const onizleme = buildPreview(parcalar, {
    type: "text/html",
    part: "1",
    encoding: "quoted-printable",
    parameters: { charset: "utf-8" },
  });
  assert.equal(onizleme, "Doğrulama Kodu");
});

/**
 * 2026-08-21: liste önizlemesinde ham CSS görünüyordu
 * ("em { font-style: normal; font-weight: bold; } @media ...").
 * Etiketleri silmek yetmiyor; <style> ve <script> İÇERİĞİ de gidilmeli.
 */
await test("önizlemede <style> içeriği görünmüyor", () => {
  const html = `<html><head><style>em { font-style: normal; } @media screen { .a { color: red } }</style></head>
    <body><p>Doğrulama kodunuz: 746628</p></body></html>`;
  const onizleme = htmlToOnizleme(html).replace(/\s+/g, " ").trim();
  assert.ok(!onizleme.includes("font-style"), `CSS sızdı: ${onizleme.slice(0, 60)}`);
  assert.ok(!onizleme.includes("@media"), `CSS sızdı: ${onizleme.slice(0, 60)}`);
  assert.ok(onizleme.includes("Doğrulama kodunuz: 746628"), onizleme);
});

await test("önizlemede <script> içeriği görünmüyor", () => {
  const onizleme = htmlToOnizleme('<script>var x = "gizli";</script><p>Merhaba</p>');
  assert.ok(!onizleme.includes("gizli"), onizleme);
  assert.ok(onizleme.includes("Merhaba"));
});

await test("HTML yorumları ve varlıklar temizleniyor", () => {
  const onizleme = htmlToOnizleme("<!--[if mso]>outlook<![endif]--><p>A&nbsp;&amp;&nbsp;B</p>")
    .replace(/\s+/g, " ")
    .trim();
  assert.ok(!onizleme.includes("outlook"), onizleme);
  assert.equal(onizleme, "A & B");
});

console.log(`\nSonuç: ${gecti} geçti, ${kaldi} kaldı`);
if (kaldi > 0) process.exit(1);
