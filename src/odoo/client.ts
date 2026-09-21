/**
 * Cliente HTTP hacia Odoo. Dos adaptadores con la misma interfaz:
 *  - json2:   POST /json/2/<modelo>/<método>  (Odoo 19, recomendado)
 *  - jsonrpc: POST /jsonrpc  execute_kw       (legado; desaparece en Odoo 20)
 *
 * Toda llamada pasa antes por la política (policy.ts): si el modelo o el
 * método no están en la lista, no llega a Odoo.
 */
import { env } from "../env.js";
import { assertAllowed } from "../policy.js";
import { OdooError, toActionableError } from "./errors.js";

export type Domain = unknown[];
export type Kw = Record<string, unknown>;

interface CallOptions {
  /** Ids sobre los que se invoca el método (omitir para métodos @api.model). */
  ids?: number[];
  /** Salta la comprobación de política. Solo para uso interno (whoami). */
  internal?: boolean;
}

async function json2<T>(model: string, method: string, kw: Kw, ids?: number[]): Promise<T> {
  const body: Kw = { ...kw, context: { ...env.ODOO_CONTEXT, ...(kw.context as Kw | undefined) } };
  if (ids) body.ids = ids;
  const res = await fetch(`${env.ODOO_URL}/json/2/${model}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `bearer ${env.ODOO_API_KEY}`,
      "Content-Type": "application/json; charset=utf-8",
      "X-Odoo-Database": env.ODOO_DB,
      "User-Agent": "odoo-mcp/0.1 (Restaurante Juan Moreno)",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(env.ODOO_TIMEOUT_MS),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* cuerpo no JSON: se conserva el texto */
  }
  if (!res.ok) throw toActionableError(res.status, parsed);
  return parsed as T;
}

let cachedUid: number | undefined;

async function jsonrpcRaw<T>(service: string, method: string, args: unknown[]): Promise<T> {
  const res = await fetch(`${env.ODOO_URL}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "odoo-mcp/0.1" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "call", params: { service, method, args } }),
    signal: AbortSignal.timeout(env.ODOO_TIMEOUT_MS),
  });
  const parsed = (await res.json()) as { result?: T; error?: unknown };
  if (parsed.error) throw toActionableError(res.status, parsed);
  return parsed.result as T;
}

async function jsonrpcUid(): Promise<number> {
  if (cachedUid) return cachedUid;
  if (!env.ODOO_LOGIN) throw new OdooError("ODOO_API_FLAVOR=jsonrpc necesita ODOO_LOGIN (el login del usuario Claude MCP).");
  const uid = await jsonrpcRaw<number | false>("common", "authenticate", [env.ODOO_DB, env.ODOO_LOGIN, env.ODOO_API_KEY, {}]);
  if (!uid) throw new OdooError("Odoo rechazó el login/API key en /jsonrpc.");
  cachedUid = uid;
  return uid;
}

async function jsonrpc<T>(model: string, method: string, kw: Kw, ids?: number[]): Promise<T> {
  const uid = await jsonrpcUid();
  const args: unknown[] = ids ? [ids] : [];
  const kwargs: Kw = { ...kw, context: { ...env.ODOO_CONTEXT, ...(kw.context as Kw | undefined) } };
  return jsonrpcRaw<T>("object", "execute_kw", [env.ODOO_DB, uid, env.ODOO_API_KEY, model, method, args, kwargs]);
}

/** Llama a un método ORM de Odoo. */
export async function call<T = unknown>(model: string, method: string, kw: Kw = {}, opts: CallOptions = {}): Promise<T> {
  if (!opts.internal) assertAllowed(model, method, kw);
  const impl = env.ODOO_API_FLAVOR === "json2" ? json2 : jsonrpc;
  return impl<T>(model, method, kw, opts.ids);
}

/** Versión del servidor Odoo (no requiere autenticación). */
export async function serverVersion(): Promise<string> {
  try {
    const res = await fetch(`${env.ODOO_URL}/web/version`, { signal: AbortSignal.timeout(5000) });
    const data = (await res.json()) as { version?: string; server_version?: string; result?: { server_version?: string } };
    return data.version ?? data.server_version ?? data.result?.server_version ?? "desconocida";
  } catch {
    return "desconocida";
  }
}

// ---------- Campos reales de cada modelo (caché por proceso) ----------
const fieldCache = new Map<string, Promise<Set<string>>>();

/** Nombres de campo que existen en el modelo (según fields_get). */
export function fieldsOf(model: string): Promise<Set<string>> {
  let p = fieldCache.get(model);
  if (!p) {
    p = call<Record<string, unknown>>(model, "fields_get", { attributes: ["type"] }, { internal: true }).then((d) => new Set(Object.keys(d)));
    p.catch(() => fieldCache.delete(model));
    fieldCache.set(model, p);
  }
  return p;
}

/** Filtra una lista de campos deseados a los que existen de verdad (varían según módulos instalados). */
export async function pickFields(model: string, wanted: string[]): Promise<string[]> {
  const have = await fieldsOf(model);
  return wanted.filter((f) => have.has(f));
}

/** search_read con campos filtrados a los existentes. */
export async function searchRead<T = Record<string, unknown>>(
  model: string,
  domain: unknown[],
  fields: string[],
  opts: { order?: string; limit?: number; offset?: number; context?: Kw } = {},
): Promise<T[]> {
  return call<T[]>(model, "search_read", { domain, fields: await pickFields(model, fields), ...opts });
}
