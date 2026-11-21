# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Estado actual

**Fase 3 completada** (requests con pestañas; colecciones, entornos, variables, auth e historial en SQLite local; importar/exportar Postman, importar OpenAPI y cURL, generar código; herencia de auth, ajustes de colección/carpeta y scripts pre/post con `pm.*`). La API solo tiene `GET /health`. Siguiente: **Fase 4** (servidor y cuentas). `PLAN.md` es la fuente de verdad para alcance, stack, arquitectura y fases; léelo antes de proponer cambios de diseño y marca sus casillas al cerrar tareas. Nombre del producto provisional ("Endpilot").

## Comandos

```bash
# Rust (desde la raíz; workspace = apps/desktop/src-tauri, crates/*, server)
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo test -p endpilot-http errors_are_classified   # un solo test: -p <crate> <filtro>

# Frontend (en apps/desktop). Solo bun: nunca npm/pnpm/yarn; el lockfile es bun.lock
bun run tauri dev        # app de escritorio con recarga
bun run lint && bun test && bun run format:check && bun run build
bun test src/lib/url.test.ts -t "round-trips"   # un solo test (bun:test, archivos *.test.ts)

# Backend dev (desde la raíz): API :8080, Caddy :80, Postgres host :5433, Redis :6379
docker compose -f deploy/docker-compose.dev.yml up -d --build --wait
docker compose -f deploy/docker-compose.dev.yml watch   # reconstruye api al cambiar server/ o crates/
```

- Cualquier `cargo` que compile `endpilot-desktop` falla si no existe `apps/desktop/dist` (`tauri::generate_context!` lo exige): corre `bun run build` antes. CI hace lo mismo.
- El Dockerfile del server usa la raíz como contexto y compila solo `-p endpilot-server`; `Cargo.lock` debe estar al día (`--locked`).
- Postgres se expone en el host en 5433 porque en esta máquina hay un Postgres local en 5432.
- Lints de workspace: `unsafe_code = forbid`, clippy `all` en warn (CI con `-D warnings`). Cada crate nuevo necesita `[lints] workspace = true` y heredar `version/edition/license` del workspace.

## Qué es

Alternativa de escritorio a Postman, autohospedada, local-first, con sync en tiempo real y colaboración sin límite de usuarios. Compatible con Postman Collection v2.1/v2.0.

**Fuera de alcance por decisión:** funciones de IA, mock servers, monitores, marketplace, versión móvil/web. No los agregues.

## Arquitectura planeada (resumen)

- **Cliente:** Tauri 2 (núcleo Rust) + React/TypeScript/Vite/Tailwind, Zustand, CodeMirror 6. Las peticiones HTTP se hacen en Rust con `reqwest` (no desde el WebView). Base local SQLite.
- **Servidor:** Rust + Axum, PostgreSQL, Redis pub/sub (fan-out entre instancias), MinIO, Caddy (único servicio que expone 80/443).
- **Monorepo:** existen `apps/desktop/`, `crates/core` (tipos compartidos), `crates/http` (motor reqwest), `crates/store` (SQLite local), `crates/postman-compat` (importar/exportar), `crates/script-sandbox` (QuickJS, `pm.*`), `server/`, `deploy/` (compose dev, Caddyfile, `.env.example`). Se crean en su fase: `crates/sync-protocol`, `server/migrations/`, `deploy/docker-compose.yml` (prod), `deploy/backup/`, `docs/adr/`. Los crates se comparten entre cliente y servidor.

### Flujo de un request (implementado)

1. La UI (`apps/desktop/src`) guarda por pestaña un `RequestSpec` en el store de Zustand (`store.ts`), opcionalmente ligado a un item guardado (`itemId`; `saved` detecta cambios sin guardar). El spec conserva los datos de todos los modos de body y está sin resolver; `toHttpRequest` (`src/lib/resolve.ts`) resuelve `{{variables}}` (globales < colección < entorno activo; las desconocidas quedan tal cual) y aplica la auth al enviar. Cada envío se agrega al historial.
2. `invoke("send_request", { id, request })` → comando en `src-tauri/src/lib.rs`, que lanza `endpilot_http::send` en una tarea tokio y guarda su `AbortHandle` por `id`. `cancel_request(id)` la aborta y devuelve un error `cancelled`.
3. `crates/http` usa un cliente reqwest **por request** (para medir DNS con un resolver propio y registrar redirecciones) y devuelve `HttpResponse`, o un `HttpError` con `kind` clasificado (dns/tls/timeout/connection…). TLS se reconoce por tipo `rustls::Error`, que llega envuelto en varios `io::Error`.
4. Los tipos viven en `crates/core/src/http.rs` (motor) y `crates/core/src/model.rs` (colecciones, entornos, historial) y se reflejan a mano en `apps/desktop/src/types.ts` (serde camelCase). **Si cambias uno, cambia el otro.** Los modos de body usan los nombres de Postman (`raw`, `urlencoded`, `formdata`) para facilitar la Fase 3.
5. Params y URL se sincronizan en ambas direcciones (`src/lib/url.ts`) sin codificar ni decodificar, para que `{{variables}}` sobrevivan.

