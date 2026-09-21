/**
 * Agregados con formatted_read_group (Odoo 18+) y read_group como respaldo.
 * Devuelve filas con una clave por cada groupby y cada agregado, tal como se pidieron.
 */
import type { Row } from "../format.js";
import { call } from "./client.js";
import { OdooError } from "./errors.js";

export async function groupBy(
  model: string,
  domain: unknown[],
  groupby: string[],
  aggregates: string[],
  opts: { order?: string; limit?: number } = {},
): Promise<Row[]> {
  let rows: Row[];
  try {
    rows = await call<Row[]>(model, "formatted_read_group", { domain, groupby, aggregates, order: opts.order, limit: opts.limit });
  } catch (e) {
    if (!(e instanceof OdooError) || !/formatted_read_group/i.test(e.message)) throw e;
    const fields = aggregates.filter((a) => a !== "__count");
    rows = await call<Row[]>(model, "read_group", { domain, fields, groupby, orderby: opts.order, limit: opts.limit, lazy: false });
  }
  const cols = [...groupby, ...aggregates];
  return rows.map((r) => {
    const o: Row = {};
    for (const c of cols) {
      o[c] = r[c] ?? r[c.replace(/:.*$/, "")] ?? (c === "__count" ? (r.__count ?? r[`${model.replace(/\./g, "_")}_count`]) : undefined);
    }
    return o;
  });
}

/** Valor de un grupo: many2one [id, nombre] → id; fecha [clave, etiqueta] → clave. */
export function groupKey(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : v;
}

/** Etiqueta legible de un grupo. */
export function groupLabel(v: unknown): string {
  if (Array.isArray(v)) return String(v[1] ?? v[0]);
  if (v === false || v === null || v === undefined) return "(sin valor)";
  return String(v);
}

export function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
