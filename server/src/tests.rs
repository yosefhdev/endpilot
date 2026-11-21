//! API tests against a real Postgres. `sqlx::test` creates a fresh database per test
//! (needs DATABASE_URL; locally: `docker compose -f deploy/docker-compose.dev.yml up -d postgres`).

use super::*;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

struct Api(Router);

impl Api {
    fn new(db: PgPool) -> Self {
        Self(app(AppState {
            db,
            keys: Arc::new(auth::Keys::new(&[7; 32])),
        }))
    }

    async fn call(
        &self,
        method: Method,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut req = Request::builder().method(method).uri(uri);
        if let Some(t) = token {
            req = req.header("authorization", format!("Bearer {t}"));
        }
        let req = match body {
            Some(b) => req
                .header("content-type", "application/json")
                .body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .unwrap();
        let res = self.0.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn register(&self, email: &str) -> Value {
        let (status, body) = self
            .call(
                Method::POST,
                "/auth/register",
                None,
                Some(json!({ "email": email, "name": "Ana", "password": "correcta-123", "deviceName": "Laptop" })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        body
    }

    async fn login(&self, email: &str, password: &str, device: &str) -> (StatusCode, Value) {
        self.call(
            Method::POST,
            "/auth/login",
            None,
            Some(json!({ "email": email, "password": password, "deviceName": device })),
        )
        .await
    }
}

fn token(v: &Value) -> &str {
    v["accessToken"].as_str().unwrap()
}

#[sqlx::test]
async fn health_returns_ok(db: PgPool) {
    let (status, body) = Api::new(db).call(Method::GET, "/health", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        serde_json::from_value::<Health>(body).unwrap(),
        Health::ok()
    );
}

#[sqlx::test]
async fn register_then_login_from_another_device(db: PgPool) {
    let api = Api::new(db);
    let reg = api.register("ana@example.com").await;
    assert_eq!(reg["user"]["email"], "ana@example.com");

    // Email is case-insensitive, and the personal workspace is there from the other device.
    let (status, login) = api
        .login("ANA@example.com", "correcta-123", "Desktop")
        .await;
    assert_eq!(status, StatusCode::OK, "{login}");
    let (_, ws) = api
        .call(Method::GET, "/workspaces", Some(token(&login)), None)
        .await;
    assert_eq!(ws[0]["name"], "Personal");
    assert_eq!(ws[0]["kind"], "personal");
    assert_eq!(ws[0]["role"], "owner");

    let (_, me) = api
        .call(Method::GET, "/me", Some(token(&login)), None)
        .await;
    assert_eq!(me["name"], "Ana");
}

#[sqlx::test]
async fn bad_input_and_duplicates(db: PgPool) {
    let api = Api::new(db);
    api.register("ana@example.com").await;

    let (status, body) = api
        .call(
            Method::POST,
            "/auth/register",
            None,
            Some(json!({ "email": "Ana@Example.com", "name": "Otra", "password": "correcta-123", "deviceName": "X" })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["code"], "email_taken");

    for (email, password) in [("no-es-email", "correcta-123"), ("b@example.com", "corta")] {
        let (status, body) = api
            .call(
                Method::POST,
                "/auth/register",
                None,
                Some(
                    json!({ "email": email, "name": "B", "password": password, "deviceName": "X" }),
                ),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "invalid_input");
    }

    let (status, body) = api
        .call(
            Method::POST,
            "/auth/login",
            None,
            Some(json!({ "email": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "invalid_body");
}

#[sqlx::test]
async fn wrong_password_and_unknown_email_look_the_same(db: PgPool) {
    let api = Api::new(db);
    api.register("ana@example.com").await;
    let a = api.login("ana@example.com", "incorrecta", "X").await;
    let b = api.login("nadie@example.com", "incorrecta", "X").await;
    assert_eq!(a.0, StatusCode::UNAUTHORIZED);
    assert_eq!(a, b);
    assert_eq!(a.1["error"]["code"], "invalid_credentials");
}

#[sqlx::test]
async fn requests_without_a_valid_token_are_rejected(db: PgPool) {
    let api = Api::new(db);
    for token in [None, Some("basura")] {
        let (status, body) = api.call(Method::GET, "/workspaces", token, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"]["code"], "unauthenticated");
    }
}

#[sqlx::test]
async fn refresh_rotates_and_reuse_revokes_the_session(db: PgPool) {
    let api = Api::new(db);
    let reg = api.register("ana@example.com").await;
    let first = reg["refreshToken"].clone();

    let (status, second) = api
        .call(
            Method::POST,
            "/auth/refresh",
            None,
            Some(json!({ "refreshToken": first })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(second["refreshToken"], first);
    assert_eq!(second["user"]["email"], "ana@example.com");

    // The old token comes back (stolen): the session ends, so the new tokens die too.
    let (status, _) = api
        .call(
            Method::POST,
            "/auth/refresh",
            None,
            Some(json!({ "refreshToken": first })),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = api
        .call(
            Method::POST,
            "/auth/refresh",
            None,
            Some(json!({ "refreshToken": second["refreshToken"] })),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = api
        .call(Method::GET, "/me", Some(token(&second)), None)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[sqlx::test]
async fn sessions_can_be_listed_and_revoked_remotely(db: PgPool) {
    let api = Api::new(db);
    let laptop = api.register("ana@example.com").await;
    let (_, desktop) = api
        .login("ana@example.com", "correcta-123", "Desktop")
        .await;

    let (_, sessions) = api
        .call(Method::GET, "/sessions", Some(token(&laptop)), None)
        .await;
    let sessions = sessions.as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    let other = sessions.iter().find(|s| s["current"] == false).unwrap();
    assert_eq!(other["deviceName"], "Desktop");

    let uri = format!("/sessions/{}", other["id"].as_str().unwrap());
    let (status, _) = api
        .call(Method::DELETE, &uri, Some(token(&laptop)), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // The desktop's still-unexpired access token stops working right away.
    let (status, _) = api
        .call(Method::GET, "/workspaces", Some(token(&desktop)), None)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = api
        .call(
            Method::POST,
            "/auth/refresh",
            None,
            Some(json!({ "refreshToken": desktop["refreshToken"] })),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Logout ends the current session.
    let (status, _) = api
        .call(Method::POST, "/auth/logout", Some(token(&laptop)), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = api
        .call(Method::GET, "/me", Some(token(&laptop)), None)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[sqlx::test]
async fn workspace_crud_and_permissions(db: PgPool) {
    let api = Api::new(db);
    let ana = api.register("ana@example.com").await;
    let ana = token(&ana);
    let bob = api.register("bob@example.com").await;
    let bob = token(&bob);

    let (status, ws) = api
        .call(
            Method::POST,
            "/workspaces",
            Some(ana),
            Some(json!({ "name": "  Equipo API " })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(ws["name"], "Equipo API");
    assert_eq!(ws["kind"], "team");
    let uri = format!("/workspaces/{}", ws["id"].as_str().unwrap());

    let (status, renamed) = api
        .call(
            Method::PATCH,
            &uri,
            Some(ana),
            Some(json!({ "name": "Backend" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(renamed["name"], "Backend");

    // Bob isn't a member: it doesn't exist for him.
    let (status, _) = api
        .call(
            Method::PATCH,
            &uri,
            Some(bob),
            Some(json!({ "name": "Mío" })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, bobs) = api.call(Method::GET, "/workspaces", Some(bob), None).await;
    assert_eq!(bobs.as_array().unwrap().len(), 1);

    let (_, list) = api.call(Method::GET, "/workspaces", Some(ana), None).await;
    let names: Vec<_> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Personal", "Backend"]);

    // The personal workspace stays; the team one goes.
    let personal = format!("/workspaces/{}", list[0]["id"].as_str().unwrap());
    let (status, body) = api.call(Method::DELETE, &personal, Some(ana), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "personal_workspace");
    let (status, _) = api.call(Method::DELETE, &uri, Some(ana), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, list) = api.call(Method::GET, "/workspaces", Some(ana), None).await;
    assert_eq!(list.as_array().unwrap().len(), 1);
}
