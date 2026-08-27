#!/usr/bin/env bash
#
# Jarvis mail erişimini kurar. SUNUCUDA, root olarak çalıştırılır.
#
# Ne yapar:
#   1. Dovecot'a `jarvis` master user ekler (parolayı SEN girersin)
#   2. Uygulamanın .env'ine erişim bilgilerini yazar
#   3. Her adımdan önce yedek alır
#
# Ne YAPMAZ:
#   - Parolayı argüman olarak almaz, ekrana yazmaz, geçmişe düşürmez
#   - Var olan yapılandırmayı ezmez; iki kez çalıştırılabilir
#
# Geri alma: bkz. docs/jarvis-erisim.md
set -euo pipefail

LOCAL_CONF=/etc/dovecot/local.conf
MASTER_DOSYASI=/etc/dovecot/master-users
ENV_DOSYASI=/opt/aktas-mail/backend/.env
DAMGA=$(date +%Y%m%d-%H%M%S)

renk() { printf "\033[1;36m%s\033[0m\n" "$*"; }
uyari() { printf "\033[1;33m%s\033[0m\n" "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "root olarak çalıştır."; exit 1; }

renk "1/4 — Yedekler alınıyor"
cp -a "$LOCAL_CONF" "$LOCAL_CONF.yedek-$DAMGA"
[ -f "$ENV_DOSYASI" ] && cp -a "$ENV_DOSYASI" "$ENV_DOSYASI.yedek-$DAMGA"
echo "  $LOCAL_CONF.yedek-$DAMGA"

renk "2/4 — Master user parolası"
if grep -q '^jarvis:' "$MASTER_DOSYASI" 2>/dev/null; then
  uyari "  jarvis zaten tanımlı, parola değiştirilmedi."
else
  echo "  Jarvis için bir parola belirle. Ekranda görünmeyecek."
  echo "  Bu parolayı Mac'teki Jarvis'e gireceksin, başka yere yazma."
  # `doveadm pw` parolayı kendisi sorar — argüman olarak geçmiyor,
  # yani kabuk geçmişine ve süreç listesine düşmüyor.
  HASH=$(doveadm pw -s SHA512-CRYPT)
  touch "$MASTER_DOSYASI"
  chmod 600 "$MASTER_DOSYASI"
  chown root:dovecot "$MASTER_DOSYASI"
  echo "jarvis:$HASH" >> "$MASTER_DOSYASI"
  echo "  eklendi: $MASTER_DOSYASI"
fi

renk "3/4 — Dovecot yapılandırması"
if grep -q 'master-users' "$LOCAL_CONF"; then
  uyari "  master passdb zaten var, dokunulmadı."
else
  # Master passdb NORMAL passdb'den ÖNCE gelmeli; Dovecot sırayla
  # deniyor ve `result_success = continue-ok` ile asıl kullanıcının
  # kutusuna geçiş yapılıyor.
  python3 - "$LOCAL_CONF" <<'PYEOF'
import sys, re
yol = sys.argv[1]
metin = open(yol).read()
blok = """# Jarvis master user — asistanın kendi kimliği.
# Giriş biçimi: eymen@akts.tr*jarvis
# İptal için bu bloğu sil ve /etc/dovecot/master-users dosyasını boşalt.
passdb {
  driver = passwd-file
  args = scheme=SHA512-CRYPT username_format=%u /etc/dovecot/master-users
  master = yes
  result_success = continue-ok
}

"""
i = metin.index("passdb {")
open(yol, "w").write(metin[:i] + blok + metin[i:])
PYEOF
  grep -q '^auth_master_user_separator' "$LOCAL_CONF" \
    || echo 'auth_master_user_separator = *' >> "$LOCAL_CONF"
  echo "  master passdb eklendi"
fi

renk "4/4 — Uygulama ayarları"
if grep -q '^JARVIS_TOKEN_HASH=' "$ENV_DOSYASI" 2>/dev/null; then
  uyari "  JARVIS_TOKEN_HASH zaten var, yeni token üretilmedi."
else
  TOKEN=$(openssl rand -hex 32)
  TOKEN_HASH=$(printf '%s' "$TOKEN" | openssl dgst -sha256 -hex | awk '{print $2}')
  {
    echo ""
    echo "# Jarvis erişimi — salt okuma, gönderme yok"
    echo "JARVIS_IMAP_USER=eymen@akts.tr*jarvis"
    echo "JARVIS_IMAP_PASS=BURAYA_JARVIS_PAROLASI"
    echo "JARVIS_TOKEN_HASH=$TOKEN_HASH"
  } >> "$ENV_DOSYASI"

  echo ""
  uyari "  ── BU TOKEN'I ŞİMDİ KOPYALA, BİR DAHA GÖSTERİLMEYECEK ──"
  echo "  $TOKEN"
  uyari "  ────────────────────────────────────────────────────────"
  echo ""
  echo "  Ayrıca $ENV_DOSYASI içindeki JARVIS_IMAP_PASS satırına"
  echo "  az önce belirlediğin parolayı yazman gerekiyor."
fi

echo ""
renk "Kurulum bitti. Sırada:"
echo "  1. $ENV_DOSYASI içinde JARVIS_IMAP_PASS'i doldur"
echo "  2. doveconf -n >/dev/null   # yapılandırma sözdizimi kontrolü"
echo "  3. systemctl reload dovecot"
echo "  4. pm2 restart aktas-mail"
echo "  5. Doğrula: curl -s -H \"Authorization: Bearer <token>\" \\"
echo "       https://mail.akts.tr/api/jarvis/ozet | head -c 200"
