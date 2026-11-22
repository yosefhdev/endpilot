//! Accounts and device sessions.
//!
//! - Passwords: Argon2id.
//! - Access token: JWT (HS256, 15 min) that names the user and the session. Every request
//!   also checks the session row, so revoking a device takes effect at once.
//! - Refresh token: 32 random bytes, stored as a SHA-256 hash, rotated on every use.
//!   Reusing an already rotated token revokes the whole session (it was stolen).

use argon2::Argon2;
use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use axum::extract::rejection::JsonRejection;
use axum::extract::{ConnectInfo, FromRequestParts, Path, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode};
use axum::{Json, Router, routing};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::net::{IpAddr, SocketAddr};
use std::sync::LazyLock;
use uuid::Uuid;

use crate::AppState;
use crate::error::{ApiError, ApiResult};

const ACCESS_TTL_SECS: i64 = 15 * 60;
/// A device that doesn't refresh for this long has to sign in again.
const REFRESH_IDLE_DAYS: i32 = 30;

/// Failed logins allowed in the window: one email from one IP, one email from
/// anywhere (spoofed IPs), one IP across emails (credential stuffing).
const FAILED_LOGINS_PER_EMAIL_IP: i64 = 5;
const FAILED_LOGINS_PER_EMAIL: i64 = 20;
const FAILED_LOGINS_PER_IP: i64 = 50;
const FAILED_LOGIN_WINDOW_MINS: i32 = 15;
/// Sign-ups hash a password each, so they are rate limited too.
const REGISTRATIONS_PER_IP_PER_HOUR: i64 = 10;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/register", routing::post(register))
        .route("/auth/login", routing::post(login))
        .route("/auth/refresh", routing::post(refresh))
        .route("/auth/logout", routing::post(logout))
        .route("/me", routing::get(me))
        .route("/sessions", routing::get(list_sessions))
        .route("/sessions/{id}", routing::delete(revoke_session))
}

pub struct Keys {
    encoding: EncodingKey,
    decoding: DecodingKey,
}

impl Keys {
    /// Panics on an empty secret; main checks its length first.
    pub fn new(secret: &[u8]) -> Self {
        Self {
            encoding: EncodingKey::from_secret(secret).expect("JWT secret"),
            decoding: DecodingKey::from_secret(secret).expect("JWT secret"),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Claims {
    sub: Uuid,
    sid: Uuid,
    exp: i64,
}

/// The signed-in user of a request. Rejects with 401 if the token is bad,
/// expired, or its session was revoked.
pub struct AuthUser {
    pub user_id: Uuid,
    pub session_id: Uuid,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> ApiResult<Self> {
        let token = parts
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or(ApiError::Unauthorized("unauthenticated"))?;
        let claims =
            jsonwebtoken::decode::<Claims>(token, &state.keys.decoding, &Validation::default())
                .map_err(|_| ApiError::Unauthorized("unauthenticated"))?
                .claims;
        let live: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL)",
        )
        .bind(claims.sid)
        .bind(claims.sub)
        .fetch_one(&state.db)
        .await?;
        if !live {
            return Err(ApiError::Unauthorized("unauthenticated"));
        }
        Ok(Self {
            user_id: claims.sub,
            session_id: claims.sid,
        })
    }
}

#[derive(Serialize, sqlx::FromRow)]
pub struct User {
    pub id: Uuid,
    pub email: String,
    pub name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterBody {
    email: String,
    name: String,
    password: String,
    device_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginBody {
    email: String,
    password: String,
    device_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshBody {
    refresh_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Tokens {
    access_token: String,
    refresh_token: String,
    /// Seconds until `access_token` expires.
    expires_in: i64,
    user: User,
}

fn validate_email(email: &str) -> ApiResult<String> {
    let email = email.trim();
    let ok = email.len() <= 254
        && email
            .split_once('@')
            .is_some_and(|(user, domain)| !user.is_empty() && domain.contains('.'));
    if !ok {
        return Err(ApiError::invalid("El email no es válido."));
    }
    Ok(email.to_owned())
}

fn validate_text(value: &str, what: &str) -> ApiResult<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 100 {
        return Err(ApiError::invalid(format!(
            "{what} debe tener entre 1 y 100 caracteres."
        )));
    }
    Ok(value.to_owned())
}

fn validate_password(password: &str) -> ApiResult<()> {
    // Upper bound keeps Argon2 from hashing megabytes on purpose.
    if !(8..=128).contains(&password.chars().count()) {
        return Err(ApiError::invalid(
            "La contraseña debe tener entre 8 y 128 caracteres.",
        ));
    }
    Ok(())
}

/// Argon2 is slow on purpose, so it runs off the async threads.
async fn hash_password(password: String) -> ApiResult<String> {
    tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(password.as_bytes())
            .map(|h| h.to_string())
            .map_err(|e| ApiError::Internal(format!("argon2: {e}")))
    })
    .await
    .map_err(|e| ApiError::Internal(e.to_string()))?
}

async fn verify_password(password: String, hash: String) -> ApiResult<bool> {
    tokio::task::spawn_blocking(move || {
        let parsed =
            PasswordHash::new(&hash).map_err(|e| ApiError::Internal(format!("argon2: {e}")))?;
        Ok(Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok())
    })
    .await
    .map_err(|e| ApiError::Internal(e.to_string()))?
}

/// Verified against when the email doesn't exist, so both cases take as long
/// and response time doesn't reveal which emails have accounts.
static DUMMY_HASH: LazyLock<String> = LazyLock::new(|| {
    Argon2::default()
        .hash_password(b"not-a-real-password")
        .expect("argon2")
        .to_string()
});

fn new_refresh_token() -> ApiResult<(String, Vec<u8>)> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| ApiError::Internal(format!("rng: {e}")))?;
    let token = URL_SAFE_NO_PAD.encode(bytes);
    let hash = token_hash(&token);
    Ok((token, hash))
}

fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

fn tokens(state: &AppState, user: User, session_id: Uuid, refresh: String) -> ApiResult<Tokens> {
    let claims = Claims {
        sub: user.id,
        sid: session_id,
        exp: Utc::now().timestamp() + ACCESS_TTL_SECS,
    };
    let access_token = jsonwebtoken::encode(&Header::default(), &claims, &state.keys.encoding)
        .map_err(|e| ApiError::Internal(format!("jwt: {e}")))?;
    Ok(Tokens {
        access_token,
        refresh_token: refresh,
        expires_in: ACCESS_TTL_SECS,
        user,
    })
}

async fn start_session(
    state: &AppState,
    executor: impl sqlx::PgExecutor<'_>,
    user: User,
    device_name: &str,
) -> ApiResult<Tokens> {
    let (refresh, hash) = new_refresh_token()?;
    let session_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO sessions (id, user_id, device_name, refresh_hash) VALUES ($1, $2, $3, $4)",
    )
    .bind(session_id)
    .bind(user.id)
    .bind(device_name)
    .bind(hash)
    .execute(executor)
    .await?;
    tokens(state, user, session_id, refresh)
}

/// The client's address. Behind Caddy the TCP peer is the proxy, so its
/// X-Forwarded-For (which Caddy rewrites) is used, but only when the peer is on a
/// private network: a client reaching the API port directly can't pick its own key.
/// shortcut: any private-network peer is trusted as a proxy; add a TRUSTED_PROXIES list if the API ever shares a LAN with clients.
pub(crate) fn client_ip(peer: SocketAddr, headers: &HeaderMap) -> String {
    let trusted = match peer.ip() {
        IpAddr::V4(ip) => ip.is_loopback() || ip.is_private(),
        IpAddr::V6(ip) => ip.is_loopback() || ip.is_unique_local(),
    };
    let forwarded = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit(',').next())
        .and_then(|ip| ip.trim().parse::<IpAddr>().ok());
    match forwarded {
        Some(ip) if trusted => ip.to_string(),
        _ => peer.ip().to_string(),
    }
}

