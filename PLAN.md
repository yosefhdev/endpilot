# Plan del proyecto: Cliente de APIs de escritorio, autohospedado y colaborativo

> Nombre de trabajo: **`<NOMBRE-DEL-PROYECTO>`** (reemplazar; verificar que no choque con marcas existentes).
> Estado: Fase 3 completada. Última actualización: 2026-11-20.

## 1. Visión

Una alternativa a Postman **de escritorio**, **hospedada por nosotros**, con cuentas, workspaces sincronizados entre computadoras, colaboración en equipo **sin límite de usuarios** y sincronización en **tiempo real**. Compatible con las colecciones de Postman para que pasarse de uno a otro no tenga fricción.

### Principios
1. **Local-first:** la app responde al instante y funciona sin internet; la sincronización ocurre en segundo plano.
2. **Rápida y ligera:** instalador de pocos MB, bajo consumo de RAM, arranque rápido.
3. **Compatible:** importar/exportar el formato de Postman sin perder estructura.
4. **Autohospedable:** todo el servicio se levanta con un solo comando (`docker compose up -d`).
5. **Sin límites artificiales:** usuarios, workspaces y colecciones ilimitados (el único límite es el hardware).

## 2. Alcance

### Incluido (MVP y versión 1.0)
- Constructor de requests (HTTP/HTTPS) y visor de respuestas.
- Colecciones, carpetas, requests, ejemplos de respuesta, historial.
- Entornos y variables (globales, de entorno, de colección).
- Autenticación de requests: Bearer, Basic, API Key, OAuth 2.0.
- Scripts pre-request y tests (API compatible con `pm.*`) y collection runner.
- Importar/exportar: Postman Collection v2.1 (y v2.0), Environments, Globals; importar OpenAPI y cURL.
- Cuentas de usuario, sesiones por dispositivo, workspaces personales y de equipo.
- Roles, invitaciones, presencia y sincronización en tiempo real.
- Historial de versiones y registro de actividad.
- Despliegue 100 % en Docker.

### Fuera de alcance (por decisión)
- Funciones de IA.
- Mock servers, monitores programados y marketplace de APIs (posible fase futura).
- Versión móvil y versión web (posible fase futura).

## 3. Stack tecnológico

| Capa | Tecnología | Motivo |
|---|---|---|
| App de escritorio | **Tauri 2** (Rust) | Ligera, rápida, segura, sin CORS |
| Interfaz | React + TypeScript + Vite + Tailwind | Ecosistema maduro |
| Estado en UI | Zustand | Simple y rápido |
| Editor de código | CodeMirror 6 | Ligero, extensible |
| Peticiones HTTP | `reqwest` (Rust) | Control total de TLS, proxy, redirects, tiempos |
| Base local | SQLite (`rusqlite` o `sqlx`) | Local-first |
| Scripts | QuickJS (`rquickjs`) en sandbox | Aislado, con límites de tiempo y memoria |
| Servidor | Rust + **Axum** | Comparte tipos y lógica con el cliente; muy eficiente |
| Base de datos | PostgreSQL | Fiable, transaccional |
| Tiempo real | WebSocket + Redis pub/sub | Escala a varias instancias |
| Archivos | MinIO (compatible con S3) | Adjuntos y archivos grandes |
| Proxy / HTTPS | Caddy | HTTPS automático |
| Contenedores | Docker + Docker Compose | Un solo comando |
| CI/CD | GitHub Actions | Imágenes del servidor e instaladores |

## 4. Arquitectura

```
┌────────────────────────────┐        WebSocket + REST (HTTPS)       ┌──────────────────────────────┐
│  App de escritorio (Tauri) │ ◄──────────────────────────────────► │  Caddy (HTTPS)               │
│  React UI  +  núcleo Rust  │                                       │   └─► API Rust (Axum)        │
│  SQLite local (local-first)│                                       │         ├─► PostgreSQL       │
│  Cola de cambios offline   │                                       │         ├─► Redis (pub/sub)  │
└────────────────────────────┘                                       │         └─► MinIO (archivos) │
                                                                     └──────────────────────────────┘
```

### Estructura propuesta del monorepo

```
.
├── apps/
│   └── desktop/              # Tauri 2 + React (src-tauri/ y src/)
├── crates/
│   ├── core/                 # Modelo de datos, tipos compartidos, lógica de colecciones
│   ├── postman-compat/       # Importar/exportar Postman v2.1/v2.0, environments
│   ├── sync-protocol/        # Mensajes, HLC y reglas de resolución de conflictos
│   └── script-sandbox/       # Motor de scripts (QuickJS) y API pm.*
├── server/
│   ├── src/                  # API Axum
│   ├── migrations/           # Migraciones SQL
│   └── Dockerfile
├── deploy/
│   ├── docker-compose.yml        # Producción
│   ├── docker-compose.dev.yml    # Desarrollo
│   ├── Caddyfile
│   ├── .env.example
│   └── backup/                   # Scripts de respaldo y restauración
├── docs/                     # Documentación y decisiones (ADR)
├── .github/workflows/        # CI/CD
├── PLAN.md
└── README.md
```

