use axum::{Json, Router, routing::get};
use endpilot_core::Health;
use sqlx::PgPool;
use std::sync::Arc;
use tracing_subscriber::EnvFilter;

mod auth;
mod error;
#[cfg(test)]
mod tests;
mod workspaces;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub keys: Arc<auth::Keys>,
    /// `ALLOW_REGISTRATION=false` closes sign-up once the team's accounts exist.
    pub allow_registration: bool,
}

fn app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { Json(Health::ok()) }))
        .merge(auth::routes())
        .merge(workspaces::routes())
        .with_state(state)
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("falta la variable de entorno {name}"))
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let secret = env("JWT_SECRET");
    assert!(
        secret.len() >= 32,
        "JWT_SECRET debe tener al menos 32 caracteres"
    );
    let db = PgPool::connect(&env("DATABASE_URL"))
        .await
        .expect("cannot connect to Postgres");
    sqlx::migrate!().run(&db).await.expect("migrations failed");
    let state = AppState {
        db,
        keys: Arc::new(auth::Keys::new(secret.as_bytes())),
        allow_registration: std::env::var("ALLOW_REGISTRATION").map_or(true, |v| v != "false"),
    };

    let addr = std::env::var("API_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("cannot bind {addr}: {e}"));
    tracing::info!("listening on {addr}");

    // ConnectInfo: login rate limits need the TCP peer address.
    axum::serve(
        listener,
        app(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        tokio::signal::ctrl_c().await.ok();
    })
    .await
    .expect("server error");
}
