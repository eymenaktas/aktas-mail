/**
 * Backend istemcisi.
 * Oturum httpOnly çerezde — token'a JS erişmiyor, o yüzden burada
 * saklanacak bir şey yok. `credentials: "include"` yeterli.
 */

/**
 * Boş = aynı origin. Geliştirmede vite `/api`'yi backend'e proxy'liyor
 * (bkz. vite.config.ts), üretimde nginx aynı işi yapıyor.
 *
 * Doğrudan `http://127.0.0.1:3001` yazmak çalışmaz: farklı origin olur,
 * `SameSite=Strict` oturum çerezi gönderilmez ve her istek 401 döner.
 */
const BASE = import.meta.env["VITE_API_BASE"] ?? "";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });

  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : {};

  if (!res.ok) {
    const msg =
      typeof data === "object" && data && "error" in data
        ? String((data as { error: unknown }).error)
        : `İstek başarısız (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

// ── Tipler ──────────────────────────────────────────────────

export interface Address {
  name: string;
  address: string;
}

/** ML kampı Gün 1 modelinin spam tavsiyesi. DENEYSEL — bkz. backend/src/mail/spam.ts */
export interface SpamSonucu {
  spam: boolean;
  skor: number;
  model: "tr" | "en";
}

export interface MessageSummary {
  uid: number;
  seq: number;
  subject: string;
  from: Address | null;
  date: string | null;
  preview: string;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  spam?: SpamSonucu;
}

/** Gönderen avatarı: BIMI logosu (mavi tikli) ya da Gravatar fotoğrafı. */
export interface SenderAvatar {
  image: string | null;
  /** VMC doğrulanmış marka — mavi tik */
  verified: boolean;
  source: "bimi" | "dmarc" | "gravatar" | "none";
}

export interface Attachment {
  filename: string;
  contentType: string;
  size: number;
}

/** Cihazdan bağımsız tercihler — hesapta saklanıyor. */
export interface Ayarlar {
  tema?: "light" | "dark";
  arkaplan?: string;
  desen?: string;
  okumaTemasi?: "auto" | "light" | "dark";
}

export interface Profile {
  email: string;
  displayName: string | null;
  avatar: string | null;
  settings: Ayarlar | null;
}

export interface MessageDetail extends MessageSummary {
  to: Address[];
  cc: Address[];
  html: string;
  blockedImages: number;
  externalLinks: number;
  attachments: Attachment[];
  /** Gövdeye gömülü (cid:) görseller — uzak görselden farklı, takip riski yok */
  inlineImages: number;
  /** BIMI + VMC doğrulanmış gönderen (mavi tik) — uzak görselleri otomatik açılır */
  senderVerified: boolean;
  /** Uzak görseller spam şüphesi (%20 üstü) yüzünden engellendiyse true */
  gorselSpamNedeniyle: boolean;
}

export interface Mailbox {
  path: string;
  name: string;
  specialUse: string | null;
  subscribed: boolean;
  /** Okunmamış mail sayısı (IMAP STATUS) */
  unseen: number;
}

/** Bir listeleme isteğinde yapılan bakım */
export interface Bakim {
  tasinan: number;
  temizlenen: number;
}

export interface ModelDil {
  normalize: boolean;
  surum?: string;
  algoritma?: string;
  dogruluk?: number;
  /** Spam sınıfının F1'i — dengesiz veride doğruluktan çok daha anlamlı */
  f1?: number;
  kesinlik?: number;
  duyarlilik?: number;
  onceki_dogruluk?: number;
  ornek_sayisi?: number;
  denge?: { ham: number; spam: number };
  kaynaklar?: Array<{ ad: string; adet: number; not?: string }>;
  guclu?: string[];
  zayif?: string[];
}

export interface SpamIstatistik {
  toplam: number;
  etiketler: Array<{ label: string; adet: number }>;
  modelDogrulugu: number | null;
  yeterliMi: boolean;
}

export interface Passkey {
  id: number;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** Sarmal kayıtlı mı — yani bu passkey parolasız girişi açıyor mu */
  passwordlessLogin: boolean;
}

export interface Me {
  user: { email: string; displayName: string | null; secondFactor: string };
  domain: string;
  domains: string[];
  isAdmin: boolean;
}

export interface AdminUser {
  email: string;
  isAdmin: boolean;
  /** Kutu var ama hiç giriş yapmamışsa uygulamada kaydı yoktur */
  hasLoggedIn: boolean;
}

export type LoginResult =
  | { status: "ok"; user?: { email: string; displayName: string | null } }
  | {
      status: "2fa_required";
      method: "totp" | "passkey" | "device";
      challenge?: string;
      devices?: Array<{ id: number; label: string; platform: string }>;
    };

// ── Kimlik ──────────────────────────────────────────────────

export const api = {
  health: () => request<{ status: string; time: string }>("/api/health"),

  me: () => request<Me>("/api/auth/me"),

  login: (email: string, password: string) =>
    request<LoginResult>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  loginTotp: (token: string) =>
    request<{ status: string }>("/api/auth/login/2fa", {
      method: "POST",
      body: JSON.stringify({ method: "totp", token }),
    }),

  loginRecovery: (code: string) =>
    request<{ status: string }>("/api/auth/login/2fa", {
      method: "POST",
      body: JSON.stringify({ method: "recovery", code }),
    }),

  logout: () => request<{ status: string }>("/api/auth/logout", { method: "POST" }),

  /** Passkey eklemeden önce yeniden kimlik doğrulama. */
  verifyPassword: (password: string) =>
    request<{ status: string }>("/api/auth/verify-password", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  passkeys: () => request<{ passkeys: Passkey[] }>("/api/auth/passkeys"),

  // ── Yönetim (yalnızca admin) ──────────────────────────────

  adminUsers: () =>
    request<{ admin: string; users: AdminUser[] }>("/api/admin/users"),

  /** adminPassword: yönetici kendi parolasıyla işlemi doğrular. */
  adminAddUser: (email: string, password: string, adminPassword: string) =>
    request<{ status: string; message: string }>("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ email, password, adminPassword }),
    }),

  adminRemoveUser: (email: string, adminPassword: string) =>
    request<{ status: string; message: string }>("/api/admin/users/remove", {
      method: "POST",
      body: JSON.stringify({ email, adminPassword }),
    }),

  refresh: () => request<{ status: string }>("/api/auth/refresh", { method: "POST" }),

  // ── Passkey ───────────────────────────────────────────────

  passkeyLoginOptions: () =>
    request<PublicKeyCredentialRequestOptionsJSON>("/api/auth/passkey/login/options", {
      method: "POST",
      body: JSON.stringify({}),
    }),

  passkeyLoginVerify: (response: unknown) =>
    request<
      | { status: "unwrap"; email: string; wrappedSecret: string }
      | { status: "password_required"; email: string; reason: string }
    >("/api/auth/passkey/login/verify", {
      method: "POST",
      body: JSON.stringify({ response }),
    }),

  passkeyLoginComplete: (password: string) =>
    request<{ status: string; user: { email: string; displayName: string | null } }>(
      "/api/auth/passkey/login/complete",
      { method: "POST", body: JSON.stringify({ password }) },
    ),

  passkeyRegisterOptions: () =>
    request<PublicKeyCredentialCreationOptionsJSON>("/api/auth/passkey/register/options", {
      method: "POST",
      body: JSON.stringify({}),
    }),

  passkeyRegisterVerify: (
    response: unknown,
    wrappedSecret: string | null,
    label?: string,
  ) =>
    request<{ status: string; passwordlessLogin: boolean }>(
      "/api/auth/passkey/register/verify",
      {
        method: "POST",
        body: JSON.stringify({ response, wrappedSecret, label }),
      },
    ),

  // ── Posta ─────────────────────────────────────────────────

  mailboxes: () => request<{ mailboxes: Mailbox[] }>("/api/mailboxes"),

  /** Klasör başına okunmamış sayısı (IMAP STATUS — kutuyu açmadan) */
  unreadCounts: () => request<{ counts: Record<string, number> }>("/api/unread-counts"),

  readAll: (mailbox: string) =>
    request<{ okunan: number }>("/api/messages/read-all", {
      method: "POST",
      body: JSON.stringify({ mailbox }),
    }),

  messages: (mailbox = "INBOX", limit = 30, sayfa = 0) =>
    request<{
      messages: MessageSummary[];
      bakim: Bakim;
      /** Kutudaki toplam mesaj — sayfa sayısı bundan hesaplanıyor */
      toplam: number;
      sayfa: number;
      limit: number;
    }>(
      `/api/messages?mailbox=${encodeURIComponent(mailbox)}` +
        `&limit=${limit}&sayfa=${sayfa}`,
    ),

  /**
   * Seçilen mailleri toplu taşı. `tumu` verilirse klasörün tamamı.
   * Kalıcı silme yok — hedef "cop" bile olsa Çöp'e taşınıyor.
   */
  topluTasi: (
    mailbox: string,
    hedef: "cop" | "spam" | "gelen",
    uids: number[],
    tumu = false,
  ) =>
    request<{ tasinan: number; hedef: string }>("/api/messages/bulk-move", {
      method: "POST",
      body: JSON.stringify({ mailbox, hedef, uids, tumu }),
    }),

  /** Bir maili spam / spam değil diye işaretle — model eğitimi için veri */
  spamLabel: (uid: number, mailbox: string, label: "spam" | "ham") =>
    request<{
      ok: boolean;
      label: string;
      modelSkoru: number | null;
      /** Mail taşındıysa hedef kutu, taşınmadıysa null */
      tasindi: string | null;
    }>("/api/spam/label", {
      method: "POST",
      body: JSON.stringify({ uid, mailbox, label }),
    }),

  /** Bu maile daha önce verilmiş etiket (yoksa null) */
  spamLabelGet: (uid: number, mailbox: string) =>
    request<{ label: "spam" | "ham" | null }>(
      `/api/spam/label?uid=${uid}&mailbox=${encodeURIComponent(mailbox)}`,
    ),

  spamStats: () => request<SpamIstatistik>("/api/spam/stats"),

  /** Modelin künyesi: eğitim verisi, doğruluk, bilinen zayıflıklar */
  spamModel: () =>
    request<{ model: Record<string, ModelDil> | null }>("/api/spam/model"),

  /** Sunucu tarafı arama — kutunun tamamını tarar (IMAP SEARCH). */
  search: (q: string, mailbox = "INBOX", limit = 50) =>
    request<{ messages: MessageSummary[] }>(
      `/api/search?q=${encodeURIComponent(q)}&mailbox=${encodeURIComponent(mailbox)}&limit=${limit}`,
    ),

  message: (uid: number, mailbox = "INBOX", images: "blocked" | "allowed" = "blocked") =>
    request<{ message: MessageDetail }>(
      `/api/messages/${uid}?mailbox=${encodeURIComponent(mailbox)}&images=${images}`,
    ),

  /**
   * Gönderen avatarları — ayrı çağrı, çünkü DNS + HTTP aramaları
   * mail listesini bekletmemeli. Liste önce basılır, avatarlar sonra düşer.
   */
  senderAvatars: (addresses: string[]) =>
    request<{ avatars: Record<string, SenderAvatar> }>("/api/sender-avatars", {
      method: "POST",
      body: JSON.stringify({ addresses }),
    }),

  profile: () => request<{ profile: Profile | null }>("/api/profile"),

  // ── Bildirimler ───────────────────────────────────────────
  pushKey: () => request<{ key: string }>("/api/push/key"),
  pushDevices: () =>
    request<{ devices: Array<{ endpoint: string; label: string | null; createdAt: string; lastSentAt: string | null }>; hazir: boolean }>(
      "/api/push/devices",
    ),
  pushSubscribe: (sub: unknown, label: string) =>
    request<{ ok: boolean }>("/api/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ ...(sub as Record<string, unknown>), label }),
    }),
  pushUnsubscribe: (endpoint: string) =>
    request<{ ok: boolean }>("/api/push/subscribe", {
      method: "DELETE",
      body: JSON.stringify({ endpoint }),
    }),
  pushTest: () => request<{ gonderilen: number; temizlenen: number }>("/api/push/test", { method: "POST" }),

  /** Kısmi güncelleme: yalnızca gönderilen alanlar değişir. */
  saveSettings: (ayarlar: Ayarlar) =>
    request<{ settings: Ayarlar }>("/api/profile/settings", {
      method: "PUT",
      body: JSON.stringify(ayarlar),
    }),

  setAvatar: (avatar: string) =>
    request<{ ok: boolean }>("/api/profile/avatar", {
      method: "POST",
      body: JSON.stringify({ avatar }),
    }),

  clearAvatar: () => request<{ ok: boolean }>("/api/profile/avatar", { method: "DELETE" }),

  setFlag: (uid: number, flag: "seen" | "flagged", value: boolean, mailbox = "INBOX") =>
    request<{ status: string }>(`/api/messages/${uid}/flags`, {
      method: "POST",
      body: JSON.stringify({ flag, value, mailbox }),
    }),

  send: (payload: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    text: string;
    html?: string;
  }) =>
    request<{ status: string; messageId: string; savedToSent: boolean }>(
      "/api/messages/send",
      { method: "POST", body: JSON.stringify(payload) },
    ),
};

// WebAuthn JSON tipleri — tarayıcı tipleri henüz JSON biçimini içermiyor
export interface PublicKeyCredentialRequestOptionsJSON {
  challenge: string;
  rpId?: string;
  timeout?: number;
  userVerification?: string;
  allowCredentials?: Array<{ id: string; type: string; transports?: string[] }>;
  extensions?: Record<string, unknown>;
}

export interface PublicKeyCredentialCreationOptionsJSON {
  challenge: string;
  rp: { name: string; id?: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ alg: number; type: string }>;
  timeout?: number;
  excludeCredentials?: Array<{ id: string; type: string }>;
  authenticatorSelection?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}