## 5. Modelo de datos (borrador)

- **users**: id, email, password_hash (Argon2), nombre, creado_en, 2FA opcional.
- **devices / sessions**: id, user_id, nombre del dispositivo, refresh_token_hash, último uso, revocada.
- **workspaces**: id, nombre, tipo (personal/equipo), owner_id.
- **workspace_members**: workspace_id, user_id, rol (`owner`, `admin`, `editor`, `viewer`).
- **invitations**: id, workspace_id, email o token de enlace, rol, expira_en, usada.
- **collections / folders / requests / examples**: id, workspace_id, parent_id, orden, contenido (JSONB compatible con Postman), `version`, `updated_at`, `updated_by`, `deleted_at` (borrado lógico).
- **environments / variables**: id, workspace_id, nombre, variables (con indicador de secreto).
- **change_log**: secuencia global por workspace de cambios (base de la sincronización).
- **versions**: historial de versiones por request/colección.
- **audit_log**: quién hizo qué y cuándo.
- **attachments**: referencias a archivos en MinIO.

## 6. Sincronización en tiempo real

**Enfoque:** local-first con servidor como árbitro del orden.

1. Cada elemento tiene ID único (UUID v7), versión y un reloj lógico híbrido (**HLC**) por campo.
2. Al editar, el cambio se aplica **primero en SQLite local** y se agrega a una cola de salida.
3. El cliente envía el cambio por WebSocket; el servidor lo valida (permisos y esquema), lo guarda en `change_log` y lo reenvía a los demás clientes conectados al workspace (vía Redis si hay varias instancias).
4. **Conflictos:** gana el último cambio **por campo** (según HLC). Cambios en campos distintos del mismo request se combinan sin pérdida.
5. **Offline:** los cambios quedan en la cola y se envían al reconectar. Al conectar, el cliente pide al servidor "todo lo posterior a mi último número de secuencia" para ponerse al día.
6. **Borrados:** lógicos (tombstones) para propagarse bien y poder restaurarse.
7. **Presencia:** el servidor informa quién está conectado y qué elemento tiene abierto cada persona.
8. **Mejora opcional (fase posterior):** usar CRDT (por ejemplo Yjs) para editar a la vez los campos largos (scripts y bodies), estilo documento compartido.

**Pruebas obligatorias:** dos o más clientes editando lo mismo a la vez, cortes de red, reconexiones, relojes desajustados y mensajes duplicados o fuera de orden.

## 7. Compatibilidad con Postman

- **Importar y exportar:** Collection v2.1 y v2.0, Environments y Globals.
- Conservar carpetas, orden, descripciones, auth, headers, body (todos los modos), scripts, variables y ejemplos de respuesta.
- **Prueba de ida y vuelta:** importar una colección → exportar → volver a importar en Postman real → comparar. Mantener un conjunto de colecciones de ejemplo como fixtures de prueba.
- Evaluar el soporte del formato más nuevo de Postman (v3, multi-archivo) y decidir si se incluye.
- **Límites conocidos:** la API `pm.*` se cubrirá en lo esencial, no al 100 %. Mock servers, monitores y flujos cloud de Postman quedan fuera.

## 8. Cuentas, equipos y seguridad

- **Registro y login:** email + contraseña (Argon2id), inicio con Google/GitHub (OAuth), recuperación de contraseña, 2FA opcional (TOTP).
- **Sesiones:** JWT de corta duración + refresh token rotativo, por dispositivo y revocable.
- **Workspaces:** personales y de equipo, miembros ilimitados; roles `owner`, `admin`, `editor`, `viewer`; invitaciones por email o enlace con caducidad.
- **Secretos:** las variables marcadas como secretas pueden (a) quedarse solo en el dispositivo (guardadas en el keychain del sistema) o (b) guardarse cifradas en el servidor para compartirlas con el equipo, según elija el administrador del workspace.
- **Servidor:** límites de tasa (rate limiting), validación estricta de entrada, protección contra fuerza bruta, cabeceras de seguridad, logs sin datos sensibles, dependencias auditadas (`cargo audit`).
- **Sandbox de scripts:** sin acceso a archivos ni red del sistema, con tiempo y memoria limitados.
- **Backups:** respaldo automático de Postgres con restauración probada periódicamente.

