/**
 * Lista blanca: qué modelos, campos y métodos puede tocar el servidor.
 * Es la segunda capa de seguridad (la primera son los permisos del usuario
 * "Claude MCP" en Odoo). Todo lo que no esté aquí se rechaza antes de llamar.
 */
import { OdooError } from "./odoo/errors.js";

export interface ModelPolicy {
  /** Descripción corta para Claude. */
  label: string;
  /** Campos que se devuelven por defecto en search_read cuando no se piden otros. */
  defaultFields: string[];
  /** Campos que se pueden escribir (create/write). Vacío = solo lectura. */
  writable?: string[];
  /** Métodos de acción permitidos además de create/write (p. ej. action_confirm). */
  actions?: string[];
}

export const READ_METHODS = ["search_read", "read", "search_count", "search", "read_group", "formatted_read_group", "fields_get", "name_search"] as const;

export const POLICY: Record<string, ModelPolicy> = {
  "res.partner": {
    label: "Contactos: clientes y proveedores",
    defaultFields: ["id", "name", "vat", "email", "phone", "mobile", "street", "zip", "city", "is_company", "customer_rank", "supplier_rank"],
    writable: ["name", "vat", "email", "phone", "mobile", "street", "street2", "zip", "city", "country_id", "is_company", "comment", "lang"],
    actions: ["message_post"],
  },
  "product.product": {
    label: "Variantes de producto (stock y precio)",
    defaultFields: ["id", "display_name", "default_code", "barcode", "categ_id", "list_price", "qty_available", "virtual_available", "type", "is_storable", "sale_ok", "active"],
  },
  "product.template": {
    label: "Plantillas de producto (lo que se edita)",
    defaultFields: ["id", "name", "default_code", "categ_id", "list_price", "standard_price", "qty_available", "type", "is_storable", "sale_ok", "is_published", "website_published", "active"],
    // active/available_in_pos: archivar; el resto, solo para crear productos copiando la configuración de uno existente.
    writable: ["name", "list_price", "description_sale", "is_published", "sale_ok", "default_code", "active", "available_in_pos", "pos_categ_ids", "taxes_id", "categ_id", "type", "is_storable"],
    actions: ["message_post"],
  },
  "product.category": {
    label: "Categorías de producto",
    defaultFields: ["id", "name", "complete_name", "parent_id"],
  },
  "stock.quant": {
    label: "Existencias por ubicación",
    defaultFields: ["id", "product_id", "location_id", "quantity", "reserved_quantity", "inventory_quantity", "inventory_date"],
    writable: ["inventory_quantity", "product_id", "location_id"],
    actions: ["action_apply_inventory"],
  },
  "stock.move": {
    label: "Movimientos de stock",
    defaultFields: ["id", "date", "product_id", "product_uom_qty", "quantity", "location_id", "location_dest_id", "state", "reference", "origin"],
  },
  "stock.location": {
    label: "Ubicaciones de stock",
    defaultFields: ["id", "complete_name", "usage", "active"],
  },
  "stock.warehouse": {
    label: "Almacenes",
    defaultFields: ["id", "name", "code", "lot_stock_id"],
  },
  "sale.order": {
    label: "Pedidos de venta (incluye tienda web)",
    defaultFields: ["id", "name", "date_order", "partner_id", "state", "amount_untaxed", "amount_tax", "amount_total", "website_id", "invoice_status", "user_id"],
    writable: ["partner_id", "note", "client_order_ref"],
    actions: ["action_confirm", "message_post"],
  },
  "sale.order.line": {
    label: "Líneas de pedido de venta",
    defaultFields: ["id", "order_id", "product_id", "name", "product_uom_qty", "qty_delivered", "qty_invoiced", "price_unit", "price_subtotal", "price_total"],
  },
  "pos.order": {
    label: "Tickets del TPV",
    defaultFields: ["id", "name", "pos_reference", "date_order", "session_id", "partner_id", "amount_total", "amount_tax", "amount_paid", "state", "account_move"],
    writable: ["partner_id"],
    actions: ["action_pos_order_invoice", "message_post"],
  },
  "pos.order.line": {
    label: "Líneas de ticket del TPV",
    defaultFields: ["id", "order_id", "product_id", "full_product_name", "qty", "price_unit", "price_subtotal", "price_subtotal_incl", "discount"],
  },
  "pos.session": {
    label: "Sesiones de caja del TPV",
    defaultFields: ["id", "name", "config_id", "user_id", "start_at", "stop_at", "state", "cash_register_balance_start", "cash_register_balance_end_real", "cash_register_difference"],
  },
  "pos.payment": {
    label: "Pagos de tickets del TPV",
    defaultFields: ["id", "pos_order_id", "payment_date", "payment_method_id", "amount", "session_id"],
  },
  "pos.category": {
    label: "Categorías del TPV",
    defaultFields: ["id", "name", "parent_id"],
    writable: ["name", "parent_id", "sequence"],
  },
  "pos.payment.method": {
    label: "Métodos de pago del TPV",
    defaultFields: ["id", "name", "is_cash_count"],
  },
  "account.move": {
    label: "Facturas y asientos",
    defaultFields: ["id", "name", "move_type", "invoice_date", "invoice_date_due", "partner_id", "state", "payment_state", "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "invoice_origin", "ref"],
    writable: ["partner_id", "invoice_date", "ref", "narration"],
    actions: ["action_post", "message_post"],
  },
  "account.move.line": {
    label: "Líneas de factura/asiento",
    defaultFields: ["id", "move_id", "date", "name", "product_id", "quantity", "price_unit", "price_subtotal", "price_total", "account_id", "partner_id"],
  },
  "account.payment": {
    label: "Cobros y pagos",
    defaultFields: ["id", "name", "date", "partner_id", "amount", "payment_type", "state", "journal_id"],
  },
  "sale.advance.payment.inv": {
    label: "Asistente para facturar pedidos de venta",
    defaultFields: ["id"],
    writable: ["sale_order_ids", "advance_payment_method"],
    actions: ["create_invoices"],
  },
  "product.pricelist": {
    label: "Tarifas",
    defaultFields: ["id", "name", "currency_id", "active"],
  },
};

/** Campos que nunca se devuelven ni se aceptan, en ningún modelo. */
const DENIED_FIELD_PATTERNS = [/password/i, /api_key/i, /token/i, /^image_/i, /^avatar_/i, /signature/i, /^message_ids$/, /^website_message_ids$/, /^activity_ids$/];

export function isFieldDenied(field: string): boolean {
  return DENIED_FIELD_PATTERNS.some((re) => re.test(field));
}

export function allowedModels(): string[] {
  return Object.keys(POLICY);
}

export function policyFor(model: string): ModelPolicy {
  const p = POLICY[model];
  if (!p) {
    throw new OdooError(`El modelo "${model}" no está habilitado en este conector. Modelos disponibles: ${allowedModels().join(", ")}.`);
  }
  return p;
}

/**
 * Comprueba modelo + método + (para escrituras) campos. Lanza OdooError con
 * un mensaje que explica qué sí está permitido.
 */
export function assertAllowed(model: string, method: string, kw: Record<string, unknown>): void {
  const p = policyFor(model);

  if ((READ_METHODS as readonly string[]).includes(method)) {
    const fields = (kw.fields as string[] | undefined) ?? [];
    const bad = fields.filter(isFieldDenied);
    if (bad.length) throw new OdooError(`Los campos ${bad.join(", ")} no se pueden leer a través de este conector.`);
    return;
  }

  if (method === "unlink") {
    throw new OdooError("Borrar registros (unlink) está deshabilitado en este conector. Archiva o cancela desde Odoo si hace falta.");
  }

  if (method === "create" || method === "write") {
    if (!p.writable?.length) throw new OdooError(`El modelo "${model}" es de solo lectura en este conector.`);
    const vals = (method === "create" ? kw.vals_list ?? kw.vals : kw.vals) as Record<string, unknown> | Record<string, unknown>[] | undefined;
    const records = Array.isArray(vals) ? vals : vals ? [vals] : [];
    for (const rec of records) {
      const bad = Object.keys(rec).filter((f) => !p.writable!.includes(f));
      if (bad.length) {
        throw new OdooError(`En "${model}" no se pueden escribir los campos ${bad.join(", ")}. Permitidos: ${p.writable!.join(", ")}.`);
      }
    }
    return;
  }

  if (p.actions?.includes(method)) return;

  throw new OdooError(
    `El método "${method}" no está permitido en "${model}". Permitidos: lectura (${READ_METHODS.join(", ")})` +
      (p.writable?.length ? `, create, write sobre ${p.writable.join(", ")}` : "") +
      (p.actions?.length ? `, acciones ${p.actions.join(", ")}` : "") +
      ".",
  );
}
