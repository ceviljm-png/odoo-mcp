/**
 * Plantilla de las herramientas de escritura: sin confirmation_token devuelve la
 * previsualización y un token; con token válido aplica, audita y deja nota.
 */
import * as z from "zod/v4";
import { audit, chatterNote } from "./audit.js";
import { consumeToken, issueToken } from "./confirm.js";
import { ok } from "./format.js";

export const confirmParam = z
  .string()
  .optional()
  .describe(
    "Déjalo vacío la primera vez: la herramienta solo previsualiza y devuelve un token. Enseña la previsualización al usuario y, si dice que sí, repite la llamada con los mismos argumentos y este token.",
  );

export const WRITE_NOTE =
  " Escritura en dos pasos: sin confirmation_token solo previsualiza (no cambia nada); con el token que devuelve la previsualización, aplica. Pide siempre confirmación explícita al usuario entre los dos pasos.";

export interface WritePlan {
  tool: string;
  model: string;
  ids: number[];
  /** Lo que se pidió (argumentos sin el token). */
  args: unknown;
  /** Estado actual relevante del registro; entra en la firma del token. */
  before: unknown;
  /** Texto Markdown de la previsualización. */
  preview: string;
  /** Ejecuta el cambio. Devuelve texto y, si se crearon registros, sus ids. */
  apply: () => Promise<{ text: string; ids?: number[]; structured?: Record<string, unknown> }>;
  /** Nota para el chatter (se publica en noteModel/ids tras aplicar). */
  note?: string;
  noteModel?: string;
}

export async function runWrite(plan: WritePlan, token?: string) {
  const payload = { args: plan.args, before: plan.before };
  if (!token) {
    const t = issueToken(plan.tool, payload);
    return ok(
      `**Previsualización — todavía no se ha cambiado nada.**\n\n${plan.preview}\n\n` +
        `Para aplicarlo, repite la llamada con los mismos argumentos y \`confirmation_token: "${t}"\` (válido 5 minutos). ` +
        `Antes, pide al usuario que lo confirme.`,
      { preview: true, confirmation_token: t, before: plan.before as Record<string, unknown> },
    );
  }

  consumeToken(plan.tool, payload, token);
  try {
    const r = await plan.apply();
    const ids = r.ids?.length ? r.ids : plan.ids;
    let noted = false;
    if (plan.note) {
      const model = plan.noteModel ?? plan.model;
      for (const id of ids) noted = (await chatterNote(model, id, plan.note)) || noted;
    }
    await audit({ tool: plan.tool, model: plan.model, ids, args: plan.args, before: plan.before, result: "ok", detail: r.text });
    return ok(`**Aplicado.** ${r.text}${noted ? "\n\nNota añadida al historial del registro." : ""}`, { applied: true, ids, ...r.structured });
  } catch (e) {
    await audit({ tool: plan.tool, model: plan.model, ids: plan.ids, args: plan.args, before: plan.before, result: "error", detail: (e as Error).message });
    throw e;
  }
}
