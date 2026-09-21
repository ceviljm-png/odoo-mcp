/**
 * Configuración por variables de entorno. Falla al arrancar si falta algo
 * imprescindible, para no descubrirlo en la primera llamada.
 */
function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Falta la variable de entorno ${name} (mira .env.example)`);
  return v;
}

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

const flavor = optional("ODOO_API_FLAVOR", "json2");
if (flavor !== "json2" && flavor !== "jsonrpc") {
  throw new Error(`ODOO_API_FLAVOR debe ser "json2" o "jsonrpc" (recibido: ${flavor})`);
}

export const env = {
  ODOO_URL: required("ODOO_URL").replace(/\/+$/, ""),
  ODOO_DB: required("ODOO_DB"),
  ODOO_API_KEY: required("ODOO_API_KEY"),
  ODOO_API_FLAVOR: flavor as "json2" | "jsonrpc",
  ODOO_LOGIN: optional("ODOO_LOGIN"),
  MCP_BEARER_TOKEN: required("MCP_BEARER_TOKEN"),
  PORT: Number(optional("PORT", "3000")),
  ALLOWED_HOSTS: optional("ALLOWED_HOSTS", "localhost,127.0.0.1")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean),
  WINE_CATEGORY_ID: optional("WINE_CATEGORY_ID") ? Number(optional("WINE_CATEGORY_ID")) : undefined,
  /** Categorías del TPV (pos.category) que cuentan como vino, separadas por coma. Se incluyen sus subcategorías. */
  WINE_POS_CATEGORY_IDS: optional("WINE_POS_CATEGORY_IDS")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isInteger(x) && x > 0),
  /** Ubicación interna para ajustes de inventario (stock.location). Si falta, la de existencias del primer almacén. */
  STOCK_LOCATION_ID: optional("STOCK_LOCATION_ID") ? Number(optional("STOCK_LOCATION_ID")) : undefined,
  /** Fichero JSONL de auditoría de escrituras (en Easypanel, un volumen en /data). */
  AUDIT_LOG_PATH: optional("AUDIT_LOG_PATH", "./data/audit.jsonl"),
  /** Secreto para firmar los tokens de confirmación. Por defecto se deriva de MCP_BEARER_TOKEN. */
  CONFIRM_SECRET: optional("CONFIRM_SECRET"),
  /** Fecha de caducidad de la API key de Odoo (YYYY-MM-DD) para avisar en odoo_whoami. */
  ODOO_API_KEY_EXPIRES: optional("ODOO_API_KEY_EXPIRES"),
  ODOO_TIMEOUT_MS: Number(optional("ODOO_TIMEOUT_MS", "20000")),
  /** Contexto que se envía en todas las llamadas a Odoo. */
  ODOO_CONTEXT: { lang: "es_ES", tz: "Europe/Madrid" } as Record<string, unknown>,
};

if (env.MCP_BEARER_TOKEN.length < 24) {
  throw new Error("MCP_BEARER_TOKEN es demasiado corto; genera uno con: openssl rand -hex 32");
}
