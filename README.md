# Endpilot

Cliente de APIs de escritorio, autohospedado y colaborativo. Alternativa local-first a Postman, compatible con sus colecciones. Nombre provisional.

Estado: **Fase 4 en curso** (la app funciona sola en local; puede iniciar sesión en un servidor y ver tus workspaces, todavía sin sincronizar colecciones). El plan completo está en [PLAN.md](PLAN.md).

## Requisitos

- Rust 1.94+ (edition 2024) y [Bun](https://bun.sh) 1.3+ (no usar npm)
- Windows: WebView2 y Visual Studio Build Tools (C++)
- Linux: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`
- Docker + Compose (backend)

## Desarrollo

```bash
# App de escritorio
cd apps/desktop
bun install
bun run tauri dev

# Backend (API, Postgres, Redis, Caddy) desde la raíz del repo
docker compose -f deploy/docker-compose.dev.yml up -d --build
curl http://localhost/health
```

## Checks

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace   # los tests del servidor necesitan el Postgres de dev levantado
cd apps/desktop && bun run lint && bun test && bun run format:check && bun run build
```

`cargo` sobre el workspace compila la app Tauri, que necesita `apps/desktop/dist`: corre `bun run build` antes la primera vez.

## Estructura

```
apps/desktop/   Tauri 2 + React (src/ = UI, src-tauri/ = núcleo Rust)
crates/core/    Tipos compartidos entre cliente y servidor
crates/http/    Motor HTTP (reqwest) que ejecuta los requests
crates/store/   Base local SQLite (colecciones, entornos, historial)
crates/postman-compat/  Importar/exportar Postman, importar OpenAPI 3 y cURL
crates/script-sandbox/  Scripts pm.* en QuickJS aislado
server/         API Axum (cuentas, sesiones, workspaces), migraciones y Dockerfile
deploy/         Compose, Caddyfile, .env.example
```

## API del servidor

Errores: `{"error": {"code": "...", "message": "..."}}`. Las rutas con 🔒 piden `Authorization: Bearer <accessToken>`.

| Ruta | Qué hace |
|---|---|
| `POST /auth/register` | `{email, name, password, deviceName}` → tokens. Crea el workspace "Personal". |
| `POST /auth/login` | `{email, password, deviceName}` → tokens (una sesión por dispositivo) |
| `POST /auth/refresh` | `{refreshToken}` → tokens nuevos; el refresh anterior deja de servir |
| `POST /auth/logout` 🔒 | Cierra la sesión actual |
| `GET /me` 🔒 | Usuario actual |
| `GET /sessions` 🔒, `DELETE /sessions/{id}` 🔒 | Dispositivos con sesión; cerrar uno a distancia |
| `GET/POST /workspaces` 🔒, `PATCH/DELETE /workspaces/{id}` 🔒 | Listar, crear (`{name}`), renombrar (owner/admin), borrar (owner; el personal no) |

El access token dura 15 min. El refresh token rota en cada uso; si se reutiliza uno viejo, la sesión se revoca.

Protección: tras 5 logins fallidos en 15 minutos (mismo email y misma IP) el servidor responde `429 too_many_attempts`; también limita por email (20) y por IP (50), y los registros a 10 por IP por hora. Con `ALLOW_REGISTRATION=false` en `deploy/.env`, `POST /auth/register` responde `403 registration_closed`.

## Compatibilidad con Postman

- **Importa:** Collection v2.1 y v2.0, environments y globals de Postman; OpenAPI 3.x (JSON o YAML); comandos cURL (también pegándolos en la barra de URL).
- **Exporta:** Collection v2.1 y environments.
- **Se conserva:** la herencia de auth (colección → carpeta → request) y los scripts pre-request y post-response (`event` de Postman).
- **Se pierde al importar:** ejemplos de respuesta, descripciones, variables de ruta (`:id` queda en la URL tal cual), rutas de archivos en form-data y en cURL (por seguridad: vuelve a elegirlos) y tipos de auth distintos de Bearer, Basic y API key.

## Scripts

Pre-request y post-response, por request, carpeta y colección (corren colección → carpeta → request). JavaScript en QuickJS aislado: sin archivos, red ni temporizadores, con 5 s y 64 MB por fase. API `pm.*` cubierta: `pm.environment`, `pm.globals`, `pm.collectionVariables`, `pm.variables` (get/set/unset/has), `pm.request` (url, method, headers), `pm.response` (code, status, headers, `json()`, `text()`, `to.have.status`), `pm.test`, `pm.expect` (subconjunto de chai) y `console`. Los cambios de variables se guardan; `pm.variables.set` dura solo ese envío. Si un pre-request falla, el request no se envía.

Los scripts que llegan al importar una colección quedan **bloqueados** hasta que los revises: un script ajeno podría leer tus variables y cambiar a dónde se envía el request. Se activan uno por uno en su pestaña Scripts, o todos a la vez en los ajustes de la colección (un escudo amarillo en el árbol avisa que hay pendientes).
- **OpenAPI:** una carpeta por tag; `servers[0]` pasa a la variable de colección `baseUrl`; `{id}` en la ruta se vuelve `{{id}}`. Swagger 2.0 no se importa.
- Pruebas de ida y vuelta (importar, exportar, reimportar) sobre los fixtures de `crates/postman-compat/tests/fixtures/`.
