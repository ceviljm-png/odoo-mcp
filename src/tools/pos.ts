/**
 * Ventas y TPV:
 *  odoo_pos_daily_summary · odoo_pos_top_products · odoo_pos_sessions · odoo_sales_compare
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { env } from "../env.js";
import { euros, markdownTable, ok, type Row } from "../format.js";
import { groupBy, groupKey, groupLabel, num } from "../odoo/aggregate.js";
import { call, searchRead } from "../odoo/client.js";
import { addDays, dateParam, datetimeDomain, monthBounds, resolveRange, todayMadrid, utcToMadrid, weekStart } from "../tz.js";
import { guarded } from "./base.js";

/** Tickets que cuentan como venta (ni borrador ni cancelados). */
const POS_SOLD: unknown[] = [["state", "not in", ["draft", "cancel"]]];
const SALE_CONFIRMED: unknown[] = [["state", "in", ["sale", "done"]]];

const ro = { readOnlyHint: true, openWorldHint: true } as const;

/** Prefija cada condición de un dominio con una ruta (p. ej. "order_id."). */
function prefixDomain(domain: unknown[], prefix: string): unknown[] {
  return domain.map((c) => (Array.isArray(c) ? [`${prefix}${c[0]}`, c[1], c[2]] : c));
}

export function categoryDomain(path: string, categoryId?: number, onlyWines?: boolean, posCategoryId?: number): unknown[] {
  if (posCategoryId) return [[`${path}pos_categ_ids`, "child_of", posCategoryId]];
  if (categoryId) return [[`${path}categ_id`, "child_of", categoryId]];
  if (onlyWines) {
    // En este Odoo los vinos se clasifican por categorías del TPV; la categoría de producto es opcional.
    if (env.WINE_POS_CATEGORY_IDS.length) return [[`${path}pos_categ_ids`, "child_of", env.WINE_POS_CATEGORY_IDS]];
    if (env.WINE_CATEGORY_ID) return [[`${path}categ_id`, "child_of", env.WINE_CATEGORY_ID]];
    return [[`${path}pos_categ_ids.complete_name`, "ilike", "vino"]];
  }
  return [];
}

interface ProductStat {
  product_id: number;
  producto: string;
  categoria: string;
  unidades: number;
  importe: number;
  base: number;
}

/** Ventas del TPV por producto en un rango local, con su categoría. */
async function posProductStats(from: string, to: string, extra: unknown[] = [], categoryKind: "product" | "pos" = "pos"): Promise<ProductStat[]> {
  const domain = [...prefixDomain([...POS_SOLD, ...datetimeDomain("date_order", from, to)], "order_id."), ...extra];
  const rows = await groupBy("pos.order.line", domain, ["product_id"], ["qty:sum", "price_subtotal_incl:sum", "price_subtotal:sum"], { limit: 2000 });
  const ids = rows.map((r) => groupKey(r.product_id)).filter((x): x is number => typeof x === "number");
  const cats = new Map<number, string>();
  if (ids.length) {
    const prods = await call<Row[]>("product.product", "read", { fields: categoryKind === "pos" ? ["pos_categ_ids"] : ["categ_id"] }, { ids });
    if (categoryKind === "pos") {
      const posIds = [...new Set(prods.flatMap((p) => (Array.isArray(p.pos_categ_ids) ? (p.pos_categ_ids as number[]) : [])))];
      const names = new Map<number, string>();
      if (posIds.length) for (const c of await call<Row[]>("pos.category", "read", { fields: ["name"] }, { ids: posIds })) names.set(c.id as number, String(c.name));
      for (const p of prods) {
        const first = Array.isArray(p.pos_categ_ids) ? (p.pos_categ_ids as number[])[0] : undefined;
        cats.set(p.id as number, first ? (names.get(first) ?? "") : "(sin categoría TPV)");
      }
    } else {
      for (const p of prods) cats.set(p.id as number, Array.isArray(p.categ_id) ? String(p.categ_id[1]) : "(sin categoría)");
    }
  }
  return rows.map((r) => {
    const id = groupKey(r.product_id) as number;
    return {
      product_id: id,
      producto: groupLabel(r.product_id),
      categoria: cats.get(id) ?? "",
      unidades: num(r["qty:sum"]),
      importe: num(r["price_subtotal_incl:sum"]),
      base: num(r["price_subtotal:sum"]),
    };
  });
}

interface PeriodTotals {
  total: number;
  pedidos: number;
  medio: number;
}

