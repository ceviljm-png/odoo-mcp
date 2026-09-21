/**
 * Escrituras en dos pasos: previsualizar → confirmar.
 *
 * El token de confirmación es un HMAC de (herramienta, argumentos, estado "antes"
 * del registro, caducidad). Sin estado en el servidor: vale solo para esa misma
 * operación, con esos mismos valores y sobre el registro tal como estaba al
 * previsualizar, durante 5 minutos. Además se recuerda cada token usado para
 * que no se pueda aplicar dos veces.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env.js";
import { OdooError } from "./odoo/errors.js";

const TTL_S = 300;
const secret = createHmac("sha256", "odoo-mcp-confirm").update(env.CONFIRM_SECRET || env.MCP_BEARER_TOKEN).digest();
const used = new Map<string, number>(); // token → caducidad (s)

/** JSON con claves ordenadas, para que el hash no dependa del orden. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

function sign(tool: string, payload: unknown, exp: number): string {
  return createHmac("sha256", secret).update(`${tool}|${exp}|${stable(payload)}`).digest("base64url").slice(0, 32);
}

export function issueToken(tool: string, payload: unknown): string {
  const exp = Math.floor(Date.now() / 1000) + TTL_S;
  return `${exp}.${sign(tool, payload, exp)}`;
}

/** Lanza OdooError si el token no corresponde a esta operación o ya no vale. */
export function consumeToken(tool: string, payload: unknown, token: string): void {
  const now = Math.floor(Date.now() / 1000);
  for (const [t, e] of used) if (e < now) used.delete(t);

  const [expStr, sig] = token.split(".");
  const exp = Number(expStr);
  if (!sig || !Number.isFinite(exp)) throw new OdooError("confirmation_token con formato no válido. Repite la llamada sin token para obtener una previsualización nueva.");
  if (exp < now) throw new OdooError("El confirmation_token ha caducado (5 minutos). Repite la llamada sin token para previsualizar de nuevo.");
  if (used.has(token)) throw new OdooError("Ese confirmation_token ya se usó. La operación ya está aplicada; no se repite.");
  const expected = Buffer.from(sign(tool, payload, exp));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    throw new OdooError(
      "El confirmation_token no corresponde a esta operación: cambiaron los valores o el registro se modificó desde la previsualización. Repite la llamada sin token para previsualizar de nuevo.",
    );
  }
  used.set(token, exp);
}
