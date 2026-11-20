use std::collections::HashMap;
use std::sync::Mutex;

use endpilot_core::http::{HttpError, HttpErrorKind, HttpRequest, HttpResponse};
use tauri::State;
use tokio::task::AbortHandle;

/// Requests in flight, keyed by the id the UI generates, so they can be cancelled.
#[derive(Default)]
struct Inflight(Mutex<HashMap<String, AbortHandle>>);

#[tauri::command]
fn app_version() -> &'static str {
    endpilot_core::VERSION
}

#[tauri::command]
async fn send_request(
    id: String,
    request: HttpRequest,
    inflight: State<'_, Inflight>,
) -> Result<HttpResponse, HttpError> {
    let task = tokio::spawn(endpilot_http::send(request));
    inflight
        .0
        .lock()
        .unwrap()
        .insert(id.clone(), task.abort_handle());
    let result = task.await;
    inflight.0.lock().unwrap().remove(&id);
    match result {
        Ok(res) => res,
        Err(e) if e.is_cancelled() => Err(HttpError::new(
            HttpErrorKind::Cancelled,
            "Request cancelado",
        )),
        Err(e) => Err(HttpError::new(HttpErrorKind::Other, e.to_string())),
    }
}

#[tauri::command]
fn cancel_request(id: String, inflight: State<'_, Inflight>) {
    if let Some(handle) = inflight.0.lock().unwrap().remove(&id) {
        handle.abort();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Inflight::default())
        .invoke_handler(tauri::generate_handler![
            app_version,
            send_request,
            cancel_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