## 9. Docker y despliegue

Todo el servicio se levanta con:

```bash
cp deploy/.env.example deploy/.env   # configurar dominio y secretos
docker compose -f deploy/docker-compose.yml up -d
```

| Servicio | Función |
|---|---|
| `api` | Servidor Rust (REST + WebSocket) |
| `postgres` | Base de datos, con volumen persistente |
| `redis` | Pub/sub de tiempo real |
| `minio` | Archivos (opcional al inicio) |
| `caddy` | Proxy inverso con HTTPS automático |
| `migrate` | Ejecuta migraciones antes de iniciar la API |
| `backup` | Respaldos programados |

**Reglas:**
- Dockerfile **multi-etapa** (compilar con Rust, copiar solo el binario a una imagen mínima).
- **Healthchecks** en todos los servicios; la API espera a Postgres y Redis.
- Configuración en un único `.env` (nunca en Git; mantener `.env.example`).
- Solo Caddy expone los puertos 80 y 443; Postgres, Redis y MinIO quedan en red interna.
- Volúmenes nombrados para Postgres, Redis y MinIO.
- `docker-compose.dev.yml` con recarga automática y herramientas de desarrollo.
- Actualización: `docker compose pull && docker compose up -d` (migraciones automáticas).
- Imágenes versionadas con etiquetas para poder volver a una versión anterior.
- **Requisitos mínimos del servidor:** VPS Linux, 2 vCPU y 4 GB de RAM, Docker + Compose, dominio apuntando al servidor.
- La app de escritorio **no** va en Docker: se compila en CI y se distribuye como instalador.

## 10. Plan por fases

> Estimación para una sola persona. Total aproximado: **5 a 7 meses** para una versión 1.0 sólida.

### Fase 0: Preparación (3-5 días)
- [x] Crear el repositorio y el monorepo con la estructura de la sección 4.
- [x] Instalar toolchain: Rust, Node, requisitos de Tauri (WebView2 y Build Tools de C++ en Windows).
- [x] Proyecto base de Tauri 2 + React + TypeScript.
- [x] Dockerfile de la API y `docker-compose.dev.yml` con API, Postgres, Redis y Caddy.
- [x] Linters y formato (`clippy`, `rustfmt`, ESLint, Prettier), `.editorconfig`.
- [x] CI básico en GitHub Actions: compilar, lint y tests.
- [x] `README.md`, `LICENSE`, `CONTRIBUTING.md`, `.gitignore`, `.env.example`.
- **Entregable:** `docker compose up` levanta el backend base y la app de escritorio abre una ventana.

### Fase 1: Núcleo de requests (2 semanas)
- [x] Comando Rust con `reqwest`: envía el request y devuelve status, headers, body, tiempos y tamaño.
- [x] UI: método, URL, pestañas de Params, Headers y Body (JSON, form-data, urlencoded, raw).
- [x] Visor de respuesta: Body formateado, Headers, Cookies y Timeline.
- [x] Cancelar peticiones; errores claros (DNS, timeout, TLS).
- [x] Varias pestañas abiertas a la vez.
- **Entregable:** se envían requests reales y se ve la respuesta.

### Fase 2: Modelo local (2 semanas)
- [x] Colecciones, carpetas y requests con crear, renombrar, mover, duplicar y borrar.
- [x] Almacenamiento en SQLite local.
- [x] Entornos y variables (`{{variable}}`), con autocompletado y resolución.
- [x] Historial de requests.
- [x] Autenticación: Bearer, Basic, API Key (OAuth 2.0 en la fase 7).
- **Entregable:** herramienta usable de forma local.

### Fase 3: Compatibilidad con Postman (1-2 semanas)
- [x] Importar Collection v2.1/v2.0, Environments y Globals.
- [x] Exportar a Collection v2.1 y Environments.
- [x] Importar OpenAPI y cURL.
- [x] Pruebas de ida y vuelta con colecciones de ejemplo.
- [x] Generar código desde un request (cURL, fetch, Python, etc.).
- [x] Herencia de auth (request → carpeta → colección) y ajustes de colección/carpeta (variables, auth, scripts). Adelantado a pedido.
- [x] Scripts pre-request y post-response en QuickJS con `pm.*` esencial, tests y consola. Adelantado desde la Fase 7.

### Fase 4: Servidor y cuentas (2-3 semanas)
- [ ] API Axum con migraciones, errores uniformes y documentación (OpenAPI).
- [ ] Registro, login, refresh tokens, sesiones por dispositivo y cierre remoto.
- [ ] Recuperación de contraseña y OAuth (Google/GitHub); 2FA opcional.
- [ ] Workspaces (crear, listar, renombrar, borrar).
- [ ] Inicio de sesión en el cliente y descarga de los workspaces del usuario.
- **Entregable:** iniciar sesión desde otra computadora y ver tus workspaces.