/// Records an attempt *before* checking the limit, so concurrent requests can't all
/// slip past a check that hasn't seen each other yet. Returns the row id.
async fn reserve_attempt(state: &AppState, kind: &str, email: &str, ip: &str) -> ApiResult<i64> {
    sqlx::query("DELETE FROM auth_attempts WHERE attempted_at < now() - interval '1 day'")
        .execute(&state.db)
        .await?;
    let id = sqlx::query_scalar(
        "INSERT INTO auth_attempts (kind, email, ip) VALUES ($1, lower($2), $3) RETURNING id",
    )
    .bind(kind)
    .bind(email)
    .bind(ip)
    .fetch_one(&state.db)
    .await?;
    Ok(id)
}

/// Drops a reserved attempt: blocked requests don't extend their own block.
async fn release_attempt(state: &AppState, id: i64) -> ApiResult<()> {
    sqlx::query("DELETE FROM auth_attempts WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// Whether recent failed logins (this one included) are over any limit.
async fn too_many_logins(state: &AppState, email: &str, ip: &str) -> ApiResult<bool> {
    let (email_ip, by_email, by_ip): (i64, i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE email = lower($1) AND ip = $2),
                count(*) FILTER (WHERE email = lower($1)),
                count(*) FILTER (WHERE ip = $2)
         FROM auth_attempts
         WHERE kind = 'login_failed' AND attempted_at > now() - make_interval(mins => $3)
           AND (email = lower($1) OR ip = $2)",
    )
    .bind(email)
    .bind(ip)
    .bind(FAILED_LOGIN_WINDOW_MINS)
    .fetch_one(&state.db)
    .await?;
    Ok(email_ip > FAILED_LOGINS_PER_EMAIL_IP
        || by_email > FAILED_LOGINS_PER_EMAIL
        || by_ip > FAILED_LOGINS_PER_IP)
}

async fn register(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Result<Json<RegisterBody>, JsonRejection>,
) -> ApiResult<(StatusCode, Json<Tokens>)> {
    if !state.allow_registration {
        return Err(ApiError::RegistrationClosed);
    }
    let Json(body) = body?;
    let ip = client_ip(peer, &headers);
    let attempt = reserve_attempt(&state, "register", body.email.trim(), &ip).await?;
    let recent: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM auth_attempts
         WHERE kind = 'register' AND ip = $1 AND attempted_at > now() - interval '1 hour'",
    )
    .bind(&ip)
    .fetch_one(&state.db)
    .await?;
    if recent > REGISTRATIONS_PER_IP_PER_HOUR {
        release_attempt(&state, attempt).await?;
        return Err(ApiError::TooManyAttempts);
    }
    let email = validate_email(&body.email)?;
    let name = validate_text(&body.name, "El nombre")?;
    let device = validate_text(&body.device_name, "El nombre del dispositivo")?;
    validate_password(&body.password)?;
    let password_hash = hash_password(body.password).await?;

    let mut tx = state.db.begin().await?;
    let user = User {
        id: Uuid::now_v7(),
        email,
        name,
    };
    let inserted = sqlx::query(
        "INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING",
    )
    .bind(user.id)
    .bind(&user.email)
    .bind(&user.name)
    .bind(password_hash)
    .execute(&mut *tx)
    .await?;
    if inserted.rows_affected() == 0 {
        return Err(ApiError::Conflict(
            "email_taken",
            "Ya existe una cuenta con ese email.".into(),
        ));
    }
    crate::workspaces::create_personal(&mut tx, user.id).await?;
    let tokens = start_session(&state, &mut *tx, user, &device).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(tokens)))
}

