/**
 * Facturación y contactos:
 *  odoo_partner_search · odoo_invoice_search · odoo_sales_ledger_monthly            (lectura)
 *  odoo_partner_upsert · odoo_invoice_create_from_order · odoo_invoice_post           (escritura con confirmación)
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { euros, markdownTable, ok, type Row } from "../format.js";
import { groupBy, groupKey, groupLabel, num } from "../odoo/aggregate.js";
import { call, searchRead } from "../odoo/client.js";
import { OdooError } from "../odoo/errors.js";
import { dateDomain, dateParam, datetimeDomain, monthBounds, monthParam } from "../tz.js";
import { WRITE_NOTE, confirmParam, runWrite } from "../writes.js";
import { guarded } from "./base.js";

const ro = { readOnlyHint: true, openWorldHint: true } as const;
const wr = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const m2oName = (v: unknown) => (Array.isArray(v) ? String(v[1]) : "");
const m2oId = (v: unknown) => (Array.isArray(v) ? (v[0] as number) : undefined);

/** CIF/NIF sin espacios ni guiones, en mayúsculas, sin prefijo de país ES. */
export function vatCore(vat: string): string {
  return vat.toUpperCase().replace(/[\s.\-]/g, "").replace(/^ES/, "");
}

const PAYMENT_STATES = ["not_paid", "in_payment", "paid", "partial", "reversed", "blocked", "invoicing_legacy"] as const;