### Fase 5: Sincronización en tiempo real (3-4 semanas)
- [ ] Protocolo de sync (crate `sync-protocol`): mensajes, HLC, secuencias.
- [ ] `change_log` en el servidor y WebSocket autenticado.
- [ ] Cola offline en el cliente y puesta al día al reconectar.
- [ ] Resolución de conflictos por campo y borrados lógicos.
- [ ] Redis pub/sub para varias instancias.
- [ ] Pruebas de concurrencia, corte de red y desorden de mensajes.
- **Entregable:** un cambio en una computadora aparece en otra al instante, sin recargar.

### Fase 6: Equipos y colaboración (2 semanas)
- [ ] Miembros y roles con permisos aplicados en servidor y cliente.
- [ ] Invitaciones por email y por enlace con caducidad.
- [ ] Presencia (quién está conectado y qué abrió).
- [ ] Gestión de miembros (cambiar rol, quitar).

### Fase 7: Scripts, tests y OAuth (3 semanas)
- [x] Sandbox QuickJS con API `pm.*` (`pm.test`, `pm.environment`, `pm.response`, etc.). Hecho en la Fase 3.
- [x] Scripts pre-request y post-response, con consola. Hecho en la Fase 3.
- [x] Panel de resultados de tests. Hecho en la Fase 3.
- [ ] Collection runner y más cobertura de `pm.*` (`pm.sendRequest`, `pm.cookies`, body de `pm.request`).
- [ ] OAuth 2.0 (client credentials, authorization code con PKCE).

### Fase 8: Versiones, secretos y auditoría (2 semanas)
- [ ] Historial de versiones y restauración.
- [ ] Secretos locales y compartidos cifrados.
- [ ] Registro de actividad por workspace.

### Fase 9: Producción (2-3 semanas)
- [ ] Imagen de producción, `docker-compose.yml` final y script de instalación.
- [ ] Backups automáticos y restauración probada.
- [ ] Pruebas de carga (muchos usuarios y WebSockets).
- [ ] Logs y monitoreo (Prometheus + Grafana opcional).
- [ ] Temas claro/oscuro, atajos de teclado, búsqueda global.
- [ ] Instaladores firmados y actualizaciones automáticas (Tauri updater).
- [ ] Documentación de usuario y de despliegue.

### Fase 10: Futuro (opcional)
GraphQL, WebSocket y gRPC como tipos de request; CRDT para edición simultánea de scripts; mock servers; app móvil o web.

## 11. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Sincronización y conflictos | Protocolo diseñado primero, pruebas de concurrencia desde la fase 5, simulador de redes inestables |
| Seguridad del servidor autohospedado | Argon2id, rate limiting, `cargo audit`, red interna en Docker, revisión antes de producción |
| Compatibilidad parcial con Postman | Fixtures de prueba y límites documentados |
| Sandbox de scripts | QuickJS aislado con límites; sin acceso a sistema de archivos |
| Diferencias de WebView entre sistemas | Probar en Windows, macOS y Linux desde las primeras fases |
| Costos de infraestructura | Dimensionar según uso; backups a almacenamiento barato |
| Querer igualar todo Postman | Respetar el alcance del MVP y avanzar por fases |

## 12. Criterios de aceptación de la versión 1.0

- [ ] `docker compose up -d` levanta todo el servicio en un VPS limpio.
- [ ] Una persona inicia sesión en otra computadora y ve sus workspaces.
- [ ] Un cambio de una persona aparece a otra en menos de ~1 segundo.
- [ ] Funciona sin internet y sincroniza al reconectar sin perder cambios.
- [ ] Una colección de Postman se importa, se exporta y se vuelve a importar sin pérdidas relevantes.
- [ ] Se puede invitar a más de 50 miembros a un workspace sin restricciones.
- [ ] El instalador pesa decenas de MB (no cientos) y la app arranca en pocos segundos.
- [ ] Hay backups automáticos con restauración probada.

## 13. Siguientes pasos en GitHub

1. Crear el repositorio y subir este archivo como `PLAN.md`.
2. Crear un **milestone** por fase (Fase 0 … Fase 9).
3. Convertir cada casilla `- [ ]` en un **issue** y asignarlo a su milestone.
4. Crear un tablero (GitHub Projects) con columnas: Backlog, En curso, En revisión, Hecho.
5. Proteger la rama `main` y exigir que pase el CI antes de fusionar.
6. Empezar por la **Fase 0**.
