//! Signing in to an Endpilot server and calling its API.
//!
//! The refresh token, the server URL and the user live in the OS keychain (one entry);
//! the short-lived access token only in memory. One mutex serializes refreshes: the
//! server revokes the session if an already rotated refresh token comes back.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tauri::State;
use tokio::sync::Mutex;

// Tests use their own entry so they never touch a real sign-in.
const KEYCHAIN_SERVICE: &str = if cfg!(test) {
    "endpilot-test"
} else {
    "endpilot"
};
const KEYCHAIN_USER: &str = "session";

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Saved {
    server_url: String,
    refresh_token: String,
    user: Value,
}

/// What the UI sees: never the tokens.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    server_url: String,
    user: Value,
}

struct Live {
    saved: Saved,
    access: Option<(String, Instant)>,
}

pub struct Account {
    http: reqwest::Client,
    /// `None` until first loaded from the keychain; `Some(None)` = signed out.
    live: Mutex<Option<Option<Live>>>,
}

impl Default for Account {
    fn default() -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .expect("http client"),
            live: Mutex::new(None),
        }
    }
}

fn keychain() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER)
        .map_err(|e| format!("No se pudo abrir el almacén de credenciales del sistema: {e}"))
}

fn load_saved() -> Option<Saved> {
    let json = keychain().ok()?.get_password().ok()?;
    serde_json::from_str(&json).ok()
}

fn store_saved(saved: &Saved) -> Result<(), String> {
    keychain()?
        .set_password(&serde_json::to_string(saved).map_err(|e| e.to_string())?)
        .map_err(|e| format!("No se pudo guardar la sesión en el sistema: {e}"))
}

fn forget_saved() {
    if let Ok(entry) = keychain() {
        let _ = entry.delete_credential();
    }
}

/// `https://host/` → `https://host`. Only http(s) URLs.
fn normalize_url(url: &str) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/');
    let ok = reqwest::Url::parse(url)
        .is_ok_and(|u| matches!(u.scheme(), "http" | "https") && u.host().is_some());
    if !ok {
        return Err("La URL del servidor debe empezar con http:// o https://".into());
    }
    Ok(url.to_owned())
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Escritorio".into())
}

/// Sends a request; a non-2xx answer becomes the server's `error.message`.
async fn call(
    http: &reqwest::Client,
    method: reqwest::Method,
    url: &str,
    token: Option<&str>,
    body: Option<&Value>,
) -> Result<(reqwest::StatusCode, Value), String> {
    let mut req = http.request(method, url);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    if let Some(b) = body {
        req = req.json(b);
    }
    let res = req
        .send()
        .await
        .map_err(|e| format!("No se pudo conectar con el servidor: {e}"))?;
    let status = res.status();
    let value: Value = res.json().await.unwrap_or(Value::Null);
    Ok((status, value))
}

fn server_error(status: reqwest::StatusCode, body: &Value) -> String {
    body["error"]["message"]
        .as_str()
        .map_or_else(|| format!("El servidor respondió {status}"), str::to_owned)
}

/// Turns a tokens response into a signed-in state and saves it.
fn signed_in(server_url: String, tokens: &Value) -> Result<Live, String> {
    let (Some(access), Some(refresh)) = (
        tokens["accessToken"].as_str(),
        tokens["refreshToken"].as_str(),
    ) else {
        return Err("Respuesta inesperada del servidor.".into());
    };
    let expires_in = tokens["expiresIn"].as_u64().unwrap_or(0);
    let saved = Saved {
        server_url,
        refresh_token: refresh.to_owned(),
        user: tokens["user"].clone(),
    };
    store_saved(&saved)?;
    Ok(Live {
        saved,
        // A minute early, so a token doesn't expire mid-flight.
        access: Some((
            access.to_owned(),
            Instant::now() + Duration::from_secs(expires_in.saturating_sub(60)),
        )),
    })
}

fn info(live: &Live) -> AccountInfo {
    AccountInfo {
        server_url: live.saved.server_url.clone(),
        user: live.saved.user.clone(),
    }
}

impl Account {
    /// Calls the API as the signed-in user, refreshing the access token when needed.
    async fn api(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        let mut guard = self.live.lock().await;
        let slot = guard.get_or_insert_with(|| {
            load_saved().map(|saved| Live {
                saved,
                access: None,
            })
        });
        let Some(live) = slot.as_mut() else {
            return Err("No has iniciado sesión.".into());
        };
        match self.api_as(live, method, path, body.as_ref()).await {
            Ok(value) => Ok(value),
            Err(Some(e)) => Err(e),
            Err(None) => {
                // The session is over on the server: sign out here too.
                forget_saved();
                *slot = None;
                Err("Tu sesión expiró. Inicia sesión de nuevo.".into())
            }
        }
    }

    /// `Err(None)` = the server ended the session.
    async fn api_as(
        &self,
        live: &mut Live,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, Option<String>> {
        let url = format!("{}{path}", live.saved.server_url);
        let mut retried = false;
        loop {
            let token = match &live.access {
                Some((t, until)) if Instant::now() < *until => t.clone(),
                _ => self.refresh(live).await?,
            };
            let (status, value) = call(&self.http, method.clone(), &url, Some(&token), body)
                .await
                .map_err(Some)?;
            // An access token can die early (e.g. server restarted with a new secret): refresh once.
            if status == reqwest::StatusCode::UNAUTHORIZED && !retried {
                retried = true;
                live.access = None;
                continue;
            }
            if !status.is_success() {
                return Err(Some(server_error(status, &value)));
            }
            return Ok(value);
        }
    }

    /// New access token. `Err(None)` = the server ended the session; `Err(Some)` = any other failure.
    async fn refresh(&self, live: &mut Live) -> Result<String, Option<String>> {
        let url = format!("{}/auth/refresh", live.saved.server_url);
        let body = json!({ "refreshToken": live.saved.refresh_token });
        let (status, tokens) = call(&self.http, reqwest::Method::POST, &url, None, Some(&body))
            .await
            .map_err(Some)?;
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(None);
        }
        if !status.is_success() {
            return Err(Some(server_error(status, &tokens)));
        }
        *live = signed_in(live.saved.server_url.clone(), &tokens).map_err(Some)?;
        Ok(live
            .access
            .as_ref()
            .map(|a| a.0.clone())
            .unwrap_or_default())
    }

