# odoo-mcp · Restaurante Juan Moreno

Servidor MCP que conecta Claude con el Odoo 19 del restaurante: 24 herramientas (17 de lectura, 7 de escritura con confirmación en dos pasos), política de acceso por lista blanca y registro de auditoría.

## Herramientas

| Área | Lectura | Escritura (previsualizar → confirmar) |
|---|---|---|
| Base | `odoo_whoami` `odoo_search_read` `odoo_get_fields` `odoo_search_count` `odoo_read_group` | — |
| Ventas y TPV | `odoo_pos_daily_summary` `odoo_pos_top_products` `odoo_pos_sessions` `odoo_sales_compare` | — |
| Stock y productos | `odoo_product_search` `odoo_stock_low` `odoo_stock_moves` | `odoo_product_update` `odoo_stock_adjust` |
| Facturación y contactos | `odoo_partner_search` `odoo_invoice_search` `odoo_sales_ledger_monthly` | `odoo_partner_upsert` `odoo_invoice_create_from_order` `odoo_invoice_post` |
| Tienda web | `odoo_web_orders` `odoo_order_detail` | `odoo_order_confirm` `odoo_order_note` |

**Cómo se escribe.** Sin `confirmation_token` la herramienta no toca nada: devuelve la previsualización (antes → después) y un token. Con ese token, y solo si los argumentos y el registro siguen igual, aplica. El token caduca a los 5 minutos y no se puede reutilizar. Cada escritura deja una nota en el historial del registro en Odoo y una línea en `AUDIT_LOG_PATH`. No hay ninguna herramienta que borre.

**Ojo con dos casos.** Facturar un *ticket del TPV* crea la factura ya validada (así lo hace Odoo); facturar un *pedido de venta* la deja en borrador hasta `odoo_invoice_post`.

El documento de diseño completo está en el artefacto "Odoo MCP Juan Moreno".

## Fase 0 · Preparar Odoo (10 minutos, se hace una vez)

1. **Usuario técnico.** En Odoo: Ajustes → Usuarios → Nuevo. Nombre `Claude MCP`, login `claude@restaurantejuanmoreno.es` (o similar). Permisos:
   - Ventas: *Usuario: todos los documentos*
   - Inventario: *Usuario*
   - Facturación: *Facturación*
   - Punto de venta: *Usuario*
   - Sitio web: *Editor restringido*
   - Administración: *(vacío)*
   - Marca la casilla "Cambiar contraseña" y pon una larga; no la vas a usar, pero el usuario necesita una.
2. **API key.** Entra con ese usuario (o desde Ajustes → Usuarios → Claude MCP → pestaña Seguridad de la cuenta) → Claves API → Nueva clave. Descripción `odoo-mcp`, duración la máxima (3 meses). Copia la clave: solo se muestra una vez. Apunta la fecha de caducidad en el calendario.
3. **Comprobar que JSON-2 funciona** (sustituye `LA_KEY`):

   ```bash
   curl -s -X POST https://juanmoreno.surftpv.app/json/2/res.users/context_get \
     -H "Authorization: bearer LA_KEY" \
     -H "Content-Type: application/json; charset=utf-8" \
     -H "X-Odoo-Database: juanmoreno" \
     -d '{}'
   ```

   Debe devolver algo como `{"lang": "es_ES", "tz": "Europe/Madrid", "uid": 12}`. (Comprobado el 21/09/2026: el hosting sí expone `/json/2`, Odoo 19.0.) Si algún día devolviera 404: en `.env` pon `ODOO_API_FLAVOR=jsonrpc` y `ODOO_LOGIN=<login del usuario>`.
4. **Categoría de vinos.** Inventario → Configuración → Categorías de producto → abre la de vinos; el número que aparece en la URL (`.../product.category/23`) es `WINE_CATEGORY_ID`.

## Probar en tu Mac

```bash
cd ~/Documents/odoo-mcp
npm install
cp .env.example .env        # y rellena ODOO_API_KEY, ODOO_API_KEY_EXPIRES y MCP_BEARER_TOKEN (openssl rand -hex 32)
npm run typecheck
npm run dev                 # escucha en http://localhost:3000/mcp
```