- Colores y fuentes de la UI son tokens de Tailwind v4 en `src/index.css` (`@theme`); los componentes no usan hex sueltos.
### Base local (implementada)

- `crates/store`: `Store` sobre rusqlite (WAL, migraciones por `PRAGMA user_version`), IDs UUID v7, borrado lógico con `deleted_at` (borrar una carpeta o colección oculta su subárbol), orden con `sort REAL` (mover = punto medio), historial limitado a 500. Archivo: `app_data_dir()/endpilot.db`.
- `src-tauri/src/store_cmds.rs`: un comando Tauri delgado por método del `Store`. La UI llama `invoke` y luego recarga el `snapshot` completo (`refresh`): los datos son pocos y así el estado no se desincroniza.
- Importar/exportar: `crates/postman-compat` convierte texto (cURL, Postman, OpenAPI; JSON o YAML, detectado por contenido) en `model::CollectionTree` o `RequestSpec`, y de vuelta a Postman v2.1. `Store::import_collection`/`export_collection` pasan el árbol a filas en una transacción. Comandos en `src-tauri/src/io_cmds.rs`; el código generado (cURL, fetch, Python) se hace en `src/lib/codegen.ts` sobre el request ya resuelto. Al tocar el formato, corre `cargo test -p endpilot-postman-compat` (fixtures de ida y vuelta).
- Herencia: `Auth::Inherit` (por defecto en requests nuevos) toma la auth de la carpeta más cercana que no herede, hasta la colección (`effectiveAuth` en `src/lib/resolve.ts`, ancestros con `ancestorsOf` en `store.ts`). Colecciones y carpetas guardan `Settings { auth, scripts }` en la columna `settings` (migración 2).
- Scripts: `send` en `store.ts` junta los scripts colección → carpetas → request, llama `run_scripts` (Rust, `crates/script-sandbox`, `spawn_blocking`) antes y después de enviar, y guarda las variables cambiadas (`applyVarMap` en `src/lib/scripts.ts`). La API `pm` vive en `crates/script-sandbox/src/prelude.js`; Rust solo pasa JSON. Los scripts importados llegan con `Scripts.blocked = true` y `scriptChain` los salta hasta que el usuario los activa (`approve_scripts` para toda la colección). No quites ese bloqueo: es la defensa contra colecciones maliciosas.
- Confirmaciones con `ask` de `@tauri-apps/plugin-dialog` (requiere el permiso `dialog:allow-message`; abrir/guardar archivos, `dialog:allow-open`/`allow-save`).

- Los atajos (Ctrl+Enter, Ctrl+S, Ctrl+T, Ctrl+W) se registran en fase de captura en `App.tsx` para ganarle al keymap de CodeMirror.

### Sincronización (la parte delicada)

- Local-first: todo cambio se aplica primero en SQLite local y entra a una cola de salida; se envía por WebSocket.
- El servidor es árbitro del orden: valida permisos/esquema, escribe en `change_log` (secuencia global por workspace) y reenvía.
- IDs UUID v7; **HLC por campo**; conflictos = last-writer-wins **por campo** (campos distintos se combinan).
- Borrados lógicos (tombstones, `deleted_at`).
- Reconexión: el cliente pide todo lo posterior a su último número de secuencia.
- Cualquier cambio aquí requiere pruebas de concurrencia, cortes de red, relojes desajustados y mensajes duplicados/fuera de orden.

### Otras decisiones fijadas

- Contenido de colecciones/requests guardado como JSONB compatible con Postman.
- Compatibilidad Postman verificada con pruebas de ida y vuelta (import → export → reimport) sobre fixtures.
- Scripts `pm.*` en QuickJS (`rquickjs`) aislado: sin FS ni red, con límites de tiempo y memoria. Cobertura de `pm.*` esencial, no total.
- Auth: Argon2id, JWT corto + refresh token rotativo por dispositivo (revocable), OAuth Google/GitHub, TOTP opcional. Roles: `owner`, `admin`, `editor`, `viewer`.
- Secretos: en keychain del dispositivo o cifrados en servidor, según elija el admin del workspace.

## Despliegue (producción, Fase 9)

```bash
cp deploy/.env.example deploy/.env
docker compose -f deploy/docker-compose.yml up -d
```

Reglas: Dockerfile multi-etapa, healthchecks en todos los servicios, servicio `migrate` corre antes de la API, config en un único `.env` (nunca en git), Postgres/Redis/MinIO solo en red interna. La app de escritorio **no** va en Docker: se compila en CI como instalador.
