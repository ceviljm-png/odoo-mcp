/**
 * Auditoría de escrituras: una línea JSON por operación en AUDIT_LOG_PATH y,
 * cuando el modelo tiene chatter, una nota interna en el registro de Odoo.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { env } from "./env.js";
import { call } from "./odoo/client.js";

export interface AuditEntry {
  tool: string;
  model: string;
  ids: number[];
  args: unknown;
  before?: unknown;
  result: "ok" | "error";
  detail?: string;
}

let dirReady: Promise<unknown> | undefined;

export async function audit(entry: AuditEntry): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  try {
    dirReady ??= mkdir(dirname(env.AUDIT_LOG_PATH), { recursive: true });
    await dirReady;
    await appendFile(env.AUDIT_LOG_PATH, line, "utf8");
  } catch (e) {
    // La auditoría en fichero no debe tumbar una escritura ya hecha en Odoo; se deja en el log del proceso.
    console.error("[audit] no se pudo escribir", env.AUDIT_LOG_PATH, (e as Error).message, line.trim());
  }
}

/** Deja una nota interna en el chatter. Devuelve false si el modelo no tiene chatter o falla. */
export async function chatterNote(model: string, id: number, text: string): Promise<boolean> {
  try {
    await call(model, "message_post", { body: `Cambio realizado vía Claude MCP: ${text}`, message_type: "comment", subtype_xmlid: "mail.mt_note" }, { ids: [id] });
    return true;
  } catch (e) {
    console.error("[audit] nota de chatter fallida", model, id, (e as Error).message);
    return false;
  }
}
