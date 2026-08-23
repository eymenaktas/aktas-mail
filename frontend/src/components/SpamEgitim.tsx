import { useEffect, useState } from "react";
import { api, type SpamIstatistik, type ModelDil } from "../lib/api.js";

/**
 * Spam modeli eğitim verisi paneli.
 *
 * Şu anki model ML kampı Gün 1'de eğitildi (5158 İngilizce SMS + 616
 * Türkçe e-posta) ve gerçek gelen kutusunda yanılıyor: kargo/fatura
 * maillerine spam diyor, bazı gerçek spam'i kaçırıyor. Sebebi basit —
 * o mail türlerini hiç görmedi.
 *
 * Bu panel toplanan veriyi ve modelin o veriyle ne kadar uyuştuğunu
 * gösteriyor. Yeterince örnek birikince CSV indirilip model yeniden
 * eğitilebiliyor.
 */
export function SpamEgitim() {
  const [ist, setIst] = useState<SpamIstatistik | null>(null);
  const [hata, setHata] = useState<string | null>(null);
  const [model, setModel] = useState<Record<string, ModelDil> | null>(null);

  useEffect(() => {
    api.spamStats().then(setIst).catch((e: Error) => setHata(e.message));
    api.spamModel().then((r) => setModel(r.model)).catch(() => {});
  }, []);

  if (hata) return <p className="err">{hata}</p>;
  if (!ist) return <p className="modal-sub">Yükleniyor…</p>;

  const spam = ist.etiketler.find((e) => e.label === "spam")?.adet ?? 0;
  const ham = ist.etiketler.find((e) => e.label === "ham")?.adet ?? 0;

  return (
    <section>
      {/* Modelin künyesi — rozete bakan kişi neye güvendiğini bilsin.
          Sayılar `models/spam-model.json`'dan geliyor, yani eğitim
          betiğinin ölçtüğü değerler; elle girilmiş değil. */}
      {model &&
        (["tr", "en"] as const).map((dil) => {
          const m = model[dil];
          if (!m) return null;
          const ad = dil === "tr" ? "Türkçe" : "İngilizce";
          const artis =
            m.dogruluk && m.onceki_dogruluk
              ? Math.round((m.dogruluk - m.onceki_dogruluk) * 100)
              : null;
          return (
            <details key={dil} className="model-kunye" open={dil === "tr"}>
              <summary>
                <b>{ad} model</b>
                {/* Başlıkta F1 var, doğruluk değil: bu veride maillerin
                    %92'si zaten normal, yani doğruluk şişik görünüyor. */}
                {m.f1 != null && (
                  <span className="model-skor" title="Spam sınıfının F1 skoru">
                    F1 %{(m.f1 * 100).toFixed(1)}
                  </span>
                )}
                {artis != null && artis > 0 && (
                  <span className="model-artis">+{artis} puan</span>
                )}
                {m.surum && <span className="model-surum">{m.surum}</span>}
              </summary>

              {m.algoritma && <p className="model-satir">{m.algoritma}</p>}

              {m.f1 != null && (
                <>
                  <h5>Ölçümler</h5>
                  <div className="model-olcum">
                    <div title="Spam'i kaçırma ve yanlış alarm dengesinin tek sayısı">
                      <b>%{(m.f1 * 100).toFixed(1)}</b>
                      <span>F1 (spam)</span>
                    </div>
                    {m.kesinlik != null && (
                      <div title="'Spam' dediğinin ne kadarı gerçekten spam">
                        <b>%{(m.kesinlik * 100).toFixed(0)}</b>
                        <span>kesinlik</span>
                      </div>
                    )}
                    {m.duyarlilik != null && (
                      <div title="Gerçek spam'in ne kadarını yakaladı">
                        <b>%{(m.duyarlilik * 100).toFixed(0)}</b>
                        <span>duyarlılık</span>
                      </div>
                    )}
                    {m.dogruluk != null && (
                      <div title="Tüm maillerin ne kadarını doğru sınıfladı — bu veride yanıltıcı">
                        <b className="model-soluk">%{(m.dogruluk * 100).toFixed(1)}</b>
                        <span>doğruluk</span>
                      </div>
                    )}
                  </div>
                  <p className="model-satir">
                    Doğruluk burada <b>yanıltıcı</b>: maillerin %92'si zaten
                    normal, yani "her şeye normal de" diyen bir model bile %92
                    alır. F1 spam sınıfına bakıyor.
                  </p>
                </>
              )}

              {m.kaynaklar && (
                <>
                  <h5>Eğitim verisi{m.ornek_sayisi ? ` (${m.ornek_sayisi} örnek)` : ""}</h5>
                  <ul className="model-liste">
                    {m.kaynaklar.map((k) => (
                      <li key={k.ad}>
                        <b>{k.adet.toLocaleString("tr-TR")}</b> {k.ad}
                        {k.not && <span className="model-not"> — {k.not}</span>}
                      </li>
                    ))}
                  </ul>
                  {m.denge && (
                    <p className="model-satir">
                      Denge: {m.denge.ham.toLocaleString("tr-TR")} normal /{" "}
                      {m.denge.spam.toLocaleString("tr-TR")} spam
                    </p>
                  )}
                </>
              )}

              {m.guclu && m.guclu.length > 0 && (
                <>
                  <h5>Güçlü olduğu yer</h5>
                  <ul className="model-liste model-iyi">
                    {m.guclu.map((g) => (
                      <li key={g}>{g}</li>
                    ))}
                  </ul>
                </>
              )}

              {m.zayif && m.zayif.length > 0 && (
                <>
                  <h5>Bilinen zayıflıkları</h5>
                  <ul className="model-liste model-kotu">
                    {m.zayif.map((z) => (
                      <li key={z}>{z}</li>
                    ))}
                  </ul>
                </>
              )}
            </details>
          );
        })}

      <h4 className="gorunum-baslik">Senin işaretlediklerin</h4>
      <p className="modal-sub">
        Bir maili açıp <b>Spam</b> / <b>Spam değil</b> dediğinde örnek buraya
        birikiyor. Yeterince örnek olunca model bu veriyle yeniden eğitilebilir.
      </p>

      <div className="egitim-sayilar">
        <div>
          <b>{ist.toplam}</b>
          <span>toplam örnek</span>
        </div>
        <div>
          <b>{spam}</b>
          <span>spam</span>
        </div>
        <div>
          <b>{ham}</b>
          <span>spam değil</span>
        </div>
        <div>
          <b>
            {ist.modelDogrulugu === null
              ? "—"
              : `%${Math.round(ist.modelDogrulugu * 100)}`}
          </b>
          <span>model seninle uyuşuyor</span>
        </div>
      </div>

      {ist.toplam === 0 ? (
        <p className="pp-not">
          Henüz örnek yok. Bir mail aç, üstündeki çubuktan işaretle.
        </p>
      ) : ist.yeterliMi ? (
        <p className="pp-not">
          <b>Yeniden eğitim için yeterli veri var.</b> CSV'yi indirip
          ML kampı Gün 1'deki eğitim koduna ver — biçim oradaki
          <code> veri/spam_tr.csv</code> ile aynı.
        </p>
      ) : (
        <p className="pp-not">
          Yeniden eğitim için ~200 örnek hedefle; şu an {ist.toplam} var.
          <br />
          Dengeli olması önemli: sadece spam işaretlersen model her şeye
          spam demeyi öğrenir. Normal mailleri de işaretle.
        </p>
      )}

      {ist.toplam > 0 && (
        <p style={{ marginTop: 12 }}>
          {/*
            İndirme normal bir link: uç `content-disposition: attachment`
            gönderiyor, oturum çerezi de otomatik gidiyor.
          */}
          <a className="btn btn-primary" href="/api/spam/dataset">
            CSV indir ({ist.toplam} satır)
          </a>
        </p>
      )}

      <p className="pp-not">
        Saklanan: konu + gövdenin düz metin hâlinin ilk 4000 karakteri.
        Mailin tamamı kopyalanmıyor — eğitim için gerekmiyor ve postanın
        ikinci bir kopyasını veritabanında tutmak gereksiz risk.
      </p>
    </section>
  );
}
