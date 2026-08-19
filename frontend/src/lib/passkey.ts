/**
 * Passkey + PRF — parolasız girişin istemci tarafı.
 *
 * PRF (Pseudo-Random Function) uzantısı, passkey'den her seferinde AYNI
 * 32 baytlık gizli değeri türetir. Bunu AES-GCM anahtarına çevirip posta
 * parolasını sarmalıyoruz.
 *
 * Kritik nokta: PRF çıktısı authenticator'ın İÇİNDE üretilir ve yalnızca
 * bu sayfaya verilir. Sunucu hiçbir zaman görmez — sarmalı çözemez.
 */

/**
 * PRF girdisi sabit olmalı: aynı passkey + aynı girdi = aynı anahtar.
 *
 * Not: TS 5.7'den beri Uint8Array generic (SharedArrayBuffer de olabilir),
 * WebAuthn ise gerçek ArrayBuffer istiyor — bu yüzden hepsini `bytes()`
 * üzerinden gerçek ArrayBuffer'a dayalı olarak üretiyoruz.
 */
function bytes(input: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(input);
  const buf = new ArrayBuffer(encoded.length);
  const view = new Uint8Array(buf);
  view.set(encoded);
  return view;
}

const PRF_SALT = bytes("aktas-mail:imap-password:v1");

// ── base64url yardımcıları ──────────────────────────────────

export function b64uToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const bin = atob(b64 + pad);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i += 1) view[i] = bin.charCodeAt(i);
  return view;
}

export function bytesToB64u(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── PRF anahtarı ────────────────────────────────────────────

/** Tarayıcı/authenticator PRF destekliyor mu? */
export function prfSupported(): boolean {
  return (
    typeof PublicKeyCredential !== "undefined" &&
    typeof navigator.credentials?.get === "function"
  );
}

async function keyFromPrf(prfOutput: ArrayBuffer): Promise<CryptoKey> {
  // PRF çıktısı doğrudan anahtar malzemesi; HKDF ile AES anahtarına çevir
  const material = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(new ArrayBuffer(0)),
      info: new TextEncoder().encode("aktas-mail-wrap"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** IV | ciphertext → base64url */
export async function wrapPassword(
  password: string,
  prfOutput: ArrayBuffer,
): Promise<string> {
  const key = await keyFromPrf(prfOutput);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(password),
  );
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  return bytesToB64u(out);
}

export async function unwrapPassword(
  wrapped: string,
  prfOutput: ArrayBuffer,
): Promise<string> {
  const key = await keyFromPrf(prfOutput);
  const raw = b64uToBytes(wrapped);
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  // Kurcalanmışsa GCM burada hata fırlatır
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

// ── WebAuthn akışları ───────────────────────────────────────

interface PrfResults {
  prf?: { results?: { first?: ArrayBuffer } };
}

/** Giriş: passkey doğrula + PRF çıktısını al. */
export async function passkeyAuthenticate(optionsJSON: {
  challenge: string;
  rpId?: string;
  timeout?: number;
  userVerification?: string;
  allowCredentials?: Array<{ id: string; type: string; transports?: string[] }>;
}): Promise<{ response: unknown; prfOutput: ArrayBuffer | null }> {
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: b64uToBytes(optionsJSON.challenge),
    ...(optionsJSON.rpId ? { rpId: optionsJSON.rpId } : {}),
    ...(optionsJSON.timeout ? { timeout: optionsJSON.timeout } : {}),
    userVerification:
      (optionsJSON.userVerification as UserVerificationRequirement) ?? "required",
    ...(optionsJSON.allowCredentials?.length
      ? {
          allowCredentials: optionsJSON.allowCredentials.map((c) => ({
            id: b64uToBytes(c.id),
            type: "public-key" as const,
            ...(c.transports
              ? { transports: c.transports as AuthenticatorTransport[] }
              : {}),
          })),
        }
      : {}),
    // PRF uzantısı: DOM tipleri henüz içermiyor, cast gerekiyor
    extensions: {
      prf: { eval: { first: PRF_SALT } },
    } as AuthenticationExtensionsClientInputs,
  };

  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Passkey alınamadı");

  const ext = cred.getClientExtensionResults() as PrfResults;
  const prfOutput = ext.prf?.results?.first ?? null;

  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    response: {
      id: cred.id,
      rawId: bytesToB64u(cred.rawId),
      type: cred.type,
      clientExtensionResults: {},
      response: {
        clientDataJSON: bytesToB64u(r.clientDataJSON),
        authenticatorData: bytesToB64u(r.authenticatorData),
        signature: bytesToB64u(r.signature),
        userHandle: r.userHandle ? bytesToB64u(r.userHandle) : undefined,
      },
    },
    prfOutput,
  };
}

/** Kayıt: passkey oluştur + PRF çıktısını al. */
export async function passkeyRegister(optionsJSON: {
  challenge: string;
  rp: { name: string; id?: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ alg: number; type: string }>;
  timeout?: number;
  excludeCredentials?: Array<{ id: string; type: string }>;
  authenticatorSelection?: Record<string, unknown>;
}): Promise<{ response: unknown; prfOutput: ArrayBuffer | null }> {
  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: b64uToBytes(optionsJSON.challenge),
    rp: optionsJSON.rp,
    user: {
      id: b64uToBytes(optionsJSON.user.id),
      name: optionsJSON.user.name,
      displayName: optionsJSON.user.displayName,
    },
    pubKeyCredParams: optionsJSON.pubKeyCredParams.map((p) => ({
      alg: p.alg,
      type: "public-key" as const,
    })),
    ...(optionsJSON.timeout ? { timeout: optionsJSON.timeout } : {}),
    ...(optionsJSON.excludeCredentials?.length
      ? {
          excludeCredentials: optionsJSON.excludeCredentials.map((c) => ({
            id: b64uToBytes(c.id),
            type: "public-key" as const,
          })),
        }
      : {}),
    authenticatorSelection: (optionsJSON.authenticatorSelection ?? {
      residentKey: "required",
      userVerification: "required",
    }) as AuthenticatorSelectionCriteria,
    extensions: {
      prf: { eval: { first: PRF_SALT } },
    } as AuthenticationExtensionsClientInputs,
  };

  const cred = (await navigator.credentials.create({
    publicKey,
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Passkey oluşturulamadı");

  const ext = cred.getClientExtensionResults() as PrfResults;
  const prfOutput = ext.prf?.results?.first ?? null;

  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    response: {
      id: cred.id,
      rawId: bytesToB64u(cred.rawId),
      type: cred.type,
      clientExtensionResults: {},
      response: {
        clientDataJSON: bytesToB64u(r.clientDataJSON),
        attestationObject: bytesToB64u(r.attestationObject),
        transports: r.getTransports?.() ?? [],
      },
    },
    prfOutput,
  };
}