export function registerInvoicingTools(server: McpServer): void {
  server.registerTool(
    "odoo_partner_search",
    {
      title: "Buscar contactos",
      description: "Busca clientes y proveedores por nombre, CIF/NIF, email o teléfono. Devuelve id, datos fiscales y de contacto.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Nombre, CIF/NIF, email o teléfono (búsqueda parcial)."),
        kind: z.enum(["all", "customers", "suppliers", "companies"]).default("all"),
        limit: z.number().int().min(1).max(200).default(20),
      }),
      annotations: ro,
    },
    guarded(async ({ query, kind, limit }) => {
      const q = query.trim();
      const core = vatCore(q);
      const domain: unknown[] = ["|", "|", "|", "|", ["name", "ilike", q], ["vat", "ilike", core || q], ["email", "ilike", q], ["phone", "ilike", q], ["ref", "ilike", q]];
      if (kind === "customers") domain.push(["customer_rank", ">", 0]);
      if (kind === "suppliers") domain.push(["supplier_rank", ">", 0]);
      if (kind === "companies") domain.push(["is_company", "=", true]);
      const rows = await searchRead<Row>("res.partner", domain, ["name", "vat", "email", "phone", "street", "zip", "city", "country_id", "is_company", "customer_rank", "supplier_rank"], { limit });
      const out = rows.map((r) => ({
        partner_id: r.id,
        nombre: r.name,
        cif: r.vat || "",
        email: r.email || "",
        telefono: r.phone || "",
        direccion: [r.street, r.zip, r.city].filter(Boolean).join(", "),
        tipo: [r.is_company ? "empresa" : "persona", num(r.customer_rank) > 0 ? "cliente" : "", num(r.supplier_rank) > 0 ? "proveedor" : ""].filter(Boolean).join(" · "),
      }));
      return ok(`**${out.length} contacto(s)** para "${q}"\n\n${markdownTable(out)}`, { partners: out });
    }),
  );

  server.registerTool(
    "odoo_invoice_search",
    {
      title: "Buscar facturas",
      description:
        "Facturas de cliente (y opcionalmente rectificativas o de proveedor) filtradas por estado, estado de pago, cliente, fechas e importe. only_pending=true devuelve las validadas pendientes de cobro. Incluye totales.",
      inputSchema: z.object({
        move_type: z.enum(["out_invoice", "out_refund", "in_invoice", "in_refund", "all_customer", "all_supplier"]).default("out_invoice").describe("out_invoice = facturas de cliente; out_refund = rectificativas; in_* = proveedor."),
        state: z.enum(["draft", "posted", "cancel", "any"]).default("any"),
        payment_state: z.enum(PAYMENT_STATES).optional(),
        only_pending: z.boolean().default(false).describe("Solo validadas con importe pendiente de cobro/pago."),
        partner: z.string().optional().describe("Nombre o CIF del cliente (parcial)."),
        partner_id: z.number().int().optional(),
        date_from: dateParam.optional().describe("Fecha de factura desde."),
        date_to: dateParam.optional(),
        min_amount: z.number().optional(),
        max_amount: z.number().optional(),
        name: z.string().optional().describe("Número de factura o referencia (parcial)."),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: ro,
    },
    guarded(async (a) => {
      const types =
        a.move_type === "all_customer" ? ["out_invoice", "out_refund"] : a.move_type === "all_supplier" ? ["in_invoice", "in_refund"] : [a.move_type];
      const domain: unknown[] = [["move_type", "in", types], ...dateDomain("invoice_date", a.date_from, a.date_to)];
      if (a.state !== "any") domain.push(["state", "=", a.state]);
      if (a.payment_state) domain.push(["payment_state", "=", a.payment_state]);
      if (a.only_pending) domain.push(["state", "=", "posted"], ["payment_state", "in", ["not_paid", "partial"]]);
      if (a.partner_id) domain.push(["partner_id", "child_of", a.partner_id]);
      if (a.partner) domain.push("|", ["partner_id.name", "ilike", a.partner], ["partner_id.vat", "ilike", vatCore(a.partner)]);
      if (a.min_amount !== undefined) domain.push(["amount_total", ">=", a.min_amount]);
      if (a.max_amount !== undefined) domain.push(["amount_total", "<=", a.max_amount]);
      if (a.name) domain.push("|", "|", ["name", "ilike", a.name], ["ref", "ilike", a.name], ["invoice_origin", "ilike", a.name]);
      const [rows, total, sums] = await Promise.all([
        searchRead<Row>("account.move", domain, ["name", "move_type", "invoice_date", "invoice_date_due", "partner_id", "state", "payment_state", "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "invoice_origin"], {
          order: "invoice_date desc, id desc",
          limit: a.limit,
          offset: a.offset,
        }),
        call<number>("account.move", "search_count", { domain }),
        groupBy("account.move", domain, ["state"], ["amount_total:sum", "amount_residual:sum"]),
      ]);
      const out = rows.map((r) => ({
        invoice_id: r.id,
        numero: r.name || "(borrador)",
        fecha: r.invoice_date || "",
        vence: r.invoice_date_due || "",
        cliente: m2oName(r.partner_id),
        estado: r.state,
        pago: r.payment_state,
        base: euros(r.amount_untaxed),
        total: euros(r.amount_total),
        pendiente: euros(r.amount_residual),
        origen: r.invoice_origin || "",
      }));
      const tot = sums.reduce((s, g) => s + num(g["amount_total:sum"]), 0);
      const res = sums.reduce((s, g) => s + num(g["amount_residual:sum"]), 0);
      const shown = a.offset + rows.length;
      return ok(
        `**${total} factura(s)** · total ${euros(tot)} · pendiente ${euros(res)}${shown < total ? ` · mostrando ${a.offset + 1}–${shown} (sigue con offset=${shown})` : ""}\n\n${markdownTable(out)}`,
        { total, amount_total: tot, amount_residual: res, invoices: out },
      );
    }),
  );

  server.registerTool(
    "odoo_sales_ledger_monthly",
    {
      title: "Libro de ventas mensual",
      description:
        "Ventas de un mes agregadas por día (TPV + pedidos de venta confirmados), separando las de clientes con CIF de las de 'cliente de contado' (sin cliente o sin CIF), con base, IVA y total, y el detalle de las ventas con CIF. Es el criterio de la exportación mensual a ContaSol: sirve para revisarla antes del envío.",
      inputSchema: z.object({
        month: monthParam.describe("Mes 'YYYY-MM'."),
        include_sales_orders: z.boolean().default(true).describe("Sumar también pedidos de venta (web/presupuestos confirmados) además del TPV."),
      }),
      annotations: ro,
    },
    guarded(async ({ month, include_sales_orders }) => {
      const [from, to] = monthBounds(month);
      const sources: { model: string; domain: unknown[]; label: string }[] = [
        { model: "pos.order", domain: [["state", "not in", ["draft", "cancel"]], ...datetimeDomain("date_order", from, to)], label: "TPV" },
      ];
      if (include_sales_orders) sources.push({ model: "sale.order", domain: [["state", "in", ["sale", "done"]], ...datetimeDomain("date_order", from, to)], label: "Pedidos" });

      const groups = (
        await Promise.all(
          sources.map(async (s) =>
            (await groupBy(s.model, s.domain, ["date_order:day", "partner_id"], ["amount_total:sum", "amount_tax:sum", "__count"], { limit: 5000 })).map((g): Row => ({ ...g, origen: s.label })),
          ),
        )
      ).flat();

      const partnerIds = [...new Set(groups.map((g) => groupKey(g.partner_id)).filter((x): x is number => typeof x === "number"))];
      const vat = new Map<number, string>();
      if (partnerIds.length) for (const p of await call<Row[]>("res.partner", "read", { fields: ["vat", "commercial_partner_id"] }, { ids: partnerIds })) if (p.vat) vat.set(p.id as number, String(p.vat));

      type Day = { dia: string; tickets: number; contado: number; conCif: number; iva: number; total: number };
      const days = new Map<string, Day>();
      const detail: Row[] = [];
      for (const g of groups) {
        const dayLabel = groupLabel(g["date_order:day"]);
        const dayKey = String(groupKey(g["date_order:day"]));
        const d = days.get(dayKey) ?? { dia: dayLabel, tickets: 0, contado: 0, conCif: 0, iva: 0, total: 0 };
        const total = num(g["amount_total:sum"]);
        const pid = groupKey(g.partner_id) as number | undefined;
        const cif = pid ? vat.get(pid) : undefined;
        d.tickets += num(g.__count);
        d.total += total;
        d.iva += num(g["amount_tax:sum"]);
        if (cif) {
          d.conCif += total;
          detail.push({ dia: dayLabel, origen: g.origen, cliente: groupLabel(g.partner_id), cif, operaciones: num(g.__count), base: euros(total - num(g["amount_tax:sum"])), iva: euros(g["amount_tax:sum"]), total: euros(total) });
        } else d.contado += total;
        days.set(dayKey, d);
      }
      const list = [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, d]) => d);
      const sum = (k: keyof Day) => list.reduce((s, d) => s + num(d[k]), 0);
      const table = list.map((d) => ({ dia: d.dia, operaciones: d.tickets, contado: euros(d.contado), "con CIF": euros(d.conCif), base: euros(d.total - d.iva), iva: euros(d.iva), total: euros(d.total) }));
      table.push({ dia: "**TOTAL**", operaciones: sum("tickets"), contado: euros(sum("contado")), "con CIF": euros(sum("conCif")), base: euros(sum("total") - sum("iva")), iva: euros(sum("iva")), total: euros(sum("total")) });
      const text = [
        `### Libro de ventas · ${month} (${sources.map((s) => s.label).join(" + ")})`,
        markdownTable(table),
        "",
        `**Ventas a clientes con CIF (${detail.length})**`,
        markdownTable(detail),
        "",
        "_Contado = tickets sin cliente o con cliente sin CIF. Importes con IVA salvo la columna base._",
      ].join("\n");
      return ok(text, {
        month,
        totals: { operations: sum("tickets"), cash_customers: sum("contado"), vat_customers: sum("conCif"), tax: sum("iva"), total: sum("total") },
        days: list,
        vat_sales: detail,
      });
    }),
  );

  // ---------------- Escritura ----------------

  server.registerTool(
    "odoo_partner_upsert",
    {
      title: "Crear o actualizar contacto",
      description:
        "Crea un cliente/proveedor o actualiza uno existente. Si se da un CIF que ya existe en Odoo, actualiza ese contacto en lugar de duplicarlo; si se da partner_id, actualiza ese." + WRITE_NOTE,
      inputSchema: z.object({
        partner_id: z.number().int().optional().describe("Actualizar este contacto concreto."),
        name: z.string().min(1).optional().describe("Nombre o razón social (obligatorio al crear)."),
        vat: z.string().optional().describe("CIF/NIF, p. ej. B12345678 o ESB12345678."),
        email: z.string().optional(),
        phone: z.string().optional(),
        street: z.string().optional(),
        street2: z.string().optional(),
        zip: z.string().optional(),
        city: z.string().optional(),
        country_id: z.number().int().optional().describe("Id de res.country (España suele ser 68). Omitir si no cambia."),
        is_company: z.boolean().optional(),
        comment: z.string().optional().describe("Notas internas."),
        confirmation_token: confirmParam,
      }),
      annotations: wr,
    },
    guarded(async ({ partner_id, confirmation_token, ...fields }) => {
      const vals: Record<string, unknown> = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (typeof vals.vat === "string") vals.vat = String(vals.vat).toUpperCase().replace(/[\s.\-]/g, "");
      const readFields = ["name", "vat", "email", "phone", "street", "street2", "zip", "city", "country_id", "is_company", "comment"];

      let existing: Row | undefined;
      let matches: Row[] = [];
      if (partner_id) {
        [existing] = await searchRead<Row>("res.partner", [["id", "=", partner_id]], readFields, { limit: 1 });
        if (!existing) throw new OdooError(`No existe el contacto ${partner_id}.`);
      } else if (vals.vat) {
        matches = await searchRead<Row>("res.partner", [["vat", "ilike", vatCore(String(vals.vat))], ["parent_id", "=", false]], readFields, { limit: 5 });
        existing = matches[0];
      }
      if (!existing && !vals.name) throw new OdooError("Para crear un contacto hace falta al menos name.");

      const fmt = (v: unknown) => (v === false || v === null || v === undefined || v === "" ? "(vacío)" : Array.isArray(v) ? String(v[1]) : String(v));
      if (existing) {
        const id = existing.id as number;
        const changed = Object.fromEntries(
          Object.entries(vals).filter(([k, v]) => {
            const cur = existing![k];
            if (k === "vat" && typeof cur === "string" && vatCore(cur) === vatCore(String(v))) return false; // mismo CIF con o sin prefijo ES
            return (Array.isArray(cur) ? cur[0] : cur === false ? "" : cur) !== v;
          }),
        );
        if (!Object.keys(changed).length) return ok(`El contacto **${existing.name}** (#${id}) ya tiene esos datos; no hay nada que cambiar.`, { partner_id: id, unchanged: true });
        const before = Object.fromEntries(Object.keys(changed).map((k) => [k, existing![k] ?? null]));
        const lines = Object.keys(changed).map((k) => `- **${k}**: ${fmt(before[k])} → ${fmt(changed[k])}`);
        const warn = matches.length > 1 ? `\n\n⚠ Hay ${matches.length} contactos con ese CIF (${matches.map((m) => `#${m.id} ${m.name}`).join(", ")}); se actualizaría el primero.` : "";
        return runWrite(
          {
            tool: "odoo_partner_upsert",
            model: "res.partner",
            ids: [id],
            args: { partner_id: id, vals: changed },
            before,
            preview: `Actualizar contacto **${existing.name}** (#${id})${partner_id ? "" : " — encontrado por CIF"}\n${lines.join("\n")}${warn}`,
            note: lines.join("; ").replace(/\*\*|- /g, ""),
            apply: async () => {
              await call("res.partner", "write", { vals: changed }, { ids: [id] });
              return { text: `Contacto "${existing!.name}" (#${id}) actualizado.`, structured: { partner_id: id } };
            },
          },
          confirmation_token,
        );
      }

      const lines = Object.entries(vals).map(([k, v]) => `- **${k}**: ${fmt(v)}`);
      return runWrite(
        {
          tool: "odoo_partner_upsert",
          model: "res.partner",
          ids: [],
          args: { create: vals },
          before: { exists: false, vat: vals.vat ?? null },
          preview: `Crear contacto nuevo${vals.vat ? " (no hay ninguno con ese CIF)" : ""}\n${lines.join("\n")}`,
          note: "contacto creado",
          apply: async () => {
            const created = await call<number[] | number>("res.partner", "create", { vals_list: [vals] });
            const ids = Array.isArray(created) ? created : [created];
            return { text: `Contacto "${vals.name}" creado con id ${ids[0]}.`, ids, structured: { partner_id: ids[0] } };
          },
        },
        confirmation_token,
      );
    }),
  );

  server.registerTool(
    "odoo_invoice_create_from_order",
    {
      title: "Facturar un pedido o ticket",
      description:
        "Genera la factura de un pedido de venta (web o presupuesto confirmado) o de un ticket del TPV, opcionalmente a nombre de otro cliente con CIF. " +
        "Pedido de venta → la factura queda en BORRADOR (valídala luego con odoo_invoice_post). " +
        "Ticket del TPV → Odoo la crea y la VALIDA en el acto (no hay borrador)." +
        WRITE_NOTE,
      inputSchema: z.object({
        source: z.enum(["sale", "pos"]).describe("sale = pedido de venta (S0…); pos = ticket del TPV."),
        order: z.union([z.number().int(), z.string()]).describe("Id numérico, número del pedido (p. ej. S00123) o referencia del ticket."),
        partner_id: z.number().int().optional().describe("Cliente al que facturar (con CIF). Por defecto, el del pedido/ticket."),
        confirmation_token: confirmParam,
      }),
      annotations: wr,
    },
    guarded(async ({ source, order, partner_id, confirmation_token }) => {
      let partner: Row | undefined;
      if (partner_id) {
        [partner] = await searchRead<Row>("res.partner", [["id", "=", partner_id]], ["name", "vat"], { limit: 1 });
        if (!partner) throw new OdooError(`No existe el contacto ${partner_id}.`);
      }

      if (source === "sale") {
        const domain = typeof order === "number" ? [["id", "=", order]] : ["|", ["name", "=", order], ["client_order_ref", "=", order]];
        const [o] = await searchRead<Row>("sale.order", domain, ["name", "state", "partner_id", "partner_invoice_id", "invoice_status", "amount_total", "invoice_ids"], { limit: 1 });
        if (!o) throw new OdooError(`No encuentro el pedido de venta "${order}". Búscalo con odoo_web_orders o odoo_search_read.`);
        if (o.state !== "sale") throw new OdooError(`El pedido ${o.name} está en estado "${o.state}"; hay que confirmarlo antes de facturar (odoo_order_confirm).`);
        if (o.invoice_status !== "to invoice") throw new OdooError(`El pedido ${o.name} no tiene nada pendiente de facturar (estado de facturación: ${o.invoice_status}).`);
        const id = o.id as number;
        const prevInv = (o.invoice_ids as number[]) ?? [];
        const target = partner ?? { id: m2oId(o.partner_invoice_id), name: m2oName(o.partner_invoice_id), vat: undefined };
        return runWrite(
          {
            tool: "odoo_invoice_create_from_order",
            model: "sale.order",
            ids: [id],
            args: { source, order_id: id, partner_id: partner_id ?? null },
            before: { state: o.state, invoice_status: o.invoice_status, invoice_ids: prevInv, amount_total: o.amount_total },
            preview:
              `Crear factura en **borrador** del pedido **${o.name}** · ${euros(o.amount_total)}\n` +
              `- Cliente del pedido: ${m2oName(o.partner_id)}\n- Facturar a: **${target.name}**${partner?.vat ? ` (CIF ${partner.vat})` : partner && !partner.vat ? " ⚠ sin CIF" : ""}\n` +
              `- Se factura lo entregado/pedido según la política del producto. Luego se valida con odoo_invoice_post.`,
            note: `factura en borrador creada${partner ? ` a nombre de ${partner.name}` : ""}`,
            apply: async () => {
              const ctx = { active_model: "sale.order", active_ids: [id], active_id: id };
              const wiz = await call<number[] | number>("sale.advance.payment.inv", "create", {
                vals_list: [{ sale_order_ids: [[6, 0, [id]]], advance_payment_method: "delivered" }],
                context: ctx,
              });
              await call("sale.advance.payment.inv", "create_invoices", { context: ctx }, { ids: Array.isArray(wiz) ? wiz : [wiz] });
              const [after] = await call<Row[]>("sale.order", "read", { fields: ["invoice_ids"] }, { ids: [id] });
              const newIds = ((after?.invoice_ids as number[]) ?? []).filter((x) => !prevInv.includes(x));
              if (!newIds.length) throw new OdooError("Odoo no generó ninguna factura (¿nada entregado aún para productos que se facturan por entrega?).");
              if (partner) await call("account.move", "write", { vals: { partner_id: partner.id } }, { ids: newIds });
              const inv = await call<Row[]>("account.move", "read", { fields: ["name", "state", "amount_total", "partner_id"] }, { ids: newIds });
              return {
                text: `Factura(s) en borrador: ${inv.map((i) => `#${i.id} ${m2oName(i.partner_id)} ${euros(i.amount_total)}`).join(", ")}. Para validarla usa odoo_invoice_post con invoice_id ${newIds[0]}.`,
                structured: { invoice_ids: newIds, order_id: id },
              };
            },
          },
          confirmation_token,
        );
      }

      // ---- Ticket del TPV
      const domain = typeof order === "number" ? [["id", "=", order]] : ["|", "|", ["name", "=", order], ["pos_reference", "=", order], ["pos_reference", "ilike", order]];
      const [t] = await searchRead<Row>("pos.order", domain, ["name", "pos_reference", "state", "partner_id", "amount_total", "account_move", "date_order"], { limit: 1 });
      if (!t) throw new OdooError(`No encuentro el ticket "${order}".`);
      if (t.account_move) throw new OdooError(`El ticket ${t.name} ya está facturado (${m2oName(t.account_move)}).`);
      if (t.state === "cancel" || t.state === "draft") throw new OdooError(`El ticket ${t.name} está en estado "${t.state}"; no se puede facturar.`);
      const target = partner ?? (t.partner_id ? { id: m2oId(t.partner_id), name: m2oName(t.partner_id) } : undefined);
      if (!target) throw new OdooError(`El ticket ${t.name} no tiene cliente: indica partner_id (búscalo con odoo_partner_search o créalo con odoo_partner_upsert).`);
      const id = t.id as number;
      return runWrite(
        {
          tool: "odoo_invoice_create_from_order",
          model: "pos.order",
          ids: [id],
          args: { source, order_id: id, partner_id: partner_id ?? null },
          before: { state: t.state, partner_id: m2oId(t.partner_id) ?? null, account_move: null },
          preview:
            `Facturar el ticket **${t.name}** (${t.pos_reference ?? ""}) · ${euros(t.amount_total)}\n- Facturar a: **${target.name}**${partner?.vat ? ` (CIF ${partner.vat})` : partner && !partner.vat ? " ⚠ sin CIF" : ""}\n` +
            `- ⚠ En el TPV, Odoo crea la factura **ya validada** (con número definitivo). No es un borrador.`,
          note: `factura generada a nombre de ${target.name}`,
          apply: async () => {
            if (partner && partner.id !== m2oId(t.partner_id)) await call("pos.order", "write", { vals: { partner_id: partner.id } }, { ids: [id] });
            await call("pos.order", "action_pos_order_invoice", {}, { ids: [id] });
            const [after] = await call<Row[]>("pos.order", "read", { fields: ["account_move"] }, { ids: [id] });
            const inv = m2oName(after?.account_move);
            return { text: `Ticket ${t.name} facturado: ${inv || "(sin factura asociada; revisa en Odoo)"}.`, structured: { invoice_id: m2oId(after?.account_move), pos_order_id: id } };
          },
        },
        confirmation_token,
      );
    }),
  );

  server.registerTool(
    "odoo_invoice_post",
    {
      title: "Validar factura",
      description:
        "Valida (publica) una factura en borrador: recibe número definitivo y queda contabilizada. En la práctica es irreversible (solo se puede anular con una rectificativa)." + WRITE_NOTE,
      inputSchema: z.object({
        invoice_id: z.number().int().describe("Id de account.move en borrador (lo devuelve odoo_invoice_create_from_order u odoo_invoice_search)."),
        confirmation_token: confirmParam,
      }),
      annotations: { ...wr, destructiveHint: true },
    },
    guarded(async ({ invoice_id, confirmation_token }) => {
      const [m] = await searchRead<Row>("account.move", [["id", "=", invoice_id]], ["name", "state", "move_type", "partner_id", "invoice_date", "amount_untaxed", "amount_tax", "amount_total", "invoice_origin", "invoice_line_ids"], { limit: 1 });
      if (!m) throw new OdooError(`No existe la factura ${invoice_id}.`);
      if (m.state !== "draft") throw new OdooError(`La factura ${m.name} no está en borrador (estado: ${m.state}).`);
      const [p] = m.partner_id ? await call<Row[]>("res.partner", "read", { fields: ["vat"] }, { ids: [m2oId(m.partner_id)!] }) : [];
      return runWrite(
        {
          tool: "odoo_invoice_post",
          model: "account.move",
          ids: [invoice_id],
          args: { invoice_id },
          before: { state: m.state, amount_total: m.amount_total, partner_id: m2oId(m.partner_id) ?? null, lines: m.invoice_line_ids },
          preview:
            `Validar factura borrador #${invoice_id} (${m.move_type}${m.invoice_origin ? `, origen ${m.invoice_origin}` : ""})\n` +
            `- Cliente: **${m2oName(m.partner_id)}**${p?.vat ? ` · CIF ${p.vat}` : " · ⚠ sin CIF"}\n- Fecha: ${m.invoice_date || "hoy (al validar)"}\n` +
            `- Base ${euros(m.amount_untaxed)} + IVA ${euros(m.amount_tax)} = **${euros(m.amount_total)}**\n- ⚠ Irreversible: recibirá número definitivo.`,
          note: "factura validada",
          apply: async () => {
            await call("account.move", "action_post", {}, { ids: [invoice_id] });
            const [after] = await call<Row[]>("account.move", "read", { fields: ["name", "state"] }, { ids: [invoice_id] });
            return { text: `Factura validada con número **${after?.name}**.`, structured: { invoice_id, name: after?.name } };
          },
        },
        confirmation_token,
      );
    }),
  );
}
