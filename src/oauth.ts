/**
 * Servidor de autorización OAuth 2.1 mínimo para los conectores de Claude
 * (registro dinámico de clientes + PKCE S256 + refresh tokens).
 *
 * Sin estado: clientes, códigos y tokens son JSON firmados con HMAC, así que
 * sobreviven a reinicios y redespliegues. Para revocarlo todo basta con cambiar
 * OAUTH_PASSWORD o MCP_BEARER_TOKEN (ambos entran en la clave de firma).
 *
 *   GET  /.well-known/oauth-protected-resource/mcp   metadatos del recurso (RFC 9728)
 *   GET  /.well-known/oauth-authorization-server      metadatos del AS (RFC 8414)
 *   POST /register                                     registro dinámico (RFC 7591)
 *   GET  /authorize                                    página de acceso con contraseña
 *   POST /authorize                                    comprueba la contraseña y redirige con ?code
 *   POST /token                                        code → tokens · refresh_token → tokens
 */
import { mcpAuthMetadataRouter } from "@modelcontextprotocol/express";
import express from "express";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env.js";

const ACCESS_TTL_S = 8 * 3600; // 8 h
const REFRESH_TTL_S = 90 * 24 * 3600; // 90 días (como la API key de Odoo)
const CODE_TTL_S = 120;
export const SCOPE = "odoo";

/** Destinos a los que se permite volver tras el login (evita usar la página para phishing). */
function redirectAllowed(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:" && ["claude.ai", "claude.com"].includes(u.hostname)) return true;
    if (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname)) return true; // Claude Code, Inspector
    return false;
  } catch {
    return false;
  }
}

// ---------------- Firma ----------------
const key = createHmac("sha256", "odoo-mcp-oauth")
  .update(env.MCP_BEARER_TOKEN)
  .update("\0")
  .update(env.OAUTH_PASSWORD)
  .digest();

function sign(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function unsign<T extends Record<string, unknown>>(token: string, type: string): T | undefined {
  const [body, mac] = String(token ?? "").split(".");
  if (!body || !mac) return undefined;
  const expected = Buffer.from(createHmac("sha256", key).update(body).digest("base64url"));
  const got = Buffer.from(mac);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return undefined;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as T & { t?: string; exp?: number };
    if (p.t !== type) return undefined;
    if (typeof p.exp === "number" && p.exp < Date.now() / 1000) return undefined;
    return p;
  } catch {
    return undefined;
  }
}

const now = () => Math.floor(Date.now() / 1000);

/** ¿Es un access token OAuth válido emitido por este servidor? */
export function verifyAccessToken(token: string): { clientId: string; exp: number } | undefined {
  const p = unsign<{ c: string; exp: number }>(token, "at");
  return p ? { clientId: p.c, exp: p.exp } : undefined;
}

function issueTokens(clientId: string) {
  const exp = now() + ACCESS_TTL_S;
  return {
    access_token: sign({ t: "at", c: clientId, exp, n: randomBytes(6).toString("base64url") }),
    token_type: "Bearer",
    expires_in: ACCESS_TTL_S,
    refresh_token: sign({ t: "rt", c: clientId, exp: now() + REFRESH_TTL_S, n: randomBytes(6).toString("base64url") }),
    scope: SCOPE,
  };
}

// ---------------- Límite de intentos de contraseña ----------------
const FAIL_WINDOW_MS = 15 * 60_000;
const MAX_FAILS_PER_IP = 5;
const MAX_FAILS_GLOBAL = 20;
const fails: number[] = [];
const failsByIp = new Map<string, number[]>();

function tooManyFails(ip: string): boolean {
  const cut = Date.now() - FAIL_WINDOW_MS;
  while (fails.length && fails[0]! < cut) fails.shift();
  const mine = (failsByIp.get(ip) ?? []).filter((t) => t >= cut);
  failsByIp.set(ip, mine);
  return mine.length >= MAX_FAILS_PER_IP || fails.length >= MAX_FAILS_GLOBAL;
}
function recordFail(ip: string) {
  fails.push(Date.now());
  failsByIp.set(ip, [...(failsByIp.get(ip) ?? []), Date.now()]);
}

function passwordOk(pw: string): boolean {
  const a = createHash("sha256").update(String(pw ?? "")).digest();
  const b = createHash("sha256").update(env.OAUTH_PASSWORD).digest();
  return env.OAUTH_PASSWORD.length > 0 && timingSafeEqual(a, b);
}

const usedCodes = new Map<string, number>();

