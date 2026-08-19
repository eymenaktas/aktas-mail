import { db, schema } from "../db/index.js";

/**
 * Denetim kaydı. İÇERİK YAZILMAZ — sadece kimin, ne zaman, nereden
 * ne yaptığı. "Mail gönderildi" yazılır, mailin kendisi yazılmaz.
 *
 * Yazma hatası isteği düşürmez: denetim kaydı tutulamıyor diye
 * kullanıcının postasına erişimi kesilmemeli.
 */
export async function audit(entry: {
  userId?: number | null;
  action: string;
  detail?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  try {
    await db.insert(schema.auditLog).values({
      userId: entry.userId ?? null,
      action: entry.action,
      detail: entry.detail ?? null,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
    });
  } catch (err) {
    console.error("[audit] yazılamadı:", entry.action, err);
  }
}
