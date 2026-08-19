import { ImapFlow } from "imapflow";
import { env } from "../env.js";
import { sanitizeEmailHtml, plainTextToHtml } from "./sanitize.js";

/**
 * Uygulama kendi Dovecot'una 127.0.0.1 üzerinden bağlanır.
 * Kimlik bilgileri sunucudan hiç çıkmaz, üçüncü tarafa token verilmez —
 * Gmail/Outlook OAuth'una gerek yok. Eski plandaki en riskli parça
 * kendi posta sunucumuz olduğu için kendiliğinden ortadan kalktı.
 */

export interface MailboxCredentials {
  user: string; // eymen@akts.tr
  pass: string;
}

export interface MessageSummary {
  uid: number;
  seq: number;
  subject: string;
  from: { name: string; address: string } | null;
  date: string | null;
  preview: string;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
}

export interface MessageDetail extends MessageSummary {
  to: Array<{ name: string; address: string }>;
  cc: Array<{ name: string; address: string }>;
  html: string;
  blockedImages: number;
  externalLinks: number;
}

async function connect(creds: MailboxCredentials): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: env.IMAP_HOST,
    port: env.IMAP_PORT,
    secure: env.IMAP_SECURE,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
    // Yerel bağlantı; Dovecot STARTTLS sunuyorsa yükseltilir
    tls: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

/** Kimlik doğrulama testi: bağlanabiliyorsa parola doğru. */
export async function verifyCredentials(creds: MailboxCredentials): Promise<boolean> {
  let client: ImapFlow | null = null;
  try {
    client = await connect(creds);
    return true;
  } catch {
    return false;
  } finally {
    await client?.logout().catch(() => {});
  }
}

