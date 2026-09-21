/**
 * Respuestas legibles: Markdown compacto para leer + structuredContent para calcular.
 */
export type Row = Record<string, unknown>;

/** Odoo devuelve many2one como [id, "nombre"] y false para vacío. */
export function cell(v: unknown): string {
  if (v === false || v === null || v === undefined) return "";
  if (Array.isArray(v)) {
    if (v.length === 2 && typeof v[0] === "number" && typeof v[1] === "string") return `${v[1]} (#${v[0]})`;
    return v.map(cell).join(", ");
  }
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v).replace(/\s+/g, " ").trim();
  return s.length > 80 ? s.slice(0, 77) + "…" : s;
}

export function markdownTable(rows: Row[], fields?: string[]): string {
  if (!rows.length) return "_Sin resultados._";
  const cols = fields?.length ? fields : Object.keys(rows[0]!);
  const head = `| ${cols.join(" | ")} |\n| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${cols.map((c) => cell(r[c]).replace(/\|/g, "\\|")).join(" | ")} |`).join("\n");
  return `${head}\n${body}`;
}

/** Normaliza many2one [id, name] → {id, name} para el structuredContent. */
export function normalizeRow(r: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) {
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "string") {
      out[k] = { id: v[0], name: v[1] };
    } else {
      out[k] = v === false ? null : v;
    }
  }
  return out;
}

export function euros(n: unknown): string {
  const x = typeof n === "number" ? n : Number(n ?? 0);
  return x.toLocaleString("es-ES", { style: "currency", currency: "EUR" });
}

/** Resultado estándar de una herramienta. */
export function ok(text: string, structured?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

export function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}