async function posTotals(from: string, to: string): Promise<PeriodTotals & { porDia: Row[] }> {
  const rows = await groupBy("pos.order", [...POS_SOLD, ...datetimeDomain("date_order", from, to)], ["date_order:day"], ["amount_total:sum", "__count"], {
    order: "date_order:day asc",
    limit: 400,
  });
  const total = rows.reduce((s, r) => s + num(r["amount_total:sum"]), 0);
  const pedidos = rows.reduce((s, r) => s + num(r.__count), 0);
  const porDia = rows.map((r) => ({ dia: groupLabel(r["date_order:day"]), tickets: num(r.__count), total: num(r["amount_total:sum"]) }));
  return { total, pedidos, medio: pedidos ? total / pedidos : 0, porDia };
}

async function saleTotals(from: string, to: string): Promise<PeriodTotals> {
  const rows = await groupBy("sale.order", [...SALE_CONFIRMED, ...datetimeDomain("date_order", from, to)], ["state"], ["amount_total:sum", "__count"]);
  const total = rows.reduce((s, r) => s + num(r["amount_total:sum"]), 0);
  const pedidos = rows.reduce((s, r) => s + num(r.__count), 0);
  return { total, pedidos, medio: pedidos ? total / pedidos : 0 };
}

function pct(a: number, b: number): string {
  if (!b) return a ? "nuevo" : "—";
  const v = ((a - b) / b) * 100;
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)} %`;
}

export function registerPosTools(server: McpServer): void {
  server.registerTool(
    "odoo_pos_daily_summary",
    {
      title: "Resumen de caja del TPV",
      description:
        "Resumen de ventas del TPV para un día o un rango de días (hora de Madrid): total vendido, nº de tickets, ticket medio, desglose por método de pago y por categoría, y desglose por día si el rango tiene varios. Por defecto, hoy.",
      inputSchema: z.object({
        date_from: dateParam.optional().describe("Primer día (YYYY-MM-DD). Por defecto hoy."),
        date_to: dateParam.optional().describe("Último día incluido. Por defecto igual a date_from."),
        category_kind: z.enum(["pos", "product"]).default("pos").describe("Agrupar por categoría del TPV (pos, la de la carta: VINO, CARNES…) o por categoría de producto (product)."),
      }),
      annotations: ro,
    },
    guarded(async ({ date_from, date_to, category_kind }) => {
      const [from, to] = resolveRange(date_from, date_to);
      const [totals, payments, stats] = await Promise.all([
        posTotals(from, to),
        groupBy(
          "pos.payment",
          prefixDomain([...POS_SOLD, ...datetimeDomain("date_order", from, to)], "pos_order_id."),
          ["payment_method_id"],
          ["amount:sum", "__count"],
          { order: "amount:sum desc" },
        ),
        posProductStats(from, to, [], category_kind),
      ]);
      const pay = payments.map((r) => ({ metodo: groupLabel(r.payment_method_id), pagos: num(r.__count), importe: num(r["amount:sum"]) }));
      const byCat = new Map<string, { unidades: number; importe: number }>();
      for (const s of stats) {
        const c = byCat.get(s.categoria) ?? { unidades: 0, importe: 0 };
        c.unidades += s.unidades;
        c.importe += s.importe;
        byCat.set(s.categoria, c);
      }
      const cats = [...byCat.entries()].map(([categoria, v]) => ({ categoria, ...v })).sort((a, b) => b.importe - a.importe);
      const rango = from === to ? from : `${from} → ${to}`;
      const text = [
        `### TPV · ${rango}`,
        `**Total:** ${euros(totals.total)} · **Tickets:** ${totals.pedidos} · **Ticket medio:** ${euros(totals.medio)}`,
        "",
        "**Por método de pago**",
        markdownTable(pay.map((p) => ({ ...p, importe: euros(p.importe) }))),
        "",
        `**Por categoría (${category_kind === "pos" ? "TPV" : "producto"})**`,
        markdownTable(cats.map((c) => ({ ...c, importe: euros(c.importe) }))),
        ...(totals.porDia.length > 1 ? ["", "**Por día**", markdownTable(totals.porDia.map((d) => ({ ...d, total: euros(d.total) })))] : []),
      ].join("\n");
      return ok(text, { from, to, total: totals.total, tickets: totals.pedidos, avg_ticket: totals.medio, by_payment_method: pay, by_category: cats, by_day: totals.porDia });
    }),
  );

  server.registerTool(
    "odoo_pos_top_products",
    {
      title: "Productos más vendidos",
      description:
        "Ranking de productos vendidos en el TPV en un rango de días, por importe o por unidades. Filtrable por categoría de producto o solo vinos. Por defecto, los últimos 7 días.",
      inputSchema: z.object({
        date_from: dateParam.optional().describe("Primer día. Por defecto hace 6 días."),
        date_to: dateParam.optional().describe("Último día incluido. Por defecto hoy."),
        by: z.enum(["amount", "qty"]).default("amount").describe("Ordenar por importe (amount) o unidades (qty)."),
        pos_category_id: z.number().int().optional().describe("Id de categoría del TPV (pos.category, incluye subcategorías): p. ej. 73 COMIDA, 71 CARNES, 66 BEBIDAS."),
        category_id: z.number().int().optional().describe("Id de product.category (poco usado en este Odoo)."),
        only_wines: z.boolean().default(false).describe("Solo vinos (categorías del TPV configuradas como vino)."),
        limit: z.number().int().min(1).max(200).default(20),
      }),
      annotations: ro,
    },
    guarded(async ({ date_from, date_to, by, pos_category_id, category_id, only_wines, limit }) => {
      const to = date_to ?? todayMadrid();
      const from = date_from ?? addDays(to, -6);
      const stats = await posProductStats(from, to, categoryDomain("product_id.", category_id, only_wines, pos_category_id));
      stats.sort((a, b) => (by === "qty" ? b.unidades - a.unidades : b.importe - a.importe));
      const top = stats.slice(0, limit);
      const total = stats.reduce((s, x) => s + x.importe, 0);
      const rows = top.map((s, i) => ({ "#": i + 1, producto: s.producto, categoria: s.categoria, unidades: s.unidades, importe: euros(s.importe), "% ventas": total ? `${((s.importe / total) * 100).toFixed(1)} %` : "" }));
      return ok(`### Más vendidos · ${from} → ${to} · por ${by === "qty" ? "unidades" : "importe"}\nTotal del filtro: ${euros(total)} en ${stats.length} productos.\n\n${markdownTable(rows)}`, {
        from,
        to,
        by,
        total,
        products: top,
      });
    }),
  );

  server.registerTool(
    "odoo_pos_sessions",
    {
      title: "Sesiones de caja",
      description:
        "Sesiones del TPV: apertura, cierre, responsable, saldo inicial y final, diferencia de efectivo y estado. Marca las sesiones que siguen abiertas más de 24 h. Por defecto, las de los últimos 7 días.",
      inputSchema: z.object({
        date_from: dateParam.optional().describe("Sesiones abiertas desde este día. Por defecto hace 6 días."),
        date_to: dateParam.optional().describe("Hasta este día incluido. Por defecto hoy."),
        only_open: z.boolean().default(false).describe("Solo las que no están cerradas (sin filtro de fechas)."),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      annotations: ro,
    },
    guarded(async ({ date_from, date_to, only_open, limit }) => {
      const to = date_to ?? todayMadrid();
      const from = date_from ?? addDays(to, -6);
      const domain = only_open ? [["state", "!=", "closed"]] : datetimeDomain("start_at", from, to);
      const rows = await searchRead<Row>(
        "pos.session",
        domain,
        ["name", "config_id", "user_id", "start_at", "stop_at", "state", "cash_register_balance_start", "cash_register_balance_end_real", "cash_register_difference", "order_count", "total_payments_amount"],
        { order: "start_at desc", limit },
      );
      const now = Date.now();
      const out = rows.map((r) => {
        const started = typeof r.start_at === "string" ? Date.parse(r.start_at.replace(" ", "T") + "Z") : NaN;
        const stale = r.state !== "closed" && Number.isFinite(started) && now - started > 24 * 3600 * 1000;
        return {
          sesion: r.name,
          tpv: Array.isArray(r.config_id) ? r.config_id[1] : "",
          responsable: Array.isArray(r.user_id) ? r.user_id[1] : "",
          apertura: utcToMadrid(r.start_at),
          cierre: utcToMadrid(r.stop_at),
          estado: `${r.state}${stale ? " ⚠ abierta >24 h" : ""}`,
          tickets: r.order_count ?? "",
          cobrado: r.total_payments_amount !== undefined ? euros(r.total_payments_amount) : "",
          "efectivo inicial": euros(r.cash_register_balance_start),
          "efectivo contado": r.state === "closed" ? euros(r.cash_register_balance_end_real) : "",
          diferencia: r.state === "closed" ? euros(r.cash_register_difference) : "(al cerrar)",
        };
      });
      const staleCount = out.filter((o) => String(o.estado).includes("⚠")).length;
      const head = only_open ? "### Sesiones sin cerrar" : `### Sesiones de caja · ${from} → ${to}`;
      return ok(`${head}${staleCount ? `\n**${staleCount} sesión(es) abierta(s) más de 24 h.**` : ""}\n\n${markdownTable(out)}`, { sessions: rows, stale: staleCount });
    }),
  );

  server.registerTool(
    "odoo_sales_compare",
    {
      title: "Comparar periodos",
      description:
        "Compara ventas entre dos periodos con variación en € y %: total, nº de tickets/pedidos y ticket medio. Presets: week (últimos 7 días vs. los 7 anteriores), last_week (semana pasada completa lun–dom vs. la anterior), month (este mes hasta hoy vs. mismos días del mes anterior), year (este mes hasta hoy vs. mismo periodo del año pasado), o custom con fechas.",
      inputSchema: z.object({
        preset: z.enum(["week", "last_week", "month", "year", "custom"]).default("week"),
        a_from: dateParam.optional().describe("custom: inicio del periodo A (el actual)."),
        a_to: dateParam.optional().describe("custom: fin del periodo A (incluido)."),
        b_from: dateParam.optional().describe("custom: inicio del periodo B (el de referencia)."),
        b_to: dateParam.optional().describe("custom: fin del periodo B (incluido)."),
        source: z.enum(["pos", "sales", "all"]).default("pos").describe("pos = TPV, sales = pedidos de venta (incluida la web), all = ambos."),
      }),
      annotations: ro,
    },
    guarded(async ({ preset, a_from, a_to, b_from, b_to, source }) => {
      const today = todayMadrid();
      let A: [string, string];
      let B: [string, string];
      if (preset === "custom") {
        if (!a_from || !a_to || !b_from || !b_to) throw new Error("Con preset=custom hacen falta a_from, a_to, b_from y b_to.");
        A = [a_from, a_to];
        B = [b_from, b_to];
      } else if (preset === "week") {
        A = [addDays(today, -6), today];
        B = [addDays(today, -13), addDays(today, -7)];
      } else if (preset === "last_week") {
        const ws = addDays(weekStart(today), -7);
        A = [ws, addDays(ws, 6)];
        B = [addDays(ws, -7), addDays(ws, -1)];
      } else {
        const [first] = monthBounds(today.slice(0, 7));
        const day = Number(today.slice(8, 10));
        const ref = preset === "month" ? prevMonth(today.slice(0, 7)) : `${Number(today.slice(0, 4)) - 1}${today.slice(4, 7)}`;
        const [, refLast] = monthBounds(ref);
        A = [first, today];
        B = [`${ref}-01`, `${ref}-${String(Math.min(day, Number(refLast.slice(8)))).padStart(2, "0")}`];
      }
      const totals = async ([f, t]: [string, string]): Promise<PeriodTotals> => {
        const parts: PeriodTotals[] = [];
        if (source !== "sales") parts.push(await posTotals(f, t));
        if (source !== "pos") parts.push(await saleTotals(f, t));
        const total = parts.reduce((s, p) => s + p.total, 0);
        const pedidos = parts.reduce((s, p) => s + p.pedidos, 0);
        return { total, pedidos, medio: pedidos ? total / pedidos : 0 };
      };
      const [a, b] = await Promise.all([totals(A), totals(B)]);
      const rows = [
        { metrica: "Total", A: euros(a.total), B: euros(b.total), "dif €": euros(a.total - b.total), "dif %": pct(a.total, b.total) },
        { metrica: "Tickets/pedidos", A: a.pedidos, B: b.pedidos, "dif €": a.pedidos - b.pedidos, "dif %": pct(a.pedidos, b.pedidos) },
        { metrica: "Ticket medio", A: euros(a.medio), B: euros(b.medio), "dif €": euros(a.medio - b.medio), "dif %": pct(a.medio, b.medio) },
      ];
      return ok(`### Comparativa (${source}) · A: ${A[0]} → ${A[1]} · B: ${B[0]} → ${B[1]}\n\n${markdownTable(rows)}`, { source, period_a: { from: A[0], to: A[1], ...a }, period_b: { from: B[0], to: B[1], ...b } });
    }),
  );
}

function prevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y! - 1}-12` : `${y}-${String(m! - 1).padStart(2, "0")}`;
}