// ---------------- Página de acceso ----------------
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(opts: { clientName: string; hidden: Record<string, string>; error?: string; disabled?: string }): string {
  const fields = Object.entries(opts.hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conectar con Odoo · Juan Moreno</title>
<style>
:root{--bg:#F6F7F5;--card:#fff;--ink:#1B2430;--muted:#5B6873;--line:#D8DEDF;--accent:#0E6B6B;--bad:#9E2B2B}
@media (prefers-color-scheme:dark){:root{--bg:#131A1F;--card:#1B242B;--ink:#E6EAEA;--muted:#9AA7AE;--line:#2E3A42;--accent:#5FC2BD;--bad:#E88383}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,sans-serif;padding:16px}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}
h1{font-size:1.25rem;margin:0 0 .25rem}p{margin:.25rem 0 1rem;color:var(--muted);font-size:.95rem}
label{display:block;font-weight:600;margin:1rem 0 .35rem}input[type=password]{width:100%;padding:.7rem .8rem;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--ink);font-size:1rem}
button{margin-top:1.1rem;width:100%;padding:.75rem;border:0;border-radius:8px;background:var(--accent);color:#fff;font-weight:600;font-size:1rem;cursor:pointer}
.err{color:var(--bad);font-weight:600;margin-top:.75rem}.small{font-size:.8rem;margin-top:1rem}
</style></head><body><main>
<h1>Restaurante Juan Moreno</h1>
<p><b>${esc(opts.clientName)}</b> quiere acceder al Odoo del restaurante (ventas, stock, facturas y pedidos web).</p>
${
  opts.disabled
    ? `<p class="err">${esc(opts.disabled)}</p>`
    : `<form method="post" action="/authorize">${fields}
<label for="pw">Contraseña de acceso</label>
<input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
${opts.error ? `<div class="err">${esc(opts.error)}</div>` : ""}
<button type="submit">Permitir acceso</button></form>`
}
<p class="small">Las escrituras en Odoo siempre piden confirmación en el chat. Si no esperabas esta pantalla, ciérrala.</p>
</main></body></html>`;
}

/**
 * Cabeceras de la página de acceso. form-action tiene que incluir el origen de la redirect_uri:
 * Chrome aplica form-action también a la redirección 302 que sigue al POST, y sin él la bloquea.
 */
function htmlHeaders(res: express.Response, redirectUri?: string) {
  let target = "";
  try {
    if (redirectUri && redirectAllowed(redirectUri)) target = " " + new URL(redirectUri).origin;
  } catch {
    /* sin destino válido: solo 'self' */
  }
  res.set({
    "Content-Type": "text/html; charset=utf-8",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${target}; frame-ancestors 'none'`,
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
}

function oauthError(res: express.Response, status: number, error: string, description: string) {
  res.status(status).set("Cache-Control", "no-store").json({ error, error_description: description });
}

// ---------------- Router ----------------
export function oauthRouter(publicUrl: string): express.Router {
  const r = express.Router();
  const resource = new URL(`${publicUrl}/mcp`);

  // CORS para los endpoints que pueden llamarse desde un navegador (Inspector).
  r.use(["/.well-known", "/register", "/token"], (req, res, next) => {
    res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    next();
  });

  r.use(
    mcpAuthMetadataRouter({
      oauthMetadata: {
        issuer: publicUrl,
        authorization_endpoint: `${publicUrl}/authorize`,
        token_endpoint: `${publicUrl}/token`,
        registration_endpoint: `${publicUrl}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [SCOPE],
      },
      resourceServerUrl: resource,
      scopesSupported: [SCOPE],
      resourceName: "Odoo · Restaurante Juan Moreno",
      dangerouslyAllowInsecureIssuerUrl: publicUrl.startsWith("http://"),
    }),
  );

  r.post("/register", express.json({ limit: "32kb" }), (req, res) => {
    const body = (req.body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (!uris.length) return oauthError(res, 400, "invalid_redirect_uri", "Falta redirect_uris.");
    const bad = uris.filter((u) => !redirectAllowed(u));
    if (bad.length) {
      console.error(`[oauth] registro rechazado: redirect_uri no permitida ${bad.join(", ")}`);
      return oauthError(res, 400, "invalid_redirect_uri", `redirect_uri no permitida: ${bad.join(", ")}`);
    }
    const name = String(body.client_name ?? "Cliente MCP").slice(0, 80);
    const iat = now();
    const client_id = sign({ t: "client", r: uris, n: name, iat });
    console.error(`[oauth] cliente registrado: ${name} → ${uris.join(", ")}`);
    res.status(201).set("Cache-Control", "no-store").json({
      client_id,
      client_id_issued_at: iat,
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: SCOPE,
    });
  });

  /** Valida los parámetros de /authorize (GET o POST). Devuelve error legible o los datos. */
  function checkAuthorize(q: Record<string, unknown>) {
    const client = unsign<{ r: string[]; n: string }>(String(q.client_id ?? ""), "client");
    if (!client) return { error: "Cliente desconocido. Vuelve a añadir el conector en Claude." } as const;
    const redirect = String(q.redirect_uri ?? "");
    if (!client.r.includes(redirect) || !redirectAllowed(redirect)) return { error: "La dirección de retorno no coincide con la registrada." } as const;
    if (q.response_type !== "code") return { error: "response_type debe ser code." } as const;
    if (q.code_challenge_method !== "S256" || !q.code_challenge) return { error: "Falta PKCE (code_challenge S256)." } as const;
    return { client, redirect } as const;
  }

  const hiddenFrom = (q: Record<string, unknown>) =>
    Object.fromEntries(
      ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"]
        .filter((k) => q[k] !== undefined)
        .map((k) => [k, String(q[k])]),
    );

  r.get("/authorize", (req, res) => {
    const q = req.query as Record<string, unknown>;
    const chk = checkAuthorize(q);
    htmlHeaders(res, "error" in chk ? undefined : chk.redirect);
    if ("error" in chk) return void res.status(400).send(page({ clientName: "Un cliente", hidden: {}, disabled: chk.error }));
    if (!env.OAUTH_PASSWORD) return void res.status(503).send(page({ clientName: chk.client.n, hidden: {}, disabled: "El acceso por OAuth no está activado (falta OAUTH_PASSWORD en el servidor)." }));
    res.send(page({ clientName: chk.client.n, hidden: hiddenFrom(q) }));
  });

  r.post("/authorize", express.urlencoded({ extended: false, limit: "16kb" }), (req, res) => {
    const q = (req.body ?? {}) as Record<string, unknown>;
    const chk = checkAuthorize(q);
    htmlHeaders(res, "error" in chk ? undefined : chk.redirect);
    if ("error" in chk) return void res.status(400).send(page({ clientName: "Un cliente", hidden: {}, disabled: chk.error }));
    const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").split(",")[0]!.trim();
    if (tooManyFails(ip)) {
      console.error(`[oauth] bloqueado por intentos fallidos: ${ip}`);
      return void res.status(429).send(page({ clientName: chk.client.n, hidden: {}, disabled: "Demasiados intentos fallidos. Espera 15 minutos." }));
    }
    if (!passwordOk(String(q.password ?? ""))) {
      recordFail(ip);
      console.error(`[oauth] contraseña incorrecta desde ${ip}`);
      return void res.status(401).send(page({ clientName: chk.client.n, hidden: hiddenFrom(q), error: "Contraseña incorrecta." }));
    }
    const code = sign({ t: "code", c: String(q.client_id), ru: chk.redirect, cc: String(q.code_challenge), exp: now() + CODE_TTL_S, n: randomBytes(8).toString("base64url") });
    const to = new URL(chk.redirect);
    to.searchParams.set("code", code);
    if (q.state !== undefined) to.searchParams.set("state", String(q.state));
    to.searchParams.set("iss", publicUrl);
    console.error(`[oauth] acceso concedido a ${chk.client.n}`);
    res.redirect(302, to.toString());
  });

  r.post("/token", express.urlencoded({ extended: false, limit: "16kb" }), express.json({ limit: "16kb" }), (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const s = (k: string) => (b[k] === undefined ? "" : String(b[k]));

    if (b.grant_type === "authorization_code") {
      const code = s("code");
      const p = unsign<{ c: string; ru: string; cc: string; exp: number }>(code, "code");
      if (!p) return oauthError(res, 400, "invalid_grant", "Código inválido o caducado.");
      for (const [c, e] of usedCodes) if (e < now()) usedCodes.delete(c);
      if (usedCodes.has(code)) return oauthError(res, 400, "invalid_grant", "Código ya usado.");
      if (b.client_id !== undefined && s("client_id") !== p.c) return oauthError(res, 400, "invalid_grant", "El código no es de este cliente.");
      if (b.redirect_uri !== undefined && s("redirect_uri") !== p.ru) return oauthError(res, 400, "invalid_grant", "redirect_uri no coincide.");
      const challenge = createHash("sha256").update(s("code_verifier")).digest("base64url");
      if (!s("code_verifier") || challenge !== p.cc) return oauthError(res, 400, "invalid_grant", "PKCE: code_verifier no válido.");
      usedCodes.set(code, p.exp);
      return void res.set("Cache-Control", "no-store").json(issueTokens(p.c));
    }

    if (b.grant_type === "refresh_token") {
      const p = unsign<{ c: string }>(s("refresh_token"), "rt");
      if (!p) return oauthError(res, 400, "invalid_grant", "refresh_token inválido o caducado.");
      if (b.client_id !== undefined && s("client_id") !== p.c) return oauthError(res, 400, "invalid_grant", "El refresh_token no es de este cliente.");
      return void res.set("Cache-Control", "no-store").json(issueTokens(p.c));
    }

    oauthError(res, 400, "unsupported_grant_type", "Solo authorization_code y refresh_token.");
  });

  return r;
}
