/**
 * Fechas: el negocio vive en Europe/Madrid y Odoo guarda los datetime en UTC
 * ('YYYY-MM-DD HH:MM:SS'). Aquí se traducen días locales a rangos UTC.
 */
import * as z from "zod/v4";

const TZ = "Europe/Madrid";

export const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD");
export const monthParam = z.string().regex(/^\d{4}-\d{2}$/, "Formato YYYY-MM");

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function localParts(utcMs: number): Record<string, number> {
  return Object.fromEntries(
    partsFmt.formatToParts(new Date(utcMs)).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]),
  );
}

/** Desfase de Madrid respecto a UTC (ms) en un instante dado. */
function offsetMs(utcMs: number): number {
  const p = localParts(utcMs);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - utcMs;
}

function fmtUtc(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

/** Medianoche (u otra hora) local de Madrid → datetime UTC de Odoo. */
export function madridToUtc(date: string, time = "00:00:00"): string {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm, ss] = time.split(":").map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, hh!, mm!, ss!);
  let utc = guess - offsetMs(guess);
  utc = guess - offsetMs(utc); // segunda pasada por si cae en cambio de hora
  return fmtUtc(utc);
}

/** Datetime UTC de Odoo → 'YYYY-MM-DD HH:MM' en hora de Madrid. */
export function utcToMadrid(s: unknown): string {
  if (typeof s !== "string" || !s) return "";
  const ms = Date.parse(s.replace(" ", "T") + "Z");
  if (Number.isNaN(ms)) return s;
  const p = localParts(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month!)}-${pad(p.day!)} ${pad(p.hour!)}:${pad(p.minute!)}`;
}

export function todayMadrid(): string {
  return utcToMadrid(fmtUtc(Date.now())).slice(0, 10);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** Lunes de la semana de una fecha. */
export function weekStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay(); // 0 = domingo
  return addDays(date, -((dow + 6) % 7));
}

/** Primer y último día de un mes 'YYYY-MM'. */
export function monthBounds(month: string): [string, string] {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return [`${month}-01`, `${month}-${String(last).padStart(2, "0")}`];
}

/**
 * Dominio Odoo para un campo datetime entre dos días locales (ambos incluidos).
 * Para campos date (sin hora) usa dateDomain.
 */
export function datetimeDomain(field: string, from: string, to: string): unknown[] {
  return [
    [field, ">=", madridToUtc(from)],
    [field, "<", madridToUtc(addDays(to, 1))],
  ];
}

export function dateDomain(field: string, from?: string, to?: string): unknown[] {
  const d: unknown[] = [];
  if (from) d.push([field, ">=", from]);
  if (to) d.push([field, "<=", to]);
  return d;
}

/** Rango por defecto: si falta 'from' es hoy; si falta 'to' es igual a 'from'. */
export function resolveRange(from?: string, to?: string): [string, string] {
  const f = from ?? todayMadrid();
  return [f, to ?? f];
}
