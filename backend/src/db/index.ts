import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env.js";
import * as schema from "./schema.js";

/**
 * Drizzle + postgres-js.
 * Sorgular yapısal olarak parametreli — string birleştirerek SQL kurmak
 * mümkün değil. SQL injection bu katmanda bir kere çözülüyor.
 */
const client = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
});

export const db = drizzle(client, { schema });
export { schema };

export async function closeDb(): Promise<void> {
  await client.end({ timeout: 5 });
}
