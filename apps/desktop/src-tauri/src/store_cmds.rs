//! Thin Tauri wrappers over `endpilot_store::Store`.

use endpilot_core::http::KeyValue;
use endpilot_core::model::{
    Collection, Environment, HistoryEntry, Item, ItemKind, RequestSpec, Settings,
};
use endpilot_store::{Snapshot, Store, StoreError};
use tauri::State;

type R<T> = Result<T, StoreError>;

#[tauri::command]
pub fn snapshot(store: State<'_, Store>) -> R<Snapshot> {
    store.snapshot()
}

#[tauri::command]
pub fn create_collection(store: State<'_, Store>, name: String) -> R<Collection> {
    store.create_collection(&name)
}

#[tauri::command]
pub fn update_collection(
    store: State<'_, Store>,
    id: String,
    name: Option<String>,
    variables: Option<Vec<KeyValue>>,
    settings: Option<Settings>,
) -> R<Collection> {
    store.update_collection(
        &id,
        name.as_deref(),
        variables.as_deref(),
        settings.as_ref(),
    )
}

#[tauri::command]
pub fn approve_scripts(store: State<'_, Store>, collection_id: String) -> R<()> {
    store.approve_scripts(&collection_id)
}

#[tauri::command]
pub fn delete_collection(store: State<'_, Store>, id: String) -> R<()> {
    store.delete_collection(&id)
}

#[tauri::command]
pub fn duplicate_collection(store: State<'_, Store>, id: String) -> R<Collection> {
    store.duplicate_collection(&id)
}

#[tauri::command]
pub fn create_item(
    store: State<'_, Store>,
    collection_id: String,
    parent_id: Option<String>,
    kind: ItemKind,
    name: String,
    request: Option<RequestSpec>,
) -> R<Item> {
    store.create_item(&collection_id, parent_id.as_deref(), kind, &name, request)
}

#[tauri::command]
pub fn update_item(
    store: State<'_, Store>,
    id: String,
    name: Option<String>,
    request: Option<RequestSpec>,
    settings: Option<Settings>,
) -> R<Item> {
    store.update_item(&id, name.as_deref(), request.as_ref(), settings.as_ref())
}

#[tauri::command]
pub fn move_item(
    store: State<'_, Store>,
    id: String,
    collection_id: String,
    parent_id: Option<String>,
    before_id: Option<String>,
) -> R<Item> {
    store.move_item(
        &id,
        &collection_id,
        parent_id.as_deref(),
        before_id.as_deref(),
    )
}

#[tauri::command]
pub fn duplicate_item(store: State<'_, Store>, id: String) -> R<Item> {
    store.duplicate_item(&id)
}

#[tauri::command]
pub fn delete_item(store: State<'_, Store>, id: String) -> R<()> {
    store.delete_item(&id)
}

#[tauri::command]
pub fn create_environment(store: State<'_, Store>, name: String) -> R<Environment> {
    store.create_environment(&name)
}

#[tauri::command]
pub fn update_environment(
    store: State<'_, Store>,
    id: String,
    name: Option<String>,
    variables: Option<Vec<KeyValue>>,
) -> R<Environment> {
    store.update_environment(&id, name.as_deref(), variables.as_deref())
}

#[tauri::command]
pub fn delete_environment(store: State<'_, Store>, id: String) -> R<()> {
    store.delete_environment(&id)
}

#[tauri::command]
pub fn set_globals(store: State<'_, Store>, variables: Vec<KeyValue>) -> R<()> {
    store.set_globals(&variables)
}

#[tauri::command]
pub fn set_active_environment(store: State<'_, Store>, id: Option<String>) -> R<()> {
    store.set_active_environment(id.as_deref())
}

#[tauri::command]
pub fn add_history(store: State<'_, Store>, entry: HistoryEntry) -> R<HistoryEntry> {
    store.add_history(entry)
}

#[tauri::command]
pub fn list_history(store: State<'_, Store>) -> R<Vec<HistoryEntry>> {
    store.list_history()
}

#[tauri::command]
pub fn clear_history(store: State<'_, Store>) -> R<()> {
    store.clear_history()
}