export async function listMailboxes(creds: MailboxCredentials) {
  const client = await connect(creds);
  try {
    const list = await client.list();
    return list.map((m) => ({
      path: m.path,
      name: m.name,
      specialUse: m.specialUse ?? null,
      subscribed: m.subscribed,
    }));
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function listMessages(
  creds: MailboxCredentials,
  opts: { mailbox?: string; limit?: number; before?: number } = {},
): Promise<MessageSummary[]> {
  const mailbox = opts.mailbox ?? "INBOX";
  const limit = Math.min(opts.limit ?? 30, 100);

  const client = await connect(creds);
  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const status = client.mailbox;
      if (!status || status.exists === 0) return [];

      // En yeni `limit` mesaj
      const start = Math.max(1, status.exists - limit + 1);
      const range = `${start}:*`;

      const out: MessageSummary[] = [];
      for await (const msg of client.fetch(range, {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true,
        // Önizleme için gövdenin ilk parçası yeterli
        bodyParts: ["1"],
      })) {
        const env_ = msg.envelope;
        const fromEntry = env_?.from?.[0];
        const flags = msg.flags ?? new Set<string>();

        const rawPreview = msg.bodyParts?.get("1")?.toString("utf8") ?? "";

        out.push({
          uid: msg.uid,
          seq: msg.seq,
          subject: env_?.subject ?? "(konu yok)",
          from: fromEntry
            ? { name: fromEntry.name ?? "", address: fromEntry.address ?? "" }
            : null,
          date: env_?.date ? new Date(env_.date).toISOString() : null,
          preview: rawPreview.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200),
          seen: flags.has("\\Seen"),
          flagged: flags.has("\\Flagged"),
          hasAttachments: hasAttachments(msg.bodyStructure),
        });
      }

      return out.reverse(); // en yeni üstte
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function getMessage(
  creds: MailboxCredentials,
  uid: number,
  opts: { mailbox?: string; allowRemoteImages?: boolean } = {},
): Promise<MessageDetail | null> {
  const mailbox = opts.mailbox ?? "INBOX";
  const client = await connect(creds);

  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, envelope: true, flags: true, source: true, bodyStructure: true },
        { uid: true },
      );
      if (!msg || !msg.source) return null;

      const { htmlBody, textBody } = extractBodies(msg.source.toString("utf8"));

      const cleaned = htmlBody
        ? sanitizeEmailHtml(htmlBody, { allowRemoteImages: opts.allowRemoteImages ?? false })
        : { html: plainTextToHtml(textBody), blockedImages: 0, externalLinks: 0 };

      const env_ = msg.envelope;
      const fromEntry = env_?.from?.[0];
      const flags = msg.flags ?? new Set<string>();

      return {
        uid: msg.uid,
        seq: msg.seq,
        subject: env_?.subject ?? "(konu yok)",
        from: fromEntry
          ? { name: fromEntry.name ?? "", address: fromEntry.address ?? "" }
          : null,
        to: (env_?.to ?? []).map((a) => ({ name: a.name ?? "", address: a.address ?? "" })),
        cc: (env_?.cc ?? []).map((a) => ({ name: a.name ?? "", address: a.address ?? "" })),
        date: env_?.date ? new Date(env_.date).toISOString() : null,
        preview: "",
        seen: flags.has("\\Seen"),
        flagged: flags.has("\\Flagged"),
        hasAttachments: hasAttachments(msg.bodyStructure),
        html: cleaned.html,
        blockedImages: cleaned.blockedImages,
        externalLinks: cleaned.externalLinks,
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Sunucu tarafı arama — IMAP SEARCH.
 *
 * İstemci tarafı filtre yalnızca ekrana yüklenmiş mesajlara bakar;
 * bu, kutunun TAMAMINI arar. Sunucu aramayı kendi indeksiyle yaptığı
 * için binlerce mesajı istemciye indirmek gerekmiyor.
 */
export async function searchMessages(
  creds: MailboxCredentials,
  query: string,
  opts: { mailbox?: string; limit?: number } = {},
): Promise<MessageSummary[]> {
  const mailbox = opts.mailbox ?? "INBOX";
  const limit = Math.min(opts.limit ?? 50, 200);
  const terim = query.trim();
  if (!terim) return [];

  const client = await connect(creds);
  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      /**
       * `or` ile konu, gönderen, alıcı ve gövdede arıyoruz.
       * imapflow bunu IMAP SEARCH ifadesine çeviriyor — terim
       * doğrudan protokole gömülmüyor, kaçış kütüphanede.
       */
      const uids = await client.search(
        {
          or: [
            { header: { subject: terim } },
            { header: { from: terim } },
            { header: { to: terim } },
            { body: terim },
          ],
        },
        { uid: true },
      );

      if (!uids || uids.length === 0) return [];

      // En yeni sonuçlar önce; çok fazlaysa kırp
      const seçilen = uids.slice(-limit);

      const out: MessageSummary[] = [];
      for await (const msg of client.fetch(
        seçilen.join(","),
        { uid: true, envelope: true, flags: true, bodyStructure: true, bodyParts: ["1"] },
        { uid: true },
      )) {
        const env_ = msg.envelope;
        const fromEntry = env_?.from?.[0];
        const flags = msg.flags ?? new Set<string>();
        const rawPreview = msg.bodyParts?.get("1")?.toString("utf8") ?? "";

        out.push({
          uid: msg.uid,
          seq: msg.seq,
          subject: env_?.subject ?? "(konu yok)",
          from: fromEntry
            ? { name: fromEntry.name ?? "", address: fromEntry.address ?? "" }
            : null,
          date: env_?.date ? new Date(env_.date).toISOString() : null,
          preview: rawPreview.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200),
          seen: flags.has("\\Seen"),
          flagged: flags.has("\\Flagged"),
          hasAttachments: hasAttachments(msg.bodyStructure),
        });
      }

      return out.reverse();
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function setFlag(
  creds: MailboxCredentials,
  uid: number,
  flag: "\\Seen" | "\\Flagged",
  value: boolean,
  mailbox = "INBOX",
): Promise<void> {
  const client = await connect(creds);
  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      if (value) {
        await client.messageFlagsAdd({ uid: String(uid) }, [flag], { uid: true });
      } else {
        await client.messageFlagsRemove({ uid: String(uid) }, [flag], { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

// ── yardımcılar ─────────────────────────────────────────────

function hasAttachments(structure: unknown): boolean {
  if (!structure || typeof structure !== "object") return false;
  const node = structure as { disposition?: string; childNodes?: unknown[] };
  if (node.disposition?.toLowerCase() === "attachment") return true;
  return (node.childNodes ?? []).some((c) => hasAttachments(c));
}

/**
 * Ham RFC822 kaynağından text/html ve text/plain gövdeleri ayıklar.
 * Basit ama yeterli: MIME sınırlarını takip eder, iç içe multipart'ta
 * ilk uygun parçayı alır.
 */
function extractBodies(raw: string): { htmlBody: string; textBody: string } {
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const headers = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
  const body = headerEnd === -1 ? "" : raw.slice(headerEnd).replace(/^\r?\n\r?\n/, "");

  const boundaryMatch = headers.match(/boundary="?([^";\r\n]+)"?/i);
  if (!boundaryMatch?.[1]) {
    const isHtml = /content-type:\s*text\/html/i.test(headers);
    const decoded = decodePart(headers, body);
    return isHtml ? { htmlBody: decoded, textBody: "" } : { htmlBody: "", textBody: decoded };
  }

  const parts = body.split(new RegExp(`--${escapeRegex(boundaryMatch[1])}(?:--)?\\r?\\n?`));
  let htmlBody = "";
  let textBody = "";

  for (const part of parts) {
    if (!part.trim()) continue;
    const pHeaderEnd = part.search(/\r?\n\r?\n/);
    if (pHeaderEnd === -1) continue;

    const pHeaders = part.slice(0, pHeaderEnd);
    const pBody = part.slice(pHeaderEnd).replace(/^\r?\n\r?\n/, "");

    // İç içe multipart → özyinele
    if (/content-type:\s*multipart\//i.test(pHeaders)) {
      const nested = extractBodies(part);
      htmlBody ||= nested.htmlBody;
      textBody ||= nested.textBody;
      continue;
    }

    if (/content-type:\s*text\/html/i.test(pHeaders)) htmlBody ||= decodePart(pHeaders, pBody);
    else if (/content-type:\s*text\/plain/i.test(pHeaders)) textBody ||= decodePart(pHeaders, pBody);
  }

  return { htmlBody, textBody };
}

function decodePart(headers: string, body: string): string {
  const encoding = headers.match(/content-transfer-encoding:\s*([\w-]+)/i)?.[1]?.toLowerCase();
  if (encoding === "base64") {
    try {
      return Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8");
    } catch {
      return body;
    }
  }
  if (encoding === "quoted-printable") {
    return body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  }
  return body;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
