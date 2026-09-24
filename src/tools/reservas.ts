/**
 * Reservas del restaurante (sistema propio, no Odoo). Solo lectura:
 *  reservas_dia · reservas_disponibilidad · reservas_cliente · reservas_alergias · reservas_estadisticas
 *
 * Llama a la API /api/claude del sistema de reservas con su propio token.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { env } from "../env.js";
import { euros, fail, markdownTable, ok, type Row } from "../format.js";
import { dateParam, todayMadrid } from "../tz.js";

const ro = { readOnlyHint: true, openWorldHint: true } as const;

async function reservas<T>(path: string, query: Record<string, string | number | undefined>): Promise<T> {
  if (!env.RESERVAS_URL || !env.RESERVAS_API_TOKEN) {
    throw new Error("El conector no tiene configurado el sistema de reservas (faltan RESERVAS_URL y RESERVAS_API_TOKEN en Easypanel).");
  }
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
  const res = await fetch(`${env.RESERVAS_URL}/api/claude${path}?${qs}`, {
    headers: { Authorization: `Bearer ${env.RESERVAS_API_TOKEN}` },
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `El sistema de reservas respondió con un error ${res.status}.`);
  return data;
}

/** Como guarded() de base.ts, pero para el sistema de reservas. */
function safe<T extends unknown[]>(fn: (...args: T) => Promise<ReturnType<typeof ok>>) {
  return async (...args: T) => {
    try {
      return await fn(...args);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  };
}

const ORIGEN: Record<string, string> = { telefono: "Teléfono", web: "Web", google: "Google", sin_reserva: "Sin reserva", otro: "Otro" };

const list = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v ?? "");

interface DiaReserva {
  hora: string; cliente: string; telefono: string | null; personas: number; estado: string; origen: string; mesas: string[];
  menu: string | null; alergias: string | null; preferencias: string | null; notas: string | null; etiquetas: string[];
  lista_negra: boolean; problematico: boolean; pendiente_de_aprobar: boolean; pago: string | null;
}
interface Dia {
  fecha: string; reservas: number; comensales: number; canceladas: number; no_presentados: number; en_lista_de_espera: number;
  servicios: Array<{ servicio: string; reservas: number; comensales: number; sin_mesa: number; detalle: DiaReserva[] }>;
}

