/**
 * Punto de entrada: Express + token bearer + handler MCP (Streamable HTTP, sin sesión).
 *
 *   POST /mcp      ← Claude (Authorization: Bearer MCP_BEARER_TOKEN)
 *   GET  /healthz  ← Easypanel / monitorización
 */
import { createMcpExpressApp, getOAuthProtectedResourceMetadataUrl, requireBearerAuth, type OAuthTokenVerifier } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer, OAuthError, OAuthErrorCode, type AuthInfo, type McpServerFactory } from "@modelcontextprotocol/server";
import type express from "express";
import { timingSafeEqual } from "node:crypto";
import { env } from "./env.js";
import { SCOPE, oauthRouter, verifyAccessToken } from "./oauth.js";
import { registerBaseTools } from "./tools/base.js";
import { registerInvoicingTools } from "./tools/invoicing.js";
import { registerPosTools } from "./tools/pos.js";
import { registerReservasTools } from "./tools/reservas.js";
import { registerStockTools } from "./tools/stock.js";
import { registerWebTools } from "./tools/web.js";

const SERVER_NAME = "odoo-juanmoreno";
const SERVER_VERSION = "1.0.0";

// ---------- Servidor MCP: una instancia nueva por petición ----------
const buildServer: McpServerFactory = () => {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Conector con el Odoo 19 de Restaurante Juan Moreno. Empieza con odoo_whoami si dudas de la conexión o de los modelos disponibles. " +
        "Las fechas de Odoo van en UTC con formato 'YYYY-MM-DD HH:MM:SS'; el negocio está en Europe/Madrid. " +
        "Las cantidades de dinero son euros. Para preguntas de negocio usa primero las herramientas específicas (TPV, stock, facturas, web) y recurre a odoo_search_read/odoo_read_group solo si ninguna encaja. " +
        "Las escrituras van en dos pasos: la primera llamada solo previsualiza y devuelve un confirmation_token; enséñale la previsualización al usuario y repite la llamada con el token SOLO si confirma explícitamente. Nunca se borra nada.",
    },
  );
  registerBaseTools(server);
  registerPosTools(server);
  registerStockTools(server);
  registerInvoicingTools(server);
  registerWebTools(server);
  registerReservasTools(server);
  return server;
};

const handler = createMcpHandler(buildServer, {
  onerror: (err) => console.error("[mcp]", err.message),
});

// ---------- Token fijo (comparación en tiempo constante) ----------
function tokenMatches(token: string): boolean {
  const a = Buffer.from(token);
  const b = Buffer.from(env.MCP_BEARER_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const verifier: OAuthTokenVerifier = {
  async verifyAccessToken(token): Promise<AuthInfo> {
    // 1) Token fijo (Claude Code, scripts). Es estático; el SDK exige expiresAt, así que vale una hora desde ahora.
    if (tokenMatches(token)) return { token, clientId: "static", scopes: [SCOPE], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    // 2) Access token emitido por el login OAuth (conectores de Claude).
    const at = verifyAccessToken(token);
    if (at) return { token, clientId: at.clientId, scopes: [SCOPE], expiresAt: at.exp };
    throw new OAuthError(OAuthErrorCode.InvalidToken, "token no válido o caducado");
  },
};

// ---------- Límite de peticiones muy simple (por proceso) ----------
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 120;
let windowStart = Date.now();
let count = 0;
function rateLimited(): boolean {
  const now = Date.now();
  if (now - windowStart > WINDOW_MS) {
    windowStart = now;
    count = 0;
  }
  return ++count > MAX_PER_WINDOW;
}

// ---------- Express ----------
const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts: env.ALLOWED_HOSTS, jsonLimit: "1mb" });
const auth = requireBearerAuth({
  verifier,
  requiredScopes: [SCOPE],
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(`${env.PUBLIC_URL}/mcp`)),
});
app.set("trust proxy", true);
app.use(oauthRouter(env.PUBLIC_URL));
const node = toNodeHandler(handler);

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION, odoo: env.ODOO_URL, db: env.ODOO_DB });
});

/**
 * Normaliza cómo llega el token: acepta "Bearer <t>", "Bearer Bearer <t>" (cuando el cliente
 * añade el prefijo y el valor ya lo traía), el token pelado, o las cabeceras X-API-Key / Api-Key.
 * Registra el motivo de cada rechazo sin mostrar el token.
 */
const normalizeAuth: express.RequestHandler = (req, _res, next) => {
  const raw = req.headers.authorization ?? req.header("x-api-key") ?? req.header("api-key") ?? "";
  const token = String(raw).trim().replace(/^(bearer\s+)+/i, "").trim();
  if (token) req.headers.authorization = `Bearer ${token}`;
  if (!tokenMatches(token) && !verifyAccessToken(token)) {
    const where = req.headers.authorization ? "Authorization" : req.header("x-api-key") ? "X-API-Key" : req.header("api-key") ? "Api-Key" : "ninguna";
    console.error(
      `[auth] rechazado ${req.method} ${req.path} · cabecera: ${where} · token ${token ? `de ${token.length} caracteres (se esperan ${env.MCP_BEARER_TOKEN.length})` : "vacío"} · cliente: ${req.header("user-agent") ?? "?"}`,
    );
  }
  next();
};

app.all("/mcp", normalizeAuth, auth, (req, res) => {
  if (rateLimited()) {
    res.status(429).json({ error: "Demasiadas peticiones; espera un minuto." });
    return;
  }
  void node(req, res, req.body);
});

const httpServer = app.listen(env.PORT, "0.0.0.0", () => {
  console.error(`[odoo-mcp] escuchando en http://0.0.0.0:${env.PORT}/mcp · Odoo ${env.ODOO_URL} (${env.ODOO_API_FLAVOR}) · hosts ${env.ALLOWED_HOSTS.join(", ")} · OAuth ${env.OAUTH_PASSWORD ? `activo en ${env.PUBLIC_URL}` : "desactivado (falta OAUTH_PASSWORD)"}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.error(`[odoo-mcp] ${sig}: cerrando`);
    await handler.close();
    httpServer.close(() => process.exit(0));
  });
}
