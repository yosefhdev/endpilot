use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

/// Every error the API returns: `{"error": {"code": "...", "message": "..."}}`.
/// `code` is stable for the client; `message` is for people (Spanish, like the UI).
#[derive(Debug)]
pub enum ApiError {
    BadRequest(&'static str, String),
    Unauthorized(&'static str),
    Forbidden,
    NotFound,
    Conflict(&'static str, String),
    Internal(String),
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::BadRequest("invalid_input", message.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            Self::BadRequest(code, m) => (StatusCode::BAD_REQUEST, code, m),
            Self::Unauthorized(code) => (
                StatusCode::UNAUTHORIZED,
                code,
                match code {
                    "invalid_credentials" => "Email o contraseña incorrectos.",
                    _ => "Tu sesión expiró. Inicia sesión de nuevo.",
                }
                .into(),
            ),
            Self::Forbidden => (
                StatusCode::FORBIDDEN,
                "forbidden",
                "No tienes permiso para hacer esto.".into(),
            ),
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found", "No existe.".into()),
            Self::Conflict(code, m) => (StatusCode::CONFLICT, code, m),
            Self::Internal(detail) => {
                // Details go to the log, never to the client.
                tracing::error!("{detail}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "Error interno del servidor.".into(),
                )
            }
        };
        (
            status,
            Json(json!({ "error": { "code": code, "message": message } })),
        )
            .into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        Self::Internal(format!("database: {e}"))
    }
}

/// Bad JSON bodies get the same error shape as everything else.
impl From<axum::extract::rejection::JsonRejection> for ApiError {
    fn from(e: axum::extract::rejection::JsonRejection) -> Self {
        Self::BadRequest("invalid_body", e.body_text())
    }
}
