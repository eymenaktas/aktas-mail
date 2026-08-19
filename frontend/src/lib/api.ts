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
}

export interface MessageDetail extends MessageSummary {
  to: Address[];
  cc: Address[];
  html: string;
  blockedImages: number;
  externalLinks: number;
}

export interface Mailbox {
  path: string;
  name: string;
  specialUse: string | null;
  subscribed: boolean;
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

  messages: (mailbox = "INBOX", limit = 30) =>
    request<{ messages: MessageSummary[] }>(
      `/api/messages?mailbox=${encodeURIComponent(mailbox)}&limit=${limit}`,
    ),

  /** Sunucu tarafı arama — kutunun tamamını tarar (IMAP SEARCH). */
  search: (q: string, mailbox = "INBOX", limit = 50) =>
    request<{ messages: MessageSummary[] }>(
      `/api/search?q=${encodeURIComponent(q)}&mailbox=${encodeURIComponent(mailbox)}&limit=${limit}`,
    ),

  message: (uid: number, mailbox = "INBOX", images: "blocked" | "allowed" = "blocked") =>
    request<{ message: MessageDetail }>(
      `/api/messages/${uid}?mailbox=${encodeURIComponent(mailbox)}&images=${images}`,
    ),

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