export function registerReservasTools(server: McpServer): void {
  server.registerTool(
    "reservas_dia",
    {
      title: "Reservas de un día",
      description:
        "Reservas del restaurante para un día (sistema de reservas propio, no Odoo): por servicio (comida/cena), con hora, cliente, personas, estado, mesas, menú, alergias, notas, etiquetas (VIP…), lista negra y pago. Incluye totales de comensales, canceladas, no presentados y personas en lista de espera. Úsala para «¿cuántas reservas hay el sábado?» o «¿quién viene hoy?».",
      inputSchema: z.object({ fecha: dateParam.optional().describe("Por defecto hoy.") }),
      annotations: ro,
    },
    safe(async ({ fecha }) => {
      const d = await reservas<Dia>("/dia", { fecha: fecha ?? todayMadrid() });
      const partes = [
        `**${d.fecha}**: ${d.reservas} reservas, ${d.comensales} comensales · ${d.canceladas} canceladas · ${d.no_presentados} no presentados · ${d.en_lista_de_espera} en lista de espera.`,
      ];
      for (const s of d.servicios) {
        partes.push(`\n### ${s.servicio}: ${s.reservas} reservas, ${s.comensales} comensales${s.sin_mesa ? ` (${s.sin_mesa} sin mesa)` : ""}`);
        partes.push(markdownTable(s.detalle.map((x) => ({
          hora: x.hora,
          cliente: `${x.cliente}${x.lista_negra ? " ⛔" : ""}${x.problematico ? " ⚠" : ""}`,
          pax: x.personas,
          estado: x.estado + (x.pendiente_de_aprobar ? " (por aprobar)" : ""),
          mesas: list(x.mesas),
          menu: x.menu ?? "",
          alergias: x.alergias ?? "",
          notas: [x.notas, x.preferencias].filter(Boolean).join(" · "),
          etiquetas: list(x.etiquetas),
          pago: x.pago ?? "",
        }) as Row)));
      }
      return ok(partes.join("\n"), d as unknown as Record<string, unknown>);
    }),
  );

  server.registerTool(
    "reservas_disponibilidad",
    {
      title: "Huecos libres para reservar",
      description:
        "Franjas de 15 minutos de un día y si cabe un grupo de N personas en cada una (máximo de personas por franja, bloqueos, días cerrados). Úsala para «¿hay sitio el viernes a las 21:00 para 6?».",
      inputSchema: z.object({
        fecha: dateParam.optional().describe("Por defecto hoy."),
        personas: z.number().int().min(1).max(50).default(2),
      }),
      annotations: ro,
    },
    safe(async ({ fecha, personas }) => {
      const d = await reservas<{ fecha: string; personas: number; servicios: Array<{ servicio: string; franjas: Array<{ hora: string; ocupadas: number; maximo: number; libre: boolean; motivo: string | null }> }> }>(
        "/disponibilidad", { fecha: fecha ?? todayMadrid(), personas });
      const partes = [`**${d.fecha}**, grupo de ${d.personas}:`];
      if (!d.servicios.length) partes.push("_El restaurante no abre ese día._");
      for (const s of d.servicios) {
        const libres = s.franjas.filter((f) => f.libre).map((f) => f.hora);
        partes.push(`\n### ${s.servicio}: ${libres.length ? `libre a las ${libres.join(", ")}` : "sin huecos"}`);
        partes.push(markdownTable(s.franjas.map((f) => ({ hora: f.hora, ocupadas: `${f.ocupadas}/${f.maximo}`, libre: f.libre ? "sí" : "no", motivo: f.motivo ?? "" }))));
      }
      return ok(partes.join("\n"), d as unknown as Record<string, unknown>);
    }),
  );

  server.registerTool(
    "reservas_cliente",
    {
      title: "Ficha de un cliente de reservas",
      description:
        "Busca clientes del sistema de reservas por nombre, teléfono o email: alergias, preferencias, notas, etiquetas, lista negra, visitas, no presentados, próximas reservas y gasto (según los tickets del TPV enlazados a sus reservas).",
      inputSchema: z.object({ busqueda: z.string().min(2).describe("Nombre, teléfono o email.") }),
      annotations: ro,
    },
    safe(async ({ busqueda }) => {
      const d = await reservas<{ clientes: Array<Record<string, unknown>> }>("/clientes", { q: busqueda });
      if (!d.clientes.length) return ok(`_No hay ningún cliente que coincida con «${busqueda}»._`, d);
      const texto = d.clientes.map((c) => [
        `### ${c.nombre}${c.lista_negra ? " ⛔ lista negra" : ""}${c.problematico ? " ⚠ problemático" : ""}`,
        `Teléfono: ${c.telefono ?? "—"} · Email: ${c.email ?? "—"}${(c.etiquetas as string[]).length ? ` · Etiquetas: ${list(c.etiquetas)}` : ""}`,
        c.alergias ? `**Alergias:** ${c.alergias}` : "",
        c.preferencias ? `Preferencias: ${c.preferencias}` : "",
        c.notas ? `Notas: ${c.notas}` : "",
        `Visitas: ${c.visitas} · No presentado: ${c.no_presentado} · Canceladas: ${c.cancelaciones} · Última visita: ${c.ultima_visita ?? "—"}`,
        Number(c.visitas_con_ticket) ? `Gasto: ${euros(c.gasto_total_eur)} en ${c.visitas_con_ticket} visitas con ticket · ${euros(c.gasto_medio_comensal_eur)} por persona` : "",
        (c.proximas as unknown[]).length ? `Próximas: ${(c.proximas as Array<{ fecha: string; hora: string; personas: number }>).map((p) => `${p.fecha} ${p.hora} (${p.personas} p.)`).join(", ")}` : "",
      ].filter(Boolean).join("\n")).join("\n\n");
      return ok(texto, d);
    }),
  );

  server.registerTool(
    "reservas_alergias",
    {
      title: "Quién viene con alergias",
      description: "Reservas entre dos fechas de clientes con alergias o intolerancias anotadas, con hora, mesa y notas. Úsala para «¿quién viene hoy con alergias?».",
      inputSchema: z.object({
        desde: dateParam.optional().describe("Por defecto hoy."),
        hasta: dateParam.optional().describe("Por defecto, el mismo día que 'desde'. Máximo dos meses."),
      }),
      annotations: ro,
    },
    safe(async ({ desde, hasta }) => {
      const d = await reservas<{ desde: string; hasta: string; reservas: Array<Record<string, unknown>> }>(
        "/alergias", { desde: desde ?? todayMadrid(), hasta });
      const titulo = d.desde === d.hasta ? d.desde : `${d.desde} a ${d.hasta}`;
      if (!d.reservas.length) return ok(`_Ninguna reserva con alergias anotadas (${titulo})._`, d);
      return ok(`**Alergias, ${titulo}:**\n${markdownTable(d.reservas.map((r) => ({ ...r, mesas: list(r.mesas) })))}`, d);
    }),
  );

  server.registerTool(
    "reservas_estadisticas",
    {
      title: "Estadísticas de reservas",
      description:
        "Resumen de reservas entre dos fechas: comensales, no presentados, canceladas, clientes nuevos, reparto por servicio, día de la semana, franja, origen (web, teléfono, Google…) y menús, y gasto por comensal según los tickets del TPV enlazados. Por defecto, los últimos 30 días.",
      inputSchema: z.object({
        desde: dateParam.optional(),
        hasta: dateParam.optional().describe("Por defecto hoy."),
      }),
      annotations: ro,
    },
    safe(async ({ desde, hasta }) => {
      const d = await reservas<Record<string, any>>("/estadisticas", { desde, hasta });
      const r = d.resumen;
      const g = d.gasto;
      const texto = [
        `**${d.desde} a ${d.hasta}**`,
        `Reservas: ${r.reservas} · Comensales: ${r.comensales} (${r.media_comensales_dia} por día con reservas) · Personas por reserva: ${r.media_grupo}`,
        `No presentados: ${r.no_show} (${r.pct_no_show} %) · Canceladas: ${r.canceladas} · Clientes nuevos: ${d.clientes.nuevos} de ${d.clientes.clientes}`,
        g.reservas_con_ticket
          ? `Gasto (reservas con ticket del TPV, ${g.pct_con_ticket} %): ${euros(g.importe_eur)} · ${euros(g.media_comensal_eur)} por comensal · ${euros(g.media_reserva_eur)} por reserva`
          : "Gasto: todavía no hay tickets del TPV enlazados en estas fechas.",
        `\n**Por servicio**\n${markdownTable(d.por_servicio)}`,
        `\n**Por origen**\n${markdownTable(d.por_origen.map((o: Row) => ({ origen: ORIGEN[String(o.source)] ?? o.source, reservas: o.reservas, comensales: o.comensales })))}`,
        `\n**Por menú**\n${markdownTable(d.por_menu.map((m: Row) => ({ ...m, menu: m.menu ?? "Sin elegir" })))}`,
      ].join("\n");
      return ok(texto, d);
    }),
  );
}
