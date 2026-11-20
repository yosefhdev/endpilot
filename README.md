# Endpilot

Cliente de APIs de escritorio, autohospedado y colaborativo. Alternativa local-first a Postman, compatible con sus colecciones. Nombre provisional.

Estado: **Fase 0** (estructura base). El plan completo está en [PLAN.md](PLAN.md).

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
cd apps/desktop && bun run lint && bun run format:check && bun run build
```

`cargo` sobre el workspace compila la app Tauri, que necesita `apps/desktop/dist`: corre `bun run build` antes la primera vez.

## Estructura

```
apps/desktop/   Tauri 2 + React (src/ = UI, src-tauri/ = núcleo Rust)
crates/core/    Tipos compartidos entre cliente y servidor
server/         API Axum + Dockerfile
deploy/         Compose, Caddyfile, .env.example
```