    async fn sign_in(
        &self,
        server_url: &str,
        path: &str,
        mut body: Value,
    ) -> Result<AccountInfo, String> {
        let server_url = normalize_url(server_url)?;
        body["deviceName"] = device_name().into();
        let (status, tokens) = call(
            &self.http,
            reqwest::Method::POST,
            &format!("{server_url}{path}"),
            None,
            Some(&body),
        )
        .await?;
        if !status.is_success() {
            return Err(server_error(status, &tokens));
        }
        let live = signed_in(server_url, &tokens)?;
        let account = info(&live);
        *self.live.lock().await = Some(Some(live));
        Ok(account)
    }
}

#[tauri::command]
pub async fn account_status(account: State<'_, Account>) -> Result<Option<AccountInfo>, String> {
    let mut guard = account.live.lock().await;
    let slot = guard.get_or_insert_with(|| {
        load_saved().map(|saved| Live {
            saved,
            access: None,
        })
    });
    Ok(slot.as_ref().map(info))
}

#[tauri::command]
pub async fn account_login(
    server_url: String,
    email: String,
    password: String,
    account: State<'_, Account>,
) -> Result<AccountInfo, String> {
    account
        .sign_in(
            &server_url,
            "/auth/login",
            json!({ "email": email, "password": password }),
        )
        .await
}

#[tauri::command]
pub async fn account_register(
    server_url: String,
    name: String,
    email: String,
    password: String,
    account: State<'_, Account>,
) -> Result<AccountInfo, String> {
    account
        .sign_in(
            &server_url,
            "/auth/register",
            json!({ "name": name, "email": email, "password": password }),
        )
        .await
}

/// Ends the session on the server (best effort: offline still signs out here).
#[tauri::command]
pub async fn account_logout(account: State<'_, Account>) -> Result<(), String> {
    let _ = account
        .api(reqwest::Method::POST, "/auth/logout", None)
        .await;
    forget_saved();
    *account.live.lock().await = Some(None);
    Ok(())
}

#[tauri::command]
pub async fn list_workspaces(account: State<'_, Account>) -> Result<Value, String> {
    account.api(reqwest::Method::GET, "/workspaces", None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Against the dev stack: `docker compose -f deploy/docker-compose.dev.yml up -d --wait`,
    /// then `cargo test -p endpilot-desktop -- --ignored`.
    #[tokio::test]
    #[ignore = "needs the dev server on http://localhost"]
    async fn sign_in_refresh_and_sign_out_against_dev_server() {
        let account = Account::default();
        let email = format!("test-{}@example.test", std::process::id());
        let body = json!({ "name": "Prueba", "email": email, "password": "contraseña-larga" });
        let info = account
            .sign_in("http://localhost/", "/auth/register", body)
            .await
            .unwrap();
        assert_eq!(info.server_url, "http://localhost");
        assert_eq!(load_saved().unwrap().user["email"], email.as_str());

        // An expired access token is refreshed transparently.
        account
            .live
            .lock()
            .await
            .as_mut()
            .unwrap()
            .as_mut()
            .unwrap()
            .access = None;
        let ws = account
            .api(reqwest::Method::GET, "/workspaces", None)
            .await
            .unwrap();
        assert_eq!(ws[0]["name"], "Personal");

        // A fresh Account (app restart) picks the session up from the keychain.
        let restarted = Account::default();
        let ws = restarted
            .api(reqwest::Method::GET, "/workspaces", None)
            .await
            .unwrap();
        assert_eq!(ws[0]["kind"], "personal");

        // The first instance still holds the refresh token the restart rotated away:
        // using it makes the server end the session, and both forget it.
        account
            .live
            .lock()
            .await
            .as_mut()
            .unwrap()
            .as_mut()
            .unwrap()
            .access = None;
        let err = account
            .api(reqwest::Method::GET, "/workspaces", None)
            .await
            .unwrap_err();
        assert!(err.contains("expiró"), "{err}");
        assert!(load_saved().is_none());
        let err = restarted
            .api(reqwest::Method::GET, "/workspaces", None)
            .await
            .unwrap_err();
        assert!(err.contains("expiró"), "{err}");

        let err = account
            .sign_in(
                "http://localhost",
                "/auth/login",
                json!({ "email": email, "password": "mala-mala" }),
            )
            .await
            .unwrap_err();
        assert_eq!(err, "Email o contraseña incorrectos.");
    }

    #[test]
    fn server_urls_are_checked_and_trimmed() {
        assert_eq!(
            normalize_url(" https://api.example.com/ ").unwrap(),
            "https://api.example.com"
        );
        assert_eq!(
            normalize_url("http://localhost:8080").unwrap(),
            "http://localhost:8080"
        );
        assert!(normalize_url("ftp://x").is_err());
        assert!(normalize_url("example.com").is_err());
    }
}
