/**
 * Herramientas base: sirven para cualquier pregunta no prevista.
 *  odoo_whoami · odoo_search_read · odoo_get_fields · odoo_read_group · odoo_search_count
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { env } from "../env.js";
import { markdownTable, normalizeRow, ok, fail, type Row } from "../format.js";
import { groupBy } from "../odoo/aggregate.js";
import { call, pickFields, serverVersion } from "../odoo/client.js";
import { OdooError } from "../odoo/errors.js";
import { POLICY, allowedModels, isFieldDenied, policyFor } from "../policy.js";

const modelParam = z.string().describe(`Modelo de Odoo. Uno de: ${allowedModels().join(", ")}`);
const domainParam = z
  .array(z.any())
  .default([])
  .describe('Dominio Odoo, p. ej. [["state","=","sale"],["date_order",">=","2026-09-01"]]. Operadores: = != > >= < <= in not in like ilike child_of. "|" y "&" como prefijos.');

/** Envuelve un handler para convertir OdooError en un resultado de error legible. */
export function guarded<T extends unknown[]>(fn: (...args: T) => Promise<ReturnType<typeof ok> | ReturnType<typeof fail>>) {
  return async (...args: T) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof OdooError) return fail(e.message);
      const msg = e instanceof Error ? e.message : String(e);
      if (/timeout|aborted/i.test(msg)) return fail(`Odoo no respondió en ${env.ODOO_TIMEOUT_MS / 1000} s. Reduce el rango o el límite y vuelve a intentarlo.`);
      return fail(`Error inesperado: ${msg}`);
    }
  };
}

