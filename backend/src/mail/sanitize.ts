import sanitizeHtml from "sanitize-html";

/**
 * Gelen mailin gövdesi SALDIRGANIN YAZDIĞI HTML'dir.
 * Bir posta istemcisinde en büyük risk SQL injection değil, budur.
 *
 * Buradan çıkan HTML yine de doğrudan sayfaya basılmaz — istemci onu
 * `sandbox` iframe içinde gösterir (allow-scripts YOK). Bu modül
 * sunucu tarafındaki ilk savunma katmanı.
 */

/** Uzak görsel = takip pikseli. Gönderen; mailin okunduğunu, IP'yi ve saati öğrenir. */
const PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export interface SanitizeResult {
  html: string;
  /** Engellenen uzak görsel sayısı — arayüzde "Görselleri göster" için */
  blockedImages: number;
  /** Dışarıya giden link sayısı — phishing uyarısı için */
  externalLinks: number;
}

/**
 * Bir href'in dışarıya taşınmasının güvenli olup olmadığı.
 * allowedSchemes ile aynı listeyi tutar; ikisi ayrışırsa açık doğar.
 */
function isSafeHref(href: string): boolean {
  return /^(https?|mailto|tel):/i.test(href.trim());
}

export function sanitizeEmailHtml(
  dirty: string,
  opts: { allowRemoteImages?: boolean } = {},
): SanitizeResult {
  const allowRemoteImages = opts.allowRemoteImages ?? false;

  let blockedImages = 0;
  let externalLinks = 0;

  const html = sanitizeHtml(dirty, {
    allowedTags: [
      "p", "div", "span", "br", "hr",
      "h1", "h2", "h3", "h4", "h5", "h6",
      "strong", "b", "em", "i", "u", "s", "sub", "sup", "small",
      "ul", "ol", "li", "dl", "dt", "dd",
      "blockquote", "pre", "code",
      "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption",
      "a", "img",
      // script, iframe, form, object, embed, style, link, base BİLEREK YOK
    ],

    // DİKKAT: transformTags'in eklediği öznitelikler de burada izinli olmalı —
    // filtre transform'dan SONRA çalışıyor, aksi halde rel/noopener sessizce düşer.
    allowedAttributes: {
      a: ["href", "title", "rel", "target", "data-external-href"],
      img: ["src", "alt", "title", "width", "height", "data-blocked-src"],
      td: ["colspan", "rowspan", "align", "valign"],
      th: ["colspan", "rowspan", "align", "valign"],
      table: ["width", "border", "cellpadding", "cellspacing"],
      "*": ["style"], // aşağıda allowedStyles ile dar tutuluyor
    },

    // javascript:, data: (görsel hariç), vbscript: hepsi eler
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https", "data", "cid"] },
    allowProtocolRelative: false,

    // Sadece görünüm etkileyen, davranış değiştirmeyen özellikler
    allowedStyles: {
      "*": {
        color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\(/i, /^[a-z-]+$/i],
        "background-color": [/^#[0-9a-f]{3,8}$/i, /^rgba?\(/i, /^[a-z-]+$/i],
        "text-align": [/^(left|right|center|justify)$/],
        "font-weight": [/^(normal|bold|[1-9]00)$/],
        "font-style": [/^(normal|italic)$/],
        "text-decoration": [/^(none|underline|line-through)$/],
        "font-size": [/^\d+(\.\d+)?(px|pt|em|rem|%)$/],
        "font-family": [/^[\w\s,'"-]+$/],
        padding: [/^[\d\s.]+(px|pt|em|rem|%)?$/],
        margin: [/^[\d\s.]+(px|pt|em|rem|%)?$/],
        // position/z-index/transform yok: sayfa üstüne bindirme (clickjacking) engeli
      },
    },

    transformTags: {
      a: (tagName, attribs) => {
        const href = attribs["href"] ?? "";
        if (/^https?:\/\//i.test(href)) externalLinks += 1;
        return {
          tagName: "a",
          attribs: {
            ...attribs,
            // noopener: açılan sayfa window.opener ile bize erişemesin
            rel: "noopener noreferrer nofollow",
            target: "_blank",
            // İstemci bunu okuyup phishing uyarı ekranı gösterir. ŞEMAYI BURADA DA
            // doğrulamak şart: allowedSchemes yalnızca href'i temizler, bu kopyayı
            // değil — kontrolsüz bırakılırsa javascript:/data: URL'i geri sızar.
            ...(isSafeHref(href) ? { "data-external-href": href } : {}),
          },
        };
      },

      img: (tagName, attribs) => {
        const src = attribs["src"] ?? "";
        const isRemote = /^https?:\/\//i.test(src);
        if (isRemote && !allowRemoteImages) {
          blockedImages += 1;
          return {
            tagName: "img",
            attribs: {
              src: PLACEHOLDER,
              alt: attribs["alt"] ?? "",
              "data-blocked-src": src, // kullanıcı isterse istemci geri yükler
              style: "opacity:.35",
            },
          };
        }
        return { tagName: "img", attribs };
      },
    },

    // <script>/<style> içeriği metin olarak bile sızmasın
    nonTextTags: ["script", "style", "textarea", "option", "noscript", "title"],
    disallowedTagsMode: "discard",
    enforceHtmlBoundary: true,
  });

  return { html, blockedImages, externalLinks };
}

/**
 * Düz metin gövdeler için: HTML kaçışı + linkleri güvenli <a>'ya çevirme.
 * text/plain mailler HTML yolundan geçmemeli, o yüzden ayrı.
 */
export function plainTextToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  return escaped
    .replace(
      /\b(https?:\/\/[^\s<]+)/g,
      '<a href="$1" rel="noopener noreferrer nofollow" target="_blank" data-external-href="$1">$1</a>',
    )
    .replace(/\n/g, "<br>");
}
