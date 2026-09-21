/**
 * Tienda web y pedidos:
 *  odoo_web_orders · odoo_order_detail        (lectura)
 *  odoo_order_confirm · odoo_order_note        (escritura con confirmación)
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { euros, markdownTable, ok, type Row } from "../format.js";
import { call, searchRead } from "../odoo/client.js";
import { OdooError } from "../odoo/errors.js";
import { addDays, dateParam, datetimeDomain, todayMadrid, utcToMadrid } from "../tz.js";
import { WRITE_NOTE, confirmParam, runWrite } from "../writes.js";
import { guarded } from "./base.js";

const ro = { readOnlyHint: true, openWorldHint: true } as const;
const wr = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const m2oName = (v: unknown) => (Array.isArray(v) ? String(v[1]) : "");

const orderParam = z.union([z.number().int(), z.string()]).describe("Id numérico o número del pedido (p. ej. S00123); para tickets, el número o la referencia del TPV.");

async function findSaleOrder(order: number | string, fields: string[]): Promise<Row | undefined> {
  const domain = typeof order === "number" ? [["id", "=", order]] : ["|", ["name", "=", order], ["client_order_ref", "=", order]];
  return (await searchRead<Row>("sale.order", domain, fields, { limit: 1 }))[0];
}

/** Últimos mensajes del chatter (lectura interna acotada a un registro concreto). */
async function chatter(model: string, id: number, limit = 10): Promise<Row[]> {
  try {
    const msgs = await call<Row[]>(
      "mail.message",
      "search_read",
      { domain: [["model", "=", model], ["res_id", "=", id], ["message_type", "in", ["comment", "notification"]]], fields: ["date", "author_id", "body", "subtype_id"], order: "date desc", limit },
      { internal: true },
    );
    return msgs.map((m) => ({
      fecha: utcToMadrid(m.date),
      autor: m2oName(m.author_id),
      tipo: m2oName(m.subtype_id),
      texto: String(m.body ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim(),
    }));
  } catch {
    return [];
  }
}

export function registerWebTools(server: McpServer): void {
  server.registerTool(
    "odoo_web_orders",
    {
      title: "Pedidos de la tienda web",
      description:
        "Pedidos hechos desde la tienda online (sale.order con sitio web): fecha, cliente, estado, importe, estado de facturación. Filtrable por fechas, estado y producto (p. ej. 'bono' para bonos regalo). Por defecto, últimos 30 días y sin carritos abandonados.",
      inputSchema: z.object({
        date_from: dateParam.optional().describe("Por defecto hace 29 días."),
        date_to: dateParam.optional().describe("Por defecto hoy."),
        state: z.enum(["confirmed", "quotation", "cancel", "all"]).default("confirmed").describe("confirmed = pagados/confirmados; quotation = presupuestos/carritos sin confirmar."),
        product: z.string().optional().describe("Solo pedidos con algún producto cuyo nombre contenga este texto."),
        partner: z.string().optional().describe("Nombre o email del cliente."),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: ro,
    },
    guarded(async ({ date_from, date_to, state, product, partner, limit, offset }) => {
      const to = date_to ?? todayMadrid();
      const from = date_from ?? addDays(to, -29);
      const domain: unknown[] = [["website_id", "!=", false], ...datetimeDomain("date_order", from, to)];
      if (state === "confirmed") domain.push(["state", "in", ["sale", "done"]]);
      if (state === "quotation") domain.push(["state", "in", ["draft", "sent"]]);
      if (state === "cancel") domain.push(["state", "=", "cancel"]);
      if (product) domain.push(["order_line.product_id.name", "ilike", product]);
      if (partner) domain.push("|", ["partner_id.name", "ilike", partner], ["partner_id.email", "ilike", partner]);
      const [rows, total] = await Promise.all([
        searchRead<Row>("sale.order", domain, ["name", "date_order", "partner_id", "state", "amount_total", "invoice_status", "website_id"], { order: "date_order desc", limit, offset }),
        call<number>("sale.order", "search_count", { domain }),
      ]);
      const sum = rows.reduce((s, r) => s + Number(r.amount_total || 0), 0);
      const out = rows.map((r) => ({
        order_id: r.id,
        pedido: r.name,
        fecha: utcToMadrid(r.date_order),
        cliente: m2oName(r.partner_id),
        estado: r.state,
        total: euros(r.amount_total),
        facturacion: r.invoice_status,
      }));
      const shown = offset + rows.length;
      return ok(
        `### Pedidos web · ${from} → ${to}${product ? ` · producto "${product}"` : ""}\n**${total} pedido(s)** · suma de los mostrados ${euros(sum)}${shown < total ? ` · mostrando ${offset + 1}–${shown} (sigue con offset=${shown})` : ""}\n\n${markdownTable(out)}`,
        { total, orders: out },
      );
    }),
  );

  server.registerTool(
    "odoo_order_detail",
    {
      title: "Detalle de un pedido o ticket",
      description: "Todo sobre un pedido de venta (web o no) o un ticket del TPV: cabecera, líneas, importes, pagos, facturas asociadas y últimos mensajes del historial.",
      inputSchema: z.object({
        source: z.enum(["sale", "pos"]).default("sale"),
        order: orderParam,
      }),
      annotations: ro,
    },
    guarded(async ({ source, order }) => {
      if (source === "sale") {
        const o = await findSaleOrder(order, ["name", "date_order", "partner_id", "partner_invoice_id", "partner_shipping_id", "state", "amount_untaxed", "amount_tax", "amount_total", "invoice_status", "invoice_ids", "website_id", "client_order_ref", "note", "user_id"]);
        if (!o) throw new OdooError(`No encuentro el pedido "${order}".`);
        const id = o.id as number;
        const [lines, invoices, msgs] = await Promise.all([
          searchRead<Row>("sale.order.line", [["order_id", "=", id]], ["name", "product_id", "product_uom_qty", "qty_delivered", "qty_invoiced", "price_unit", "discount", "price_total"], { order: "sequence, id" }),
          (o.invoice_ids as number[])?.length
            ? call<Row[]>("account.move", "read", { fields: ["name", "state", "payment_state", "amount_total", "invoice_date"] }, { ids: o.invoice_ids as number[] })
            : Promise.resolve([] as Row[]),
          chatter("sale.order", id),
        ]);
        const text = [
          `### Pedido ${o.name}${o.website_id ? " (tienda web)" : ""}`,
          `**Fecha:** ${utcToMadrid(o.date_order)} · **Estado:** ${o.state} · **Facturación:** ${o.invoice_status}`,
          `**Cliente:** ${m2oName(o.partner_id)} · **Facturar a:** ${m2oName(o.partner_invoice_id)} · **Entregar a:** ${m2oName(o.partner_shipping_id)}`,
          `**Base:** ${euros(o.amount_untaxed)} · **IVA:** ${euros(o.amount_tax)} · **Total:** ${euros(o.amount_total)}`,
          o.client_order_ref ? `**Ref. cliente:** ${o.client_order_ref}` : "",
          "",
          "**Líneas**",
          markdownTable(lines.map((l) => ({ producto: l.name, cant: l.product_uom_qty, entregado: l.qty_delivered, facturado: l.qty_invoiced, precio: euros(l.price_unit), dto: l.discount ? `${l.discount} %` : "", total: euros(l.price_total) }))),
          "",
          "**Facturas**",
          markdownTable(invoices.map((i) => ({ invoice_id: i.id, numero: i.name || "(borrador)", fecha: i.invoice_date || "", estado: i.state, pago: i.payment_state, total: euros(i.amount_total) }))),
          "",
          "**Historial (últimos mensajes)**",
          markdownTable(msgs),
        ].filter((x) => x !== "").join("\n");
        return ok(text, { order: o, lines, invoices, messages: msgs });
      }

      const domain = typeof order === "number" ? [["id", "=", order]] : ["|", ["name", "=", order], ["pos_reference", "ilike", order]];
      const [t] = await searchRead<Row>("pos.order", domain, ["name", "pos_reference", "date_order", "session_id", "partner_id", "user_id", "state", "amount_tax", "amount_total", "amount_paid", "amount_return", "account_move", "table_id", "customer_count"], { limit: 1 });
      if (!t) throw new OdooError(`No encuentro el ticket "${order}".`);
      const id = t.id as number;
      const [lines, pays] = await Promise.all([
        searchRead<Row>("pos.order.line", [["order_id", "=", id]], ["full_product_name", "product_id", "qty", "price_unit", "discount", "price_subtotal_incl"], {}),
        searchRead<Row>("pos.payment", [["pos_order_id", "=", id]], ["payment_method_id", "amount", "payment_date"], {}),
      ]);
      const text = [
        `### Ticket ${t.name} (${t.pos_reference ?? ""})`,
        `**Fecha:** ${utcToMadrid(t.date_order)} · **Sesión:** ${m2oName(t.session_id)} · **Estado:** ${t.state}${t.table_id ? ` · **Mesa:** ${m2oName(t.table_id)}` : ""}${t.customer_count ? ` · **Comensales:** ${t.customer_count}` : ""}`,
        `**Cliente:** ${m2oName(t.partner_id) || "(contado)"} · **Camarero:** ${m2oName(t.user_id)} · **Factura:** ${m2oName(t.account_move) || "no"}`,
        `**Total:** ${euros(t.amount_total)} (IVA ${euros(t.amount_tax)}) · **Pagado:** ${euros(t.amount_paid)}${Number(t.amount_return) ? ` · **Cambio:** ${euros(t.amount_return)}` : ""}`,
        "",
        "**Líneas**",
        markdownTable(lines.map((l) => ({ producto: l.full_product_name || m2oName(l.product_id), cant: l.qty, precio: euros(l.price_unit), dto: l.discount ? `${l.discount} %` : "", total: euros(l.price_subtotal_incl) }))),
        "",
        "**Pagos**",
        markdownTable(pays.map((p) => ({ metodo: m2oName(p.payment_method_id), importe: euros(p.amount), fecha: utcToMadrid(p.payment_date) }))),
      ].join("\n");
      return ok(text, { order: t, lines, payments: pays });
    }),
  );

  // ---------------- Escritura ----------------

  server.registerTool(
    "odoo_order_confirm",
    {
      title: "Confirmar presupuesto",
      description: "Confirma un presupuesto de venta (pasa a pedido de venta; puede reservar stock y generar la entrega)." + WRITE_NOTE,
      inputSchema: z.object({ order: orderParam, confirmation_token: confirmParam }),
      annotations: wr,
    },
    guarded(async ({ order, confirmation_token }) => {
      const o = await findSaleOrder(order, ["name", "state", "partner_id", "amount_total", "order_line", "website_id"]);
      if (!o) throw new OdooError(`No encuentro el pedido "${order}".`);
      if (!["draft", "sent"].includes(String(o.state))) throw new OdooError(`El pedido ${o.name} está en estado "${o.state}"; solo se confirman presupuestos (draft/sent).`);
      const id = o.id as number;
      const lines = await searchRead<Row>("sale.order.line", [["order_id", "=", id]], ["name", "product_uom_qty", "price_total"], {});
      return runWrite(
        {
          tool: "odoo_order_confirm",
          model: "sale.order",
          ids: [id],
          args: { order_id: id },
          before: { state: o.state, amount_total: o.amount_total, lines: o.order_line },
          preview: `Confirmar el presupuesto **${o.name}**${o.website_id ? " (web)" : ""} de **${m2oName(o.partner_id)}** · ${euros(o.amount_total)}\n${lines.map((l) => `- ${l.product_uom_qty} × ${String(l.name).split("\n")[0]} — ${euros(l.price_total)}`).join("\n")}`,
          note: "presupuesto confirmado",
          apply: async () => {
            await call("sale.order", "action_confirm", {}, { ids: [id] });
            return { text: `Pedido ${o.name} confirmado.` };
          },
        },
        confirmation_token,
      );
    }),
  );

  server.registerTool(
    "odoo_order_note",
    {
      title: "Nota interna en un pedido",
      description: "Añade una nota interna al historial (chatter) de un pedido de venta o de un ticket del TPV, para dejar constancia sin tocar datos. No se envía al cliente." + WRITE_NOTE,
      inputSchema: z.object({
        source: z.enum(["sale", "pos"]).default("sale"),
        order: orderParam,
        note: z.string().min(1).max(4000).describe("Texto de la nota."),
        confirmation_token: confirmParam,
      }),
      annotations: wr,
    },
    guarded(async ({ source, order, note, confirmation_token }) => {
      let row: Row | undefined;
      const model = source === "sale" ? "sale.order" : "pos.order";
      if (source === "sale") row = await findSaleOrder(order, ["name", "partner_id"]);
      else {
        const domain = typeof order === "number" ? [["id", "=", order]] : ["|", ["name", "=", order], ["pos_reference", "ilike", order]];
        [row] = await searchRead<Row>("pos.order", domain, ["name", "partner_id"], { limit: 1 });
      }
      if (!row) throw new OdooError(`No encuentro "${order}".`);
      const id = row.id as number;
      return runWrite(
        {
          tool: "odoo_order_note",
          model,
          ids: [id],
          args: { model, id, note },
          before: { name: row.name },
          preview: `Añadir nota interna a **${row.name}**${row.partner_id ? ` (${m2oName(row.partner_id)})` : ""}:\n\n> ${note.replace(/\n/g, "\n> ")}`,
          apply: async () => {
            await call(model, "message_post", { body: `${note}\n\n(vía Claude MCP)`, message_type: "comment", subtype_xmlid: "mail.mt_note" }, { ids: [id] });
            return { text: `Nota añadida a ${row!.name}.` };
          },
        },
        confirmation_token,
      );
    }),
  );
}