Prueba rápida sin Claude, desde otra terminal:

```bash
# Sin token → 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/mcp

# Con token → lista de herramientas
curl -s -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $(grep MCP_BEARER_TOKEN .env | cut -d= -f2)" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Con la interfaz gráfica: `npx @modelcontextprotocol/inspector`, transporte *Streamable HTTP*, URL `http://localhost:3000/mcp`, cabecera `Authorization: Bearer …`.

Para conectarlo a Claude Code en local: `claude mcp add --transport http odoo http://localhost:3000/mcp --header "Authorization: Bearer <token>"`.

## Desplegar en Easypanel

1. Sube la carpeta a un repositorio privado de GitHub.
2. Easypanel → tu proyecto → *+ Service* → *App* → Source: GitHub (el repo, rama `main`). Build: *Dockerfile*.
3. Environment: copia las variables de `.env.example` con sus valores reales. `ALLOWED_HOSTS` debe contener el dominio que le des al servicio (p. ej. `mcp.restaurantejuanmoreno.es`). `AUDIT_LOG_PATH` ya viene como `/data/audit.jsonl` en la imagen.
   Mounts: añade un volumen en `/data` para que el registro de auditoría sobreviva a los redespliegues.
4. Domains: añade el dominio con HTTPS, puerto 3000.
5. Comprueba `https://<dominio>/healthz` → `{"ok":true,...}` y que `POST https://<dominio>/mcp` sin cabecera devuelve 401.

## Conectar en Claude

**Claude (web, escritorio, móvil):** Ajustes → Conectores → *Añadir conector personalizado* → URL `https://<dominio>/mcp`, sin rellenar nada más. Claude abrirá la página de acceso del servidor: introduce la contraseña de `OAUTH_PASSWORD`. El servidor solo acepta volver a claude.ai / claude.com / localhost, limita los intentos fallidos (5 por IP cada 15 min) y emite tokens firmados de 8 h que se renuevan solos durante 90 días. Cambiar `OAUTH_PASSWORD` o `MCP_BEARER_TOKEN` desconecta a todos.

**Claude Code o scripts:** siguen pudiendo usar el token fijo en la cabecera `Authorization: Bearer <MCP_BEARER_TOKEN>`.

### (antes) Conectar con cabecera fija

Ajustes → Conectores → *Añadir conector personalizado* → URL `https://<dominio>/mcp`. En la opción de cabeceras añade `Authorization` con valor `Bearer <MCP_BEARER_TOKEN>`. Primera prueba: "¿qué usuario eres en Odoo?".

## Estructura

```
src/index.ts        Express + token bearer + handler MCP
src/env.ts          variables de entorno
src/policy.ts       lista blanca de modelos, campos y métodos
src/odoo/client.ts  cliente JSON-2 (y jsonrpc de respaldo)
src/odoo/errors.ts  errores de Odoo → mensajes accionables
src/format.ts       tablas Markdown + structuredContent
src/tz.ts           días de Madrid ↔ datetime UTC de Odoo
src/confirm.ts      tokens de confirmación (HMAC, 5 min, un solo uso)
src/audit.ts        auditoría JSONL + nota en el chatter
src/writes.ts       plantilla previsualizar → confirmar
src/oauth.ts        OAuth 2.1 (registro dinámico + PKCE) para los conectores de Claude
src/odoo/aggregate.ts  formatted_read_group con respaldo read_group
src/tools/base.ts      herramientas base
src/tools/pos.ts       TPV y comparativas
src/tools/stock.ts     productos, stock, ajustes
src/tools/invoicing.ts contactos, facturas, libro de ventas
src/tools/web.ts       pedidos web, detalle, confirmar, notas
evals/preguntas.xml    10 preguntas de evaluación (fase 4)
```

## Mantenimiento

- La API key de Odoo caduca como máximo a los 3 meses: genera otra, cámbiala en Easypanel (con su nueva `ODOO_API_KEY_EXPIRES`) y redespliega. `odoo_whoami` avisa cuando quedan 15 días o menos.
- Rota `MCP_BEARER_TOKEN` a la vez y actualiza la cabecera en el conector de Claude.