export function registerBaseTools(server: McpServer): void {
  server.registerTool(
    "odoo_whoami",
    {
      title: "Quién soy en Odoo",
      description:
        "Comprueba la conexión con Odoo: usuario técnico, empresa, versión del servidor y lista de modelos habilitados en este conector. Úsala primero si algo falla o para saber qué se puede consultar.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async () => {
      const ctx = await call<{ uid?: number; lang?: string; tz?: string }>("res.users", "context_get", {}, { internal: true });
      const uid = ctx.uid;
      let user: Row = {};
      if (uid) {
        const rows = await call<Row[]>("res.users", "read", { fields: ["name", "login", "company_id"] }, { ids: [uid], internal: true });
        user = rows[0] ?? {};
      }
      const version = await serverVersion();
      let keyWarning = "";
      if (env.ODOO_API_KEY_EXPIRES) {
        const days = Math.ceil((Date.parse(env.ODOO_API_KEY_EXPIRES) - Date.now()) / 86_400_000);
        keyWarning = days < 0 ? `⚠ La API key de Odoo caducó el ${env.ODOO_API_KEY_EXPIRES}.` : days <= 15 ? `⚠ La API key de Odoo caduca en ${days} día(s) (${env.ODOO_API_KEY_EXPIRES}): genera otra.` : `API key válida hasta ${env.ODOO_API_KEY_EXPIRES} (${days} días).`;
      }
      const models = Object.entries(POLICY).map(([m, p]) => `- \`${m}\` — ${p.label}${p.writable?.length ? " (escritura: " + p.writable.join(", ") + ")" : ""}${p.actions?.length ? " (acciones: " + p.actions.join(", ") + ")" : ""}`);
      const text = [
        `**Usuario:** ${user.name ?? "?"} (${user.login ?? "?"}, uid ${uid ?? "?"})`,
        `**Empresa:** ${Array.isArray(user.company_id) ? user.company_id[1] : "?"}`,
        `**Odoo:** ${version} · base de datos \`${env.ODOO_DB}\` · API ${env.ODOO_API_FLAVOR}`,
        `**Contexto:** ${JSON.stringify(env.ODOO_CONTEXT)}`,
        ...(keyWarning ? [keyWarning] : []),
        "",
        "**Modelos habilitados:**",
        ...models,
      ].join("\n");
      return ok(text, { uid, user: normalizeRow(user), version, db: env.ODOO_DB, models: allowedModels(), api_key_expires: env.ODOO_API_KEY_EXPIRES || null });
    }),
  );

  server.registerTool(
    "odoo_search_read",
    {
      title: "Consulta genérica",
      description:
        "Busca registros de un modelo habilitado con un dominio Odoo y devuelve los campos pedidos. Es la herramienta para cualquier pregunta que no cubra una herramienta específica. Si no indicas campos se devuelven los habituales del modelo. Usa odoo_get_fields si dudas del nombre de un campo.",
      inputSchema: z.object({
        model: modelParam,
        domain: domainParam,
        fields: z.array(z.string()).optional().describe("Campos a devolver. Por defecto, los habituales del modelo."),
        order: z.string().optional().describe('Orden, p. ej. "date_order desc" o "name asc".'),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0).describe("Para paginar: registros a saltar."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async ({ model, domain, fields, order, limit, offset }) => {
      const p = policyFor(model);
      const useFields = fields?.length ? fields.filter((f) => !isFieldDenied(f)) : await pickFields(model, p.defaultFields.filter((f) => !isFieldDenied(f)));
      const rows = await call<Row[]>(model, "search_read", { domain, fields: useFields, order, limit, offset });
      const total = await call<number>(model, "search_count", { domain });
      const shown = offset + rows.length;
      const header = `**${model}** · ${total} registro(s) en total · mostrando ${offset + (rows.length ? 1 : 0)}–${shown}${shown < total ? ` (sigue con offset=${shown})` : ""}`;
      return ok(`${header}\n\n${markdownTable(rows, useFields)}`, { model, total, offset, limit, rows: rows.map(normalizeRow) });
    }),
  );

  server.registerTool(
    "odoo_get_fields",
    {
      title: "Campos de un modelo",
      description:
        "Describe los campos de un modelo habilitado (nombre técnico, etiqueta, tipo, relación, valores de selección). Útil para construir dominios correctos antes de usar odoo_search_read o odoo_read_group.",
      inputSchema: z.object({
        model: modelParam,
        search: z.string().optional().describe("Filtra por texto en el nombre técnico o la etiqueta (p. ej. 'fecha', 'partner')."),
        only_stored: z.boolean().default(true).describe("Solo campos almacenados (los que admiten búsqueda y agrupación)."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async ({ model, search, only_stored }) => {
      policyFor(model);
      type FieldDef = { string: string; type: string; relation?: string; selection?: [string, string][]; store?: boolean; readonly?: boolean; required?: boolean; help?: string };
      const defs = await call<Record<string, FieldDef>>(model, "fields_get", {
        attributes: ["string", "type", "relation", "selection", "store", "readonly", "required", "help"],
      });
      const q = search?.toLowerCase();
      const rows = Object.entries(defs)
        .filter(([name]) => !isFieldDenied(name))
        .filter(([, d]) => !only_stored || d.store !== false)
        .filter(([name, d]) => !q || name.toLowerCase().includes(q) || d.string.toLowerCase().includes(q))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, d]) => ({
          campo: name,
          etiqueta: d.string,
          tipo: d.type + (d.relation ? ` → ${d.relation}` : ""),
          requerido: d.required ? "sí" : "",
          seleccion: d.selection ? d.selection.map(([k, v]) => `${k}=${v}`).join(", ") : "",
        }));
      return ok(`**${model}** · ${rows.length} campo(s)\n\n${markdownTable(rows, ["campo", "etiqueta", "tipo", "requerido", "seleccion"])}`, { model, fields: rows });
    }),
  );

  server.registerTool(
    "odoo_search_count",
    {
      title: "Contar registros",
      description: "Cuenta cuántos registros de un modelo cumplen un dominio. Más barato que search_read cuando solo hace falta el número.",
      inputSchema: z.object({ model: modelParam, domain: domainParam }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async ({ model, domain }) => {
      policyFor(model);
      const n = await call<number>(model, "search_count", { domain });
      return ok(`**${model}**: ${n} registro(s) cumplen el dominio.`, { model, count: n });
    }),
  );

  server.registerTool(
    "odoo_read_group",
    {
      title: "Agregados por grupo",
      description:
        'Suma, cuenta o promedia agrupando por uno o varios campos: base de cualquier informe. Ejemplo: modelo pos.order, groupby ["date_order:day"], aggregates ["amount_total:sum","__count"]. Granularidades de fecha: :day :week :month :quarter :year.',
      inputSchema: z.object({
        model: modelParam,
        domain: domainParam,
        groupby: z.array(z.string()).min(1).describe('Campos de agrupación, p. ej. ["partner_id"] o ["date_order:month"].'),
        aggregates: z
          .array(z.string())
          .default(["__count"])
          .describe('Agregados "campo:func" con func = sum, avg, min, max, count, count_distinct; o "__count".'),
        order: z.string().optional().describe('Orden, p. ej. "amount_total:sum desc".'),
        limit: z.number().int().min(1).max(500).default(200),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async ({ model, domain, groupby, aggregates, order, limit }) => {
      policyFor(model);
      const clean = await groupBy(model, domain, groupby, aggregates, { order, limit });
      const cols = [...groupby, ...aggregates];
      return ok(`**${model}** agrupado por ${groupby.join(", ")} · ${clean.length} grupo(s)\n\n${markdownTable(clean, cols)}`, {
        model,
        groupby,
        aggregates,
        groups: clean.map(normalizeRow),
      });
    }),
  );
}