async fn login(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Result<Json<LoginBody>, JsonRejection>,
) -> ApiResult<Json<Tokens>> {
    let Json(body) = body?;
    let device = validate_text(&body.device_name, "El nombre del dispositivo")?;
    let ip = client_ip(peer, &headers);
    let email_key = body.email.trim().to_owned();
    // Counted as a failure until it succeeds. Checked before hashing, so a blocked
    // attacker can't keep the CPU busy either.
    let attempt = reserve_attempt(&state, "login_failed", &email_key, &ip).await?;
    if too_many_logins(&state, &email_key, &ip).await? {
        release_attempt(&state, attempt).await?;
        return Err(ApiError::TooManyAttempts);
    }
    let row: Option<(Uuid, String, String, String)> = sqlx::query_as(
        "SELECT id, email, name, password_hash FROM users WHERE lower(email) = lower($1)",
    )
    .bind(body.email.trim())
    .fetch_optional(&state.db)
    .await?;
    let hash = row
        .as_ref()
        .map_or_else(|| DUMMY_HASH.clone(), |r| r.3.clone());
    let ok = verify_password(body.password, hash).await?;
    let Some((id, email, name, _)) = row.filter(|_| ok) else {
        // The reserved row stays, whether or not the account exists, so blocking reveals nothing.
        return Err(ApiError::Unauthorized("invalid_credentials"));
    };
    // The owner got in: clear the account's failures from every address.
    sqlx::query("DELETE FROM auth_attempts WHERE kind = 'login_failed' AND email = lower($1)")
        .bind(&email_key)
        .execute(&state.db)
        .await?;
    let tokens = start_session(&state, &state.db, User { id, email, name }, &device).await?;
    Ok(Json(tokens))
}

async fn refresh(
    State(state): State<AppState>,
    body: Result<Json<RefreshBody>, JsonRejection>,
) -> ApiResult<Json<Tokens>> {
    let Json(body) = body?;
    let old = token_hash(&body.refresh_token);
    let (new_token, new_hash) = new_refresh_token()?;
    let rotated: Option<(Uuid, Uuid, String, String)> = sqlx::query_as(
        "UPDATE sessions s SET prev_hash = s.refresh_hash, refresh_hash = $2, last_used_at = now()
         FROM users u
         WHERE s.refresh_hash = $1 AND s.revoked_at IS NULL AND u.id = s.user_id
           AND s.last_used_at > now() - make_interval(days => $3)
         RETURNING s.id, u.id, u.email, u.name",
    )
    .bind(&old)
    .bind(new_hash)
    .bind(REFRESH_IDLE_DAYS)
    .fetch_optional(&state.db)
    .await?;
    let Some((session_id, id, email, name)) = rotated else {
        // An old token coming back means someone else has it: end that session.
        // shortcut: two refreshes racing from the same device also trip this; the client refreshes one at a time.
        sqlx::query(
            "UPDATE sessions SET revoked_at = now() WHERE prev_hash = $1 AND revoked_at IS NULL",
        )
        .bind(&old)
        .execute(&state.db)
        .await?;
        return Err(ApiError::Unauthorized("unauthenticated"));
    };
    Ok(Json(tokens(
        &state,
        User { id, email, name },
        session_id,
        new_token,
    )?))
}

async fn logout(State(state): State<AppState>, auth: AuthUser) -> ApiResult<StatusCode> {
    sqlx::query("UPDATE sessions SET revoked_at = now() WHERE id = $1")
        .bind(auth.session_id)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn me(State(state): State<AppState>, auth: AuthUser) -> ApiResult<Json<User>> {
    let user = sqlx::query_as("SELECT id, email, name FROM users WHERE id = $1")
        .bind(auth.user_id)
        .fetch_one(&state.db)
        .await?;
    Ok(Json(user))
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct Session {
    id: Uuid,
    device_name: String,
    created_at: DateTime<Utc>,
    last_used_at: DateTime<Utc>,
    #[sqlx(skip)]
    current: bool,
}

async fn list_sessions(
    State(state): State<AppState>,
    auth: AuthUser,
) -> ApiResult<Json<Vec<Session>>> {
    let mut sessions: Vec<Session> = sqlx::query_as(
        "SELECT id, device_name, created_at, last_used_at FROM sessions
         WHERE user_id = $1 AND revoked_at IS NULL ORDER BY last_used_at DESC",
    )
    .bind(auth.user_id)
    .fetch_all(&state.db)
    .await?;
    for s in &mut sessions {
        s.current = s.id == auth.session_id;
    }
    Ok(Json(sessions))
}

/// Signs a device out remotely. Its next request gets 401.
async fn revoke_session(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let done = sqlx::query(
        "UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
    )
    .bind(id)
    .bind(auth.user_id)
    .execute(&state.db)
    .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}
