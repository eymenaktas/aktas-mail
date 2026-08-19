import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { ImapFlow } from "imapflow";
import { env } from "../env.js";

/**
 * Gönderme: yerel Postfix submission (587) üzerinden.
 *
 * Postfix `permit_sasl_authenticated, reject` ile yapılandırılmış —
 * yani kimliği doğrulanmamış hiç kimse relay yapamaz, açık relay değil.
 * Giden posta OpenDKIM tarafından imzalanır.
 *
 * Kimlik doğrulama kullanıcının kendi posta parolasıyla: uygulamanın
 * ayrı bir gönderme yetkisi yok, kullanıcı ne gönderebiliyorsa o.
 */

export interface SendParams {
  from: string;
  password: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  savedToSent: boolean;
}

export async function sendMail(params: SendParams): Promise<SendResult> {
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // 587 = STARTTLS. Postfix'te submission için `encrypt` zorunlu.
    secure: false,
    requireTLS: true,
    auth: { user: params.from, pass: params.password },
    tls: {
      // Yerel bağlantı (127.0.0.1); sertifika adı mail.akts.tr'ye
      // uymayacağı için ad doğrulaması kapalı, şifreleme açık.
      rejectUnauthorized: false,
    },
  });

  /**
   * Mesajı BİR KEZ derleyip aynı baytları hem gönderiyor hem Sent'e
   * yazıyoruz. `sendMail` sonucu ham mesajı vermiyor; iki kez derlemek
   * ise farklı Message-ID ve Date üretir, yani Sent'teki kopya
   * gönderilenle birebir aynı olmazdı.
   */
  const composer = new MailComposer({
    from: params.from,
    to: params.to,
    ...(params.cc?.length ? { cc: params.cc } : {}),
    ...(params.bcc?.length ? { bcc: params.bcc } : {}),
    subject: params.subject,
    text: params.text,
    ...(params.html ? { html: params.html } : {}),
    ...(params.inReplyTo ? { inReplyTo: params.inReplyTo } : {}),
    ...(params.references?.length ? { references: params.references } : {}),
  });

  const raw: Buffer = await new Promise((resolve, reject) => {
    composer.compile().build((err, message) => {
      if (err) reject(err);
      else resolve(message);
    });
  });

  const info = await transport.sendMail({
    envelope: {
      from: params.from,
      to: [...params.to, ...(params.cc ?? []), ...(params.bcc ?? [])],
    },
    raw,
  });

  transport.close();

  // Gönderilen mail IMAP'te Sent klasörüne de yazılmalı — yoksa başka
  // bir istemciden bakıldığında gönderilenler görünmez.
  // Not: Bcc başlığı ham mesajda kalır ama zarf (envelope) ayrı
  // verildiği için alıcılara sızmaz; Sent kopyasında görünmesi doğru.
  const savedToSent = await appendToSent(params.from, params.password, raw);

  return {
    messageId: info.messageId,
    accepted: (info.accepted ?? []).map(String),
    rejected: (info.rejected ?? []).map(String),
    savedToSent,
  };
}

async function appendToSent(user: string, pass: string, raw: Buffer): Promise<boolean> {
  let client: ImapFlow | null = null;
  try {
    client = new ImapFlow({
      host: env.IMAP_HOST,
      port: env.IMAP_PORT,
      secure: env.IMAP_SECURE,
      auth: { user, pass },
      logger: false,
      tls: { rejectUnauthorized: false },
    });
    await client.connect();

    // Sunucunun \Sent özel klasörünü bul; yoksa yaygın adları dene
    const boxes = await client.list();
    const sent =
      boxes.find((b) => b.specialUse === "\\Sent")?.path ??
      boxes.find((b) => /^(sent|gönderilmiş|gonderilmis)/i.test(b.name))?.path;

    if (!sent) return false;

    await client.append(sent, raw, ["\\Seen"]);
    return true;
  } catch {
    // Gönderim başarılı olduysa Sent'e yazamamak isteği düşürmemeli
    return false;
  } finally {
    await client?.logout().catch(() => {});
  }
}
