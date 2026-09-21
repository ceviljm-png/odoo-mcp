/**
 * Stock y productos:
 *  odoo_product_search · odoo_stock_low · odoo_stock_moves   (lectura)
 *  odoo_product_update · odoo_stock_adjust                     (escritura con confirmación)
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { env } from "../env.js";
import { euros, markdownTable, ok, type Row } from "../format.js";
import { call, searchRead } from "../odoo/client.js";
import { OdooError } from "../odoo/errors.js";
import { addDays, dateParam, datetimeDomain, todayMadrid, utcToMadrid } from "../tz.js";
import { WRITE_NOTE, confirmParam, runWrite } from "../writes.js";
import { guarded } from "./base.js";
import { categoryDomain } from "./pos.js";

const ro = { readOnlyHint: true, openWorldHint: true } as const;
const wr = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

const m2oName = (v: unknown) => (Array.isArray(v) ? String(v[1]) : "");

/** Nombre de categoría para mostrar: la del TPV (la que se usa aquí) o, si no hay, la de producto. */
async function categoryNamer(rows: Row[]): Promise<(r: Row) => string> {
  const ids = [...new Set(rows.flatMap((r) => (Array.isArray(r.pos_categ_ids) ? (r.pos_categ_ids as number[]) : [])))];
  const names = new Map<number, string>();
  if (ids.length) for (const c of await call<Row[]>("pos.category", "read", { fields: ["name"] }, { ids })) names.set(c.id as number, String(c.name));
  return (r) => {
    const pc = Array.isArray(r.pos_categ_ids) ? (r.pos_categ_ids as number[]).map((i) => names.get(i)).filter(Boolean) : [];
    return pc.length ? pc.join(", ") : m2oName(r.categ_id);
  };
}

/** Resuelve un producto por id de variante o de plantilla y devuelve la plantilla. */
async function templateFor(input: { product_id?: number; template_id?: number }): Promise<Row> {
  let tmplId = input.template_id;
  if (!tmplId && input.product_id) {
    const [p] = await call<Row[]>("product.product", "read", { fields: ["product_tmpl_id"] }, { ids: [input.product_id] });
    if (!p) throw new OdooError(`No existe el producto con id ${input.product_id}.`);
    tmplId = (p.product_tmpl_id as [number, string])[0];
  }
  if (!tmplId) throw new OdooError("Indica product_id (variante) o template_id (plantilla). Búscalo con odoo_product_search.");
  const [t] = await searchRead<Row>("product.template", [["id", "=", tmplId]], ["name", "default_code", "list_price", "description_sale", "is_published", "sale_ok", "categ_id"], {
    limit: 1,
    context: { active_test: false },
  });
  if (!t) throw new OdooError(`No existe la plantilla de producto ${tmplId}.`);
  return t;
}

/** Ubicación interna para ajustes: STOCK_LOCATION_ID o la de existencias del primer almacén. */
async function defaultLocation(): Promise<[number, string]> {
  if (env.STOCK_LOCATION_ID) {
    const [l] = await call<Row[]>("stock.location", "read", { fields: ["complete_name"] }, { ids: [env.STOCK_LOCATION_ID] });
    return [env.STOCK_LOCATION_ID, String(l?.complete_name ?? env.STOCK_LOCATION_ID)];
  }
  const [wh] = await call<Row[]>("stock.warehouse", "search_read", { domain: [], fields: ["lot_stock_id"], order: "sequence, id", limit: 1 });
  if (!wh || !Array.isArray(wh.lot_stock_id)) throw new OdooError("No encuentro almacén; fija STOCK_LOCATION_ID en la configuración del servidor.");
  return [wh.lot_stock_id[0] as number, String(wh.lot_stock_id[1])];
}

