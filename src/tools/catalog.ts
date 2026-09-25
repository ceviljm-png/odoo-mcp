/**
 * Catálogo del TPV (escritura con confirmación):
 *  odoo_product_archive · odoo_pos_category_create · odoo_product_create
 *
 * Nada se borra: "archivar" deja el producto inactivo y fuera del TPV, y se puede
 * recuperar desde Odoo (filtro Archivados) o con odoo_product_archive archive=false.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { euros, markdownTable, type Row } from "../format.js";
import { call, searchRead } from "../odoo/client.js";
import { OdooError } from "../odoo/errors.js";
import { WRITE_NOTE, confirmParam, runWrite } from "../writes.js";
import { guarded } from "./base.js";

const wr = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const m2oName = (v: unknown) => (Array.isArray(v) ? String(v[1]) : "");
/** Id de un many2one, venga como [id, nombre], como id o como false. */
const m2oId = (v: unknown): number | undefined => (Array.isArray(v) ? (v[0] as number) : typeof v === "number" ? v : undefined);

/** Plantillas de producto a partir de ids de variante y/o de plantilla (incluye archivadas). */
async function templatesFor(productIds: number[], templateIds: number[]): Promise<Row[]> {
  const ids = new Set(templateIds);
  if (productIds.length) {
    const ps = await call<Row[]>("product.product", "read", { fields: ["product_tmpl_id"], context: { active_test: false } }, { ids: productIds });
    const found = new Set(ps.map((p) => p.id as number));
    const missing = productIds.filter((i) => !found.has(i));
    if (missing.length) throw new OdooError(`No existen los productos (variante) ${missing.join(", ")}.`);
    for (const p of ps) ids.add((p.product_tmpl_id as [number, string])[0]);
  }
  if (!ids.size) throw new OdooError("Indica product_ids o template_ids.");
  const rows = await searchRead<Row>("product.template", [["id", "in", [...ids]]], ["name", "list_price", "active", "available_in_pos", "pos_categ_ids"], {
    limit: ids.size,
    context: { active_test: false },
  });
  if (rows.length !== ids.size) {
    const got = new Set(rows.map((r) => r.id as number));
    throw new OdooError(`No existen las plantillas ${[...ids].filter((i) => !got.has(i)).join(", ")}.`);
  }
  return rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function registerCatalogTools(server: McpServer): void {
  server.registerTool(
    "odoo_product_archive",
    {
      title: "Archivar productos",
      description:
        "Archiva productos (dejan de verse en el TPV, en ventas y en búsquedas; no se borran y se pueden recuperar) o los desarchiva con archive=false. Hasta 50 a la vez, por id de variante o de plantilla." +
        WRITE_NOTE,
      inputSchema: z.object({
        product_ids: z.array(z.number().int()).max(50).default([]).describe("Ids de variante (product.product)."),
        template_ids: z.array(z.number().int()).max(50).default([]).describe("Ids de plantilla (product.template)."),
        archive: z.boolean().default(true).describe("true = archivar (por defecto); false = recuperar."),
        confirmation_token: confirmParam,
      }),
      annotations: wr,
    },
    guarded(async ({ product_ids, template_ids, archive, confirmation_token }) => {
      const tmpls = await templatesFor(product_ids, template_ids);
      const todo = tmpls.filter((t) => Boolean(t.active) === archive || (!archive && !t.available_in_pos));
      if (!todo.length) throw new OdooError(archive ? "Esos productos ya están archivados." : "Esos productos ya están activos y en el TPV.");
      const ids = todo.map((t) => t.id as number);
      const vals = archive ? { active: false, available_in_pos: false } : { active: true, available_in_pos: true };
      const table = markdownTable(
        todo.map((t) => ({ plantilla: t.id, producto: t.name, precio: euros(t.list_price), ahora: t.active ? "activo" : "archivado", después: archive ? "archivado" : "activo" })),
      );
      return runWrite(
        {
          tool: "odoo_product_archive",
          model: "product.template",
          ids,
          args: { template_ids: ids, archive },
          before: todo.map((t) => ({ id: t.id, active: t.active, available_in_pos: t.available_in_pos })),
          preview: `${archive ? "Archivar" : "Recuperar"} ${todo.length} producto(s)${archive ? " (dejan de verse en el TPV; no se borran)" : ""}:\n\n${table}`,
          note: archive ? "Archivado desde Claude (odoo-mcp)." : "Recuperado desde Claude (odoo-mcp).",
          apply: async () => {
            // Primero sacarlos del TPV y luego archivar: si una sesión de TPV está abierta, lo anterior no bloquea lo siguiente.
            await call("product.template", "write", { vals }, { ids });
            return { text: `${todo.length} producto(s) ${archive ? "archivado(s)" : "recuperado(s)"}.`, ids };
          },
        },
        confirmation_token,
      );
    }),
  );

  server.registerTool(
    "odoo_pos_category_create",
    {
      title: "Crear categoría del TPV",
      description: "Crea una categoría del TPV (pos.category), opcionalmente dentro de otra (parent_id). Si ya existe una con ese nombre y ese padre, avisa y no la duplica." + WRITE_NOTE,
      inputSchema: z.object({
        name: z.string().min(1).max(60),
        parent_id: z.number().int().optional().describe("Categoría del TPV padre (p. ej. 95 = VINO)."),
        confirmation_token: confirmParam,
      }),
      annotations: wr,
    },
    guarded(async ({ name, parent_id, confirmation_token }) => {
      let parentName = "(ninguna)";
      if (parent_id) {
        const [p] = await call<Row[]>("pos.category", "read", { fields: ["name"] }, { ids: [parent_id] });
        if (!p) throw new OdooError(`No existe la categoría del TPV ${parent_id}.`);
        parentName = `${p.name} (#${parent_id})`;
      }
      const dup = await searchRead<Row>("pos.category", [["name", "=ilike", name], ["parent_id", "=", parent_id ?? false]], ["name"], { limit: 1 });
      if (dup.length) throw new OdooError(`Ya existe la categoría "${dup[0]!.name}" (#${dup[0]!.id}) en ${parentName}. Usa ese id.`);
      const vals: Record<string, unknown> = { name, ...(parent_id ? { parent_id } : {}) };
      return runWrite(
        {
          tool: "odoo_pos_category_create",
          model: "pos.category",
          ids: [],
          args: vals,
          before: { exists: false },
          preview: `Crear la categoría del TPV **${name}** dentro de ${parentName}.`,
          apply: async () => {
            const id = await call<number | number[]>("pos.category", "create", { vals_list: [vals] });
            const newId = Array.isArray(id) ? id[0]! : id;
            return { text: `Categoría "${name}" creada con id ${newId}.`, ids: [newId], structured: { pos_category_id: newId } };
          },
        },
        confirmation_token,
      );
    }),
  );

  server.registerTool(
    "odoo_product_create",
    {
      title: "Crear productos",
      description:
        "Crea uno o varios productos (hasta 100) copiando la configuración de un producto existente (impuestos, tipo, categoría interna, vendible y disponible en el TPV) y los coloca en una categoría del TPV. " +
        "Omite los que ya existan con el mismo nombre (también archivados) y lo dice en la previsualización. Devuelve los product_id creados." +
        WRITE_NOTE,
      inputSchema: z.object({
        like_product_id: z.number().int().describe("Producto (variante) del que se copia la configuración, p. ej. otro vino del TPV."),
        pos_category_id: z.number().int().describe("Categoría del TPV donde van los productos nuevos."),
        items: z
          .array(
            z.object({
              name: z.string().min(1).max(120),
              list_price: z.number().min(0).describe("Precio de venta en € (se aplica el mismo IVA que al producto modelo)."),
              default_code: z.string().max(40).optional(),
            }),
          )
          .min(1)
          .max(100),
        confirmation_token: confirmParam,
      }),
      annotations: wr,
    },
    guarded(async ({ like_product_id, pos_category_id, items, confirmation_token }) => {
      const [like] = await call<Row[]>("product.product", "read", { fields: ["product_tmpl_id", "display_name"] }, { ids: [like_product_id] });
      if (!like) throw new OdooError(`No existe el producto modelo ${like_product_id}.`);
      const tmplId = (like.product_tmpl_id as [number, string])[0];
      const [t] = await call<Row[]>("product.template", "read", { fields: ["taxes_id", "categ_id", "type", "is_storable", "sale_ok"] }, { ids: [tmplId] });
      const [cat] = await call<Row[]>("pos.category", "read", { fields: ["name", "parent_id"] }, { ids: [pos_category_id] });
      if (!t || !cat) throw new OdooError(`No existe la categoría del TPV ${pos_category_id}.`);

      const names = [...new Set(items.map((i) => i.name.trim()))];
      if (names.length !== items.length) throw new OdooError("Hay nombres repetidos en la lista.");
      // Ya existentes con el mismo nombre (sin distinguir mayúsculas, también archivados).
      const lower = new Map<string, Row>();
      for (const n of names) {
        const r = await searchRead<Row>("product.template", [["name", "=ilike", n]], ["name", "active"], { limit: 1, context: { active_test: false } });
        if (r[0]) lower.set(n, r[0]);
      }
      const skip = items.filter((i) => lower.has(i.name.trim()));
      const create = items.filter((i) => !lower.has(i.name.trim()));
      if (!create.length) throw new OdooError("Todos esos productos ya existen en Odoo; no hay nada que crear.");

      const base: Record<string, unknown> = {
        taxes_id: [[6, 0, (t.taxes_id as number[]) ?? []]],
        ...(m2oId(t.categ_id) ? { categ_id: m2oId(t.categ_id) } : {}),
        type: t.type,
        is_storable: t.is_storable,
        sale_ok: true,
        available_in_pos: true,
        pos_categ_ids: [[6, 0, [pos_category_id]]],
      };
      const vals_list = create.map((i) => ({ ...base, name: i.name.trim(), list_price: i.list_price, ...(i.default_code ? { default_code: i.default_code } : {}) }));

      const preview =
        `Crear **${create.length}** producto(s) en la categoría del TPV **${cat.name}** (#${pos_category_id}), con la configuración de **${like.display_name}** ` +
        `(impuestos y tipo${m2oName(t.categ_id) ? `, categoría interna ${m2oName(t.categ_id)}` : ""}):\n\n` +
        markdownTable(create.map((i) => ({ producto: i.name, precio: euros(i.list_price) }))) +
        (skip.length ? `\n\n**Se omiten ${skip.length} que ya existen:** ${skip.map((i) => `${i.name} (#${lower.get(i.name.trim())!.id}${lower.get(i.name.trim())!.active ? "" : ", archivado"})`).join(", ")}.` : "");

      return runWrite(
        {
          tool: "odoo_product_create",
          model: "product.template",
          ids: [],
          args: { like_product_id, pos_category_id, items: create },
          before: { skipped: skip.map((i) => i.name) },
          preview,
          note: `Creado desde Claude (odoo-mcp) en la categoría del TPV ${cat.name}.`,
          apply: async () => {
            const res = await call<number | number[]>("product.template", "create", { vals_list });
            const tmplIds = Array.isArray(res) ? res : [res];
            const variants = await searchRead<Row>("product.product", [["product_tmpl_id", "in", tmplIds]], ["name", "product_tmpl_id"], { limit: tmplIds.length });
            const created = variants.map((v) => ({ product_id: v.id as number, template_id: (v.product_tmpl_id as [number, string])[0], name: String(v.name) }));
            return {
              text: `${tmplIds.length} producto(s) creados:\n\n${markdownTable(created)}`,
              ids: tmplIds,
              structured: { created },
            };
          },
        },
        confirmation_token,
      );
    }),
  );
}
