/**
 * Convierte los errores de Odoo en mensajes que Claude pueda usar para corregir
 * la llamada (modelo mal escrito, campo inexistente, permisos, etc.).
 */
export class OdooError extends Error {
  readonly odooName?: string;
  readonly httpStatus?: number;
  constructor(message: string, odooName?: string, httpStatus?: number) {
    super(message);
    this.name = "OdooError";
    this.odooName = odooName;
    this.httpStatus = httpStatus;
  }
}

interface OdooErrorBody {
  name?: string;
  message?: string;
  arguments?: unknown[];
  debug?: string;
  // Formato JSON-RPC legado
  error?: { message?: string; data?: { name?: string; message?: string; debug?: string } };
}

export function toActionableError(status: number, body: unknown): OdooError {
  const b = (body ?? {}) as OdooErrorBody;
  const name = b.name ?? b.error?.data?.name ?? "";
  const raw = b.message ?? b.error?.data?.message ?? b.error?.message ?? (typeof body === "string" ? body : "");
  const msg = String(raw).split("\n")[0]?.trim() || `Odoo devolvió HTTP ${status}`;

  if (status === 401 || /Unauthorized|Invalid apikey|AccessDenied/i.test(name + msg)) {
    return new OdooError(
      `Odoo rechazó la API key (${msg}). Comprueba ODOO_API_KEY y que la key no haya caducado (máximo 3 meses).`,
      name,
      status,
    );
  }
  if (/AccessError/i.test(name) || /no tiene permiso|not allowed|access/i.test(msg)) {
    return new OdooError(
      `Sin permiso en Odoo: ${msg}. El usuario "Claude MCP" no tiene acceso a esa operación; revisa sus grupos en Ajustes → Usuarios.`,
      name,
      status,
    );
  }
  if (/Invalid field|campo inválido|does not exist on model|no existe en el modelo/i.test(msg)) {
    return new OdooError(`${msg}. Usa odoo_get_fields para ver los campos reales del modelo.`, name, status);
  }
  if (/Object .* doesn't exist|no existe el modelo|KeyError/i.test(msg)) {
    return new OdooError(`${msg}. Usa odoo_whoami para ver los modelos habilitados.`, name, status);
  }
  if (/ValidationError|UserError/i.test(name)) {
    return new OdooError(`Odoo no aceptó la operación: ${msg}`, name, status);
  }
  if (status === 404) {
    return new OdooError(
      `Odoo devolvió 404 para ese endpoint. Si el hosting no expone /json/2, pon ODOO_API_FLAVOR=jsonrpc y ODOO_LOGIN.`,
      name,
      status,
    );
  }
  return new OdooError(`Error de Odoo (${name || status}): ${msg}`, name, status);
}