export function registerStockTools(server: McpServer): void {
  server.registerTool(
    "odoo_product_search",
    {
      title: "Buscar productos",
      description:
        "Busca productos por nombre, referencia interna o código de barras, y/o por categoría. Devuelve stock disponible, previsto, precio de venta y si está publicado en la web. Incluye el product_id (variante) y template_id (plantilla, lo que se edita).",
      inputSchema: z.object({
        query: z.string().optional().describe("Texto a buscar en nombre, referencia o código de barras."),
        pos_category_id: z.number().int().optional().describe("Id de categoría del TPV (pos.category, incluye subcategorías)."),
        category_id: z.number().int().optional().describe("Id de product.category (poco usado en este Odoo)."),
        only_wines: z.boolean().default(false),
        only_published: z.boolean().default(false).describe("Solo publicados en la tienda web."),
        include_archived: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(30),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: ro,
    },
    guarded(async ({ query, pos_category_id, category_id, only_wines, only_published, include_archived, limit, offset }) => {
      const domain: unknown[] = [...categoryDomain("", category_id, only_wines, pos_category_id)];
      if (query) domain.push("|", "|", ["name", "ilike", query], ["default_code", "ilike", query], ["barcode", "ilike", query]);
      if (only_published) domain.push(["is_published", "=", true]);
      const ctx = include_archived ? { active_test: false } : undefined;
      const rows = await searchRead<Row>(
        "product.product",
        domain,
        ["display_name", "default_code", "product_tmpl_id", "categ_id", "pos_categ_ids", "list_price", "qty_available", "virtual_available", "is_storable", "is_published", "active"],
        { limit, offset, context: ctx },
      );
      const total = await call<number>("product.product", "search_count", { domain, context: ctx });
      const catName = await categoryNamer(rows);
      const out = rows.map((r) => ({
        product_id: r.id,
        template_id: Array.isArray(r.product_tmpl_id) ? r.product_tmpl_id[0] : "",
        producto: r.display_name,
        ref: r.default_code || "",
        categoria: catName(r),
        precio: euros(r.list_price),
        stock: r.is_storable === false ? "no almacenable" : r.qty_available,
        previsto: r.is_storable === false ? "" : r.virtual_available,
        web: r.is_published ? "sí" : "no",
        ...(include_archived ? { activo: r.active ? "sí" : "archivado" } : {}),
      }));
      const shown = offset + rows.length;
      return ok(`**${total} producto(s)**${shown < total ? ` · mostrando ${offset + 1}–${shown} (sigue con offset=${shown})` : ""}\n\n${markdownTable(out)}`, { total, products: out });
    }),
  );

  server.registerTool(
    "odoo_stock_low",
    {
      title: "Productos con poco stock",
      description:
        "Productos almacenables cuyo stock disponible está en o por debajo de un umbral (por defecto 2 unidades). Útil para vinos a punto de agotarse. Ordenados de menos a más stock.",
      inputSchema: z.object({
        threshold: z.number().min(0).default(2).describe("Unidades. Por defecto 2."),
        only_wines: z.boolean().default(false).describe("Solo vinos."),
        pos_category_id: z.number().int().optional().describe("Id de categoría del TPV (pos.category)."),
        category_id: z.number().int().optional().describe("Id de product.category."),
        only_sellable: z.boolean().default(true).describe("Solo productos marcados como vendibles."),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      annotations: ro,
    },
    guarded(async ({ threshold, only_wines, pos_category_id, category_id, only_sellable, limit }) => {
      const domain: unknown[] = [["is_storable", "=", true], ["qty_available", "<=", threshold], ...categoryDomain("", category_id, only_wines, pos_category_id)];
      if (only_sellable) domain.push(["sale_ok", "=", true]);
      const rows = await searchRead<Row>("product.product", domain, ["display_name", "default_code", "categ_id", "pos_categ_ids", "qty_available", "virtual_available", "list_price", "is_published"], {
        limit: 1000,
      });
      // qty_available no está almacenado: Odoo no puede ordenar por él, se ordena aquí.
      rows.sort((x, y) => Number(x.qty_available) - Number(y.qty_available) || String(x.display_name).localeCompare(String(y.display_name)));
      const catName = await categoryNamer(rows.slice(0, limit));
      const out = rows.slice(0, limit).map((r) => ({
        product_id: r.id,
        producto: r.display_name,
        ref: r.default_code || "",
        categoria: catName(r),
        stock: r.qty_available,
        previsto: r.virtual_available,
        precio: euros(r.list_price),
        web: r.is_published ? "sí" : "no",
      }));
      return ok(`### Stock ≤ ${threshold}${only_wines ? " · vinos" : ""} · ${out.length} producto(s)\n\n${markdownTable(out)}`, { threshold, products: out });
    }),
  );

  server.registerTool(
    "odoo_stock_moves",
    {
      title: "Movimientos de un producto",
      description:
        "Movimientos de stock de un producto en un rango de días: entradas (compras, devoluciones), salidas (ventas, TPV, consumos) y ajustes de inventario, con el saldo neto. Responde a '¿dónde se han ido las botellas?'. Por defecto, últimos 30 días y solo movimientos hechos.",
      inputSchema: z.object({
        product_id: z.number().int().describe("Id de product.product (variante). Búscalo con odoo_product_search."),
        date_from: dateParam.optional().describe("Por defecto hace 29 días."),
        date_to: dateParam.optional().describe("Por defecto hoy."),
        include_pending: z.boolean().default(false).describe("Incluir movimientos no terminados (reservados, en espera)."),
        limit: z.number().int().min(1).max(200).default(100),
      }),
      annotations: ro,
    },
    guarded(async ({ product_id, date_from, date_to, include_pending, limit }) => {
      const to = date_to ?? todayMadrid();
      const from = date_from ?? addDays(to, -29);
      const domain: unknown[] = [["product_id", "=", product_id], ...datetimeDomain("date", from, to)];
      if (!include_pending) domain.push(["state", "=", "done"]);
      const moves = await searchRead<Row>("stock.move", domain, ["date", "reference", "origin", "location_id", "location_dest_id", "quantity", "product_uom_qty", "state"], {
        order: "date desc",
        limit,
      });
      const locIds = [...new Set(moves.flatMap((m) => [m.location_id, m.location_dest_id]).filter(Array.isArray).map((l) => (l as [number, string])[0]))];
      const usage = new Map<number, string>();
      if (locIds.length) for (const l of await call<Row[]>("stock.location", "read", { fields: ["usage"] }, { ids: locIds })) usage.set(l.id as number, String(l.usage));
      const kind = (src: string, dst: string) => {
        if (src === "internal" && dst === "internal") return "interno";
        if (dst === "internal") return src === "inventory" ? "ajuste +" : src === "supplier" ? "entrada compra" : src === "customer" ? "devolución" : "entrada";
        if (src === "internal") return dst === "inventory" ? "ajuste −" : dst === "customer" ? "venta" : dst === "production" ? "consumo" : "salida";
        return "otro";
      };
      let net = 0;
      const out = moves.map((m) => {
        const src = usage.get((m.location_id as [number, string])[0]) ?? "";
        const dst = usage.get((m.location_dest_id as [number, string])[0]) ?? "";
        const qty = Number(m.state === "done" ? m.quantity : m.product_uom_qty) || 0;
        const sign = dst === "internal" && src !== "internal" ? 1 : src === "internal" && dst !== "internal" ? -1 : 0;
        if (m.state === "done") net += sign * qty;
        return {
          fecha: utcToMadrid(m.date),
          tipo: kind(src, dst),
          cantidad: sign ? `${sign > 0 ? "+" : "−"}${qty}` : String(qty),
          referencia: m.reference || "",
          origen: m.origin || "",
          desde: m2oName(m.location_id),
          hacia: m2oName(m.location_dest_id),
          estado: m.state,
        };
      });
      const [p] = await call<Row[]>("product.product", "read", { fields: ["display_name", "qty_available"] }, { ids: [product_id] });
      return ok(
        `### ${p?.display_name ?? product_id} · ${from} → ${to}\nStock actual: **${p?.qty_available ?? "?"}** · saldo neto de movimientos hechos en el rango: **${net >= 0 ? "+" : ""}${net}**\n\n${markdownTable(out)}`,
        { product_id, from, to, net, moves: out },
      );
    }),
  );

  // ---------------- Escritura ----------------

  server.registerTool(
    "odoo_product_update",
    {
      title: "Modificar producto",
      description:
        "Cambia precio de venta, nombre, descripción de venta, referencia interna, 'se puede vender' o 'publicado en la web' de un producto (sobre su plantilla)." + WRITE_NOTE,
      inputSchema: z.object({
        product_id: z.number().int().optional().describe("Id de la variante (product.product)."),
        template_id: z.number().int().optional().describe("Id de la plantilla (product.template). Usa uno de los dos."),
        values: z
          .object({
            list_price: z.number().min(0).optional().describe("Precio de venta en € (IVA según la configuración del producto)."),
            name: z.string().min(1).optional(),
            description_sale: z.string().optional(),
            default_code: z.string().optional(),
            sale_ok: z.boolean().optional(),
            is_published: z.boolean().optional().describe("Publicado en la tienda web."),
          })
          .refine((v) => Object.values(v).some((x) => x !== undefined), "Indica al menos un campo a cambiar."),
        confirmation_token: confirmParam,
      }),
      annotations: wr,
    },
    guarded(async ({ product_id, template_id, values, confirmation_token }) => {
      const t = await templateFor({ product_id, template_id });
      const id = t.id as number;
      const vals = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
      const before = Object.fromEntries(Object.keys(vals).map((k) => [k, t[k] ?? null]));
      const fmt = (k: string, v: unknown) => (k === "list_price" ? euros(v) : typeof v === "boolean" ? (v ? "sí" : "no") : v === false || v === null ? "(vacío)" : String(v));
      const changes = Object.keys(vals).map((k) => `- **${k}**: ${fmt(k, before[k])} → ${fmt(k, vals[k])}`);
      return runWrite(
        {
          tool: "odoo_product_update",
          model: "product.template",
          ids: [id],
          args: { template_id: id, values: vals },
          before,
          preview: `Producto **${t.name}** (plantilla #${id}${t.default_code ? `, ref ${t.default_code}` : ""})\n${changes.join("\n")}`,
          note: changes.join("; ").replace(/\*\*/g, "").replace(/- /g, ""),
          apply: async () => {
            await call("product.template", "write", { vals }, { ids: [id] });
            return { text: `Producto "${t.name}" actualizado.` };
          },
        },
        confirmation_token,
      );
    }),
  );

  server.registerTool(
    "odoo_stock_adjust",
    {
      title: "Ajuste de inventario",
      description:
        "Fija la cantidad contada de un producto en una ubicación y aplica el ajuste de inventario (queda registrado como movimiento contra 'Ajuste de inventario'). Por defecto, la ubicación de existencias principal." + WRITE_NOTE,
      inputSchema: z.object({
        product_id: z.number().int().describe("Id de product.product (variante)."),
        counted_quantity: z.number().min(0).describe("Unidades contadas físicamente."),
        location_id: z.number().int().optional().describe("Id de stock.location interna. Por defecto la principal."),
        confirmation_token: confirmParam,
      }),
      annotations: wr,
    },
    guarded(async ({ product_id, counted_quantity, location_id, confirmation_token }) => {
      const [locId, locName] = location_id ? [location_id, `#${location_id}`] : await defaultLocation();
      const [p] = await call<Row[]>("product.product", "read", { fields: ["display_name", "is_storable"] }, { ids: [product_id] });
      if (!p) throw new OdooError(`No existe el producto ${product_id}.`);
      if (p.is_storable === false) throw new OdooError(`"${p.display_name}" no es almacenable; no tiene stock que ajustar.`);
      const quants = await call<Row[]>("stock.quant", "search_read", {
        domain: [["product_id", "=", product_id], ["location_id", "=", locId]],
        fields: ["quantity", "reserved_quantity", "location_id"],
      });
      if (quants.length > 1) {
        throw new OdooError(`"${p.display_name}" tiene ${quants.length} registros de stock en esa ubicación (lotes o paquetes). Ese ajuste hay que hacerlo desde Odoo → Inventario → Ajustes físicos.`);
      }
      const current = quants.reduce((s, q) => s + Number(q.quantity || 0), 0);
      const diff = counted_quantity - current;
      const loc = quants[0] && Array.isArray(quants[0].location_id) ? String(quants[0].location_id[1]) : locName;
      return runWrite(
        {
          tool: "odoo_stock_adjust",
          model: "stock.quant",
          ids: quants.map((q) => q.id as number),
          args: { product_id, counted_quantity, location_id: locId },
          before: { quantity: current, quants: quants.map((q) => q.id) },
          preview: `**${p.display_name}** en ${loc}\n- Stock en sistema: ${current}\n- Contado: ${counted_quantity}\n- Ajuste: **${diff >= 0 ? "+" : ""}${diff}**`,
          apply: async () => {
            const ctx = { inventory_mode: true };
            let ids = quants.map((q) => q.id as number);
            if (ids.length) {
              await call("stock.quant", "write", { vals: { inventory_quantity: counted_quantity }, context: ctx }, { ids });
            } else {
              const created = await call<number[] | number>("stock.quant", "create", {
                vals_list: [{ product_id, location_id: locId, inventory_quantity: counted_quantity }],
                context: ctx,
              });
              ids = Array.isArray(created) ? created : [created];
            }
            await call("stock.quant", "action_apply_inventory", { context: ctx }, { ids });
            await call("product.template", "message_post", {
              body: `Cambio realizado vía Claude MCP: ajuste de inventario de ${p.display_name} en ${loc}: ${current} → ${counted_quantity}`,
              message_type: "comment",
              subtype_xmlid: "mail.mt_note",
            }, { ids: [await templateFor({ product_id }).then((t) => t.id as number)] }).catch(() => undefined);
            return { text: `Inventario de "${p.display_name}" en ${loc}: ${current} → ${counted_quantity} (${diff >= 0 ? "+" : ""}${diff}).`, ids };
          },
        },
        confirmation_token,
      );
    }),
  );
}
