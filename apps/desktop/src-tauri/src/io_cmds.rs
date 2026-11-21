//! Import (Postman, OpenAPI, cURL) and export (Postman v2.1) commands.

use endpilot_core::model::{Collection, Environment, RequestSpec};
use endpilot_postman_compat::{
    Imported, export_collection as to_postman, export_environment as env_to_postman, import,
};
use endpilot_store::{Store, StoreError};
use serde::Serialize;
use tauri::State;

type R<T> = Result<T, StoreError>;

/// Bigger files are almost surely not collections; refuse instead of freezing the UI.
const MAX_IMPORT_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ImportResult {
    Collection {
        collection: Collection,
    },
    Environment {
        environment: Environment,
    },
    Globals {
        count: usize,
    },
    /// cURL: not saved, the UI opens it in a tab.
    Request {
        request: RequestSpec,
    },
}

fn save(store: &Store, imported: Imported) -> R<ImportResult> {
    Ok(match imported {
        Imported::Collection(tree) => ImportResult::Collection {
            collection: store.import_collection(&tree)?,
        },
        Imported::Environment { name, variables } => {
            let env = store.create_environment(&name)?;
            ImportResult::Environment {
                environment: store.update_environment(&env.id, None, Some(&variables))?,
            }
        }
        Imported::Globals(imported) => {
            // Merge: imported values replace globals with the same key, others stay.
            let mut globals = store.snapshot()?.globals;
            for v in &imported {
                match globals.iter_mut().find(|g| g.key == v.key) {
                    Some(g) => *g = v.clone(),
                    None => globals.push(v.clone()),
                }
            }
            store.set_globals(&globals)?;
            ImportResult::Globals {
                count: imported.len(),
            }
        }
        Imported::Request(request) => ImportResult::Request { request },
    })
}

#[tauri::command]
pub fn import_text(store: State<'_, Store>, text: String) -> R<ImportResult> {
    save(&store, import(&text).map_err(StoreError::new)?)
}

#[tauri::command]
pub fn import_file(store: State<'_, Store>, path: String) -> R<ImportResult> {
    let io = |e: std::io::Error| StoreError::new(format!("No se pudo leer el archivo: {e}"));
    if std::fs::metadata(&path).map_err(io)?.len() > MAX_IMPORT_BYTES {
        return Err(StoreError::new("El archivo pasa de 50 MB."));
    }
    let text = std::fs::read_to_string(&path).map_err(io)?;
    save(&store, import(&text).map_err(StoreError::new)?)
}

fn write_json(path: &str, value: &serde_json::Value) -> R<()> {
    let text = serde_json::to_string_pretty(value).map_err(|e| StoreError::new(e.to_string()))?;
    std::fs::write(path, text)
        .map_err(|e| StoreError::new(format!("No se pudo guardar el archivo: {e}")))
}

#[tauri::command]
pub fn export_collection(store: State<'_, Store>, id: String, path: String) -> R<()> {
    write_json(&path, &to_postman(&store.export_collection(&id)?))
}

#[tauri::command]
pub fn export_environment(store: State<'_, Store>, id: String, path: String) -> R<()> {
    let env = store
        .snapshot()?
        .environments
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| StoreError::new("El entorno ya no existe"))?;
    write_json(&path, &env_to_postman(&env.name, &env.variables))
}
