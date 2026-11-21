//! Workspaces the user belongs to. Each account gets a personal one at sign-up.

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Json, Router, routing};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::AppState;
use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/workspaces", routing::get(list).post(create))
        .route("/workspaces/{id}", routing::patch(rename).delete(remove))
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    id: Uuid,
    name: String,
    /// `personal` or `team`.
    kind: String,
    /// The caller's role: `owner`, `admin`, `editor` or `viewer`.
    role: String,
    created_at: DateTime<Utc>,
}

#[derive(Deserialize)]
struct NameBody {
    name: String,
}

/// The caller's workspaces; `$1` is the user id. A macro so the SQL stays a constant.
macro_rules! select {
    ($tail:literal) => {
        concat!(
            "SELECT w.id, w.name, w.kind, m.role, w.created_at
             FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
             WHERE m.user_id = $1 AND w.deleted_at IS NULL ",
            $tail
        )
    };
}

fn validate_name(name: &str) -> ApiResult<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(ApiError::invalid(
            "El nombre debe tener entre 1 y 100 caracteres.",
        ));
    }
    Ok(name.to_owned())
}

pub async fn create_personal(tx: &mut sqlx::PgConnection, user_id: Uuid) -> ApiResult<()> {
    insert(tx, user_id, "Personal", "personal").await.map(drop)
}

async fn insert(
    tx: &mut sqlx::PgConnection,
    user_id: Uuid,
    name: &str,
    kind: &str,
) -> ApiResult<Uuid> {
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO workspaces (id, name, kind, owner_id) VALUES ($1, $2, $3, $4)")
        .bind(id)
        .bind(name)
        .bind(kind)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
    )
    .bind(id)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    Ok(id)
}

/// The caller's workspace, or 404 if they aren't a member (don't reveal it exists).
async fn find(state: &AppState, user_id: Uuid, id: Uuid) -> ApiResult<Workspace> {
    sqlx::query_as(select!("AND w.id = $2"))
        .bind(user_id)
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(ApiError::NotFound)
}

async fn list(State(state): State<AppState>, auth: AuthUser) -> ApiResult<Json<Vec<Workspace>>> {
    // Personal first, then by creation (UUID v7 ids sort by time).
    let rows = sqlx::query_as(select!("ORDER BY w.kind = 'team', w.id"))
        .bind(auth.user_id)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(rows))
}

async fn create(
    State(state): State<AppState>,
    auth: AuthUser,
    body: Result<Json<NameBody>, JsonRejection>,
) -> ApiResult<(StatusCode, Json<Workspace>)> {
    let Json(body) = body?;
    let name = validate_name(&body.name)?;
    let mut tx = state.db.begin().await?;
    let id = insert(&mut tx, auth.user_id, &name, "team").await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(find(&state, auth.user_id, id).await?),
    ))
}

async fn rename(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
    body: Result<Json<NameBody>, JsonRejection>,
) -> ApiResult<Json<Workspace>> {
    let Json(body) = body?;
    let name = validate_name(&body.name)?;
    let ws = find(&state, auth.user_id, id).await?;
    if !matches!(ws.role.as_str(), "owner" | "admin") {
        return Err(ApiError::Forbidden);
    }
    sqlx::query("UPDATE workspaces SET name = $2 WHERE id = $1")
        .bind(id)
        .bind(&name)
        .execute(&state.db)
        .await?;
    Ok(Json(Workspace { name, ..ws }))
}

/// Soft delete, so a later sync can tell clients it's gone.
async fn remove(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let ws = find(&state, auth.user_id, id).await?;
    if ws.role != "owner" {
        return Err(ApiError::Forbidden);
    }
    if ws.kind == "personal" {
        return Err(ApiError::BadRequest(
            "personal_workspace",
            "El workspace personal no se puede borrar.".into(),
        ));
    }
    sqlx::query("UPDATE workspaces SET deleted_at = now() WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
