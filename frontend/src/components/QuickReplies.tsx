import { useMemo } from "react";
import type { MessageDetail } from "../lib/api.js";

/**
 * Hazır cevaplar — mailin altındaki tek tıkla yanıt önerileri.
 *
 * > [!note] Bu YAPAY ZEKÂ DEĞİL, kural tablosu
 * > Gmail'in "Smart Reply"ı bir dil modeliyle cümle üretiyor. Burada
 * > öyle bir şey yok: mailin konusunda/gövdesinde geçen anahtar
 * > kelimelere bakıp hazır şablon öneriyor. Bunu açıkça yazıyorum ki
 * > sonradan "model neden bu cümleyi üretti" diye aranmasın.
 * >
 * > Gerçek anlamda üretilmiş yanıt istenirse bir dil modeli gerekir
 * > ve o, mailin içeriğini dışarı göndermek demektir — bu uygulamanın
 * > gizlilik tercihiyle çelişir. Kural tablosu bilinçli bir seçim.
 *
 * Öneri seçilince yazma penceresi o metinle açılıyor; kullanıcı
 * göndermeden önce düzenleyebiliyor — hiçbir şey otomatik gitmiyor.
 */

interface Kural {
  /** Konu + gövdede aranan desen */
  desen: RegExp;
  cevaplar: string[];
}

const KURALLAR: Kural[] = [
  {
    // Toplantı / randevu daveti
    desen: /\b(toplantı|görüşme|randevu|müsait|buluş|meeting)\w*/i,
    cevaplar: ["Uygun, katılıyorum.", "Bu saatte müsait değilim, alternatif önerebilir misiniz?", "Teyit ederim, teşekkürler."],
  },
  {
    // Soru soran mailler
    desen: /\?\s*$|\b(soru|görüşün|ne dersin|olur mu|mümkün mü)\b/i,
    cevaplar: ["Bakıp döneceğim.", "Evet, uygun.", "Kontrol edip en kısa sürede yazacağım."],
  },
  {
    // Teklif / fiyat
    desen: /\b(teklif|fiyat|bütçe|ücret|sözleşme|fatura)\w*/i,
    cevaplar: ["Teklifi inceleyip döneceğim.", "Detayları paylaşabilir misiniz?", "Teşekkürler, değerlendiriyoruz."],
  },
  {
    // İş başvurusu / davet
    desen: /\b(başvuru|mülakat|pozisyon|iş görüşmesi|cv)\w*/i,
    cevaplar: ["İlginiz için teşekkürler, değerlendirip döneceğim.", "Detaylı bilgi alabilir miyim?"],
  },
  {
    // Kargo / sipariş bildirimi — genelde cevap gerekmez ama bazen gerekir
    desen: /\b(kargo|sipariş|teslimat|gönderi)\w*/i,
    cevaplar: ["Teşekkürler, aldım.", "Teslimat adresi güncellenebilir mi?"],
  },
];

/** Hiçbir kural tutmazsa gösterilen genel cevaplar. */
const GENEL = ["Teşekkürler!", "Aldım, döneceğim.", "Tamamdır."];

export function QuickReplies({
  msg,
  onSec,
}: {
  msg: MessageDetail;
  onSec: (metin: string) => void;
}) {
  const oneriler = useMemo(() => {
    // Gövdenin tamamını taramak gereksiz; ilk kısım konuyu belli ediyor
    const metin = `${msg.subject} ${msg.html.replace(/<[^>]*>/g, " ").slice(0, 600)}`;
    const eslesen = KURALLAR.find((k) => k.desen.test(metin));
    return (eslesen?.cevaplar ?? GENEL).slice(0, 3);
  }, [msg.subject, msg.html]);

  return (
    <div className="hazir-cevaplar">
      <span className="hazir-baslik">Hazır cevap:</span>
      {oneriler.map((c) => (
        <button key={c} className="hazir-dugme" onClick={() => onSec(c)}>
          {c}
        </button>
      ))}
    </div>
  );
}
