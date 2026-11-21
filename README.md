# Endpilot

Cliente de APIs de escritorio, autohospedado y colaborativo. Alternativa local-first a Postman, compatible con sus colecciones. Nombre provisional.

Estado: **Fase 1** (envío de requests; sin persistencia todavía). El plan completo está en [PLAN.md](PLAN.md).

## Requisitos

- Rust estable (edition 2024) y [Bun](https://bun.sh) 1.3+ (no usar npm)
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
cargo test --workspace
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
server/         API Axum + Dockerfile
deploy/         Compose, Caddyfile, .env.example
```

## Compatibilidad con Postman

- **Importa:** Collection v2.1 y v2.0, environments y globals de Postman; OpenAPI 3.x (JSON o YAML); comandos cURL (también pegándolos en la barra de URL).
- **Exporta:** Collection v2.1 y environments.
- **Se pierde al importar:** scripts (pre-request y tests), ejemplos de respuesta, descripciones, variables de ruta (`:id` queda en la URL tal cual), rutas de archivos en form-data (por seguridad: vuelve a elegirlos) y tipos de auth distintos de Bearer, Basic y API key. La auth heredada de carpeta o colección se copia a cada request.
- **OpenAPI:** una carpeta por tag; `servers[0]` pasa a la variable de colección `baseUrl`; `{id}` en la ruta se vuelve `{{id}}`. Swagger 2.0 no se importa.
- Pruebas de ida y vuelta (importar, exportar, reimportar) sobre los fixtures de `crates/postman-compat/tests/fixtures/`.
