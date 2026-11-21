//! Local-first SQLite store. Deletes are soft (`deleted_at`) so they can sync and be restored later.

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use endpilot_core::http::KeyValue;
use endpilot_core::model::{
    Collection, CollectionTree, Environment, HistoryEntry, Item, ItemKind, RequestSpec, TreeItem,
};
use rusqlite::{Connection, OptionalExtension, Row, Transaction, params};
use serde::Serialize;
use serde::de::DeserializeOwned;

const HISTORY_LIMIT: i64 = 500;

const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    variables TEXT NOT NULL DEFAULT '[]',
    sort REAL NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);
CREATE TABLE items (
    id TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL REFERENCES collections(id),
    parent_id TEXT REFERENCES items(id),
    kind TEXT NOT NULL CHECK (kind IN ('folder', 'request')),
    name TEXT NOT NULL,
    sort REAL NOT NULL,
    request TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);
CREATE INDEX items_collection ON items(collection_id);
CREATE TABLE environments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    variables TEXT NOT NULL DEFAULT '[]',
    sort REAL NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE history (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    request TEXT NOT NULL,
    status INTEGER,
    duration_ms REAL,
    size INTEGER,
    error TEXT
);
CREATE INDEX history_created ON history(created_at DESC);
"#];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StoreError {
    pub message: String,
}

impl StoreError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        Self::new(format!("Error de base de datos: {e}"))
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(e: serde_json::Error) -> Self {
        Self::new(format!("Dato inválido en la base: {e}"))
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// Everything the UI needs at startup, in one call.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub collections: Vec<Collection>,
    pub items: Vec<Item>,
    pub environments: Vec<Environment>,
    pub globals: Vec<KeyValue>,
    pub active_environment_id: Option<String>,
}

pub struct Store {
    conn: Mutex<Connection>,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

fn to_json<T: Serialize + ?Sized>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}

fn from_json<T: DeserializeOwned>(text: &str) -> rusqlite::Result<T> {
    serde_json::from_str(text).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn kind_str(kind: ItemKind) -> &'static str {
    match kind {
        ItemKind::Folder => "folder",
        ItemKind::Request => "request",
    }
}

const COLLECTION_COLS: &str = "id, name, variables, sort, updated_at";
const ITEM_COLS: &str = "id, collection_id, parent_id, kind, name, sort, request, updated_at";
const ENV_COLS: &str = "id, name, variables, sort, updated_at";

fn collection_row(r: &Row) -> rusqlite::Result<Collection> {
    Ok(Collection {
        id: r.get(0)?,
        name: r.get(1)?,
        variables: from_json(&r.get::<_, String>(2)?)?,
        sort: r.get(3)?,
        updated_at: r.get(4)?,
    })
}

fn item_row(r: &Row) -> rusqlite::Result<Item> {
    let kind: String = r.get(3)?;
    let request: Option<String> = r.get(6)?;
    Ok(Item {
        id: r.get(0)?,
        collection_id: r.get(1)?,
        parent_id: r.get(2)?,
        kind: if kind == "folder" {
            ItemKind::Folder
        } else {
            ItemKind::Request
        },
        name: r.get(4)?,
        sort: r.get(5)?,
        request: request.as_deref().map(from_json).transpose()?,
        updated_at: r.get(7)?,
    })
}

fn env_row(r: &Row) -> rusqlite::Result<Environment> {
    Ok(Environment {
        id: r.get(0)?,
        name: r.get(1)?,
        variables: from_json(&r.get::<_, String>(2)?)?,
        sort: r.get(3)?,
        updated_at: r.get(4)?,
    })
}

fn history_row(r: &Row) -> rusqlite::Result<HistoryEntry> {
    Ok(HistoryEntry {
        id: r.get(0)?,
        created_at: r.get(1)?,
        request: from_json(&r.get::<_, String>(2)?)?,
        status: r.get(3)?,
        duration_ms: r.get(4)?,
        size: r.get::<_, Option<i64>>(5)?.map(|n| n as u64),
        error: r.get(6)?,
    })
}

fn get_item(tx: &Connection, id: &str) -> Result<Item> {
    tx.query_row(
        &format!("SELECT {ITEM_COLS} FROM items WHERE id = ? AND deleted_at IS NULL"),
        [id],
        item_row,
    )
    .optional()?
    .ok_or_else(|| StoreError::new("El elemento ya no existe"))
}

fn get_collection(tx: &Connection, id: &str) -> Result<Collection> {
    tx.query_row(
        &format!("SELECT {COLLECTION_COLS} FROM collections WHERE id = ? AND deleted_at IS NULL"),
        [id],
        collection_row,
    )
    .optional()?
    .ok_or_else(|| StoreError::new("La colección ya no existe"))
}

/// The item and all its descendants, parents before children.
fn subtree(tx: &Connection, id: &str) -> Result<Vec<Item>> {
    let mut stmt = tx.prepare(&format!(
        "WITH RECURSIVE t(id, depth) AS (
             SELECT id, 0 FROM items WHERE id = ?1 AND deleted_at IS NULL
             UNION ALL
             SELECT i.id, t.depth + 1 FROM items i JOIN t ON i.parent_id = t.id WHERE i.deleted_at IS NULL
         )
         SELECT {ITEM_COLS} FROM items JOIN t USING (id) ORDER BY t.depth, sort"
    ))?;
    let rows = stmt.query_map([id], item_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn next_sort(tx: &Connection, collection_id: &str, parent_id: Option<&str>) -> Result<f64> {
    Ok(tx.query_row(
        "SELECT COALESCE(MAX(sort), 0) + 1 FROM items
         WHERE collection_id = ?1 AND parent_id IS ?2 AND deleted_at IS NULL",
        params![collection_id, parent_id],
        |r| r.get(0),
    )?)
}

fn insert_item(tx: &Transaction, item: &Item) -> Result<()> {
    let t = now();
    tx.execute(
        "INSERT INTO items (id, collection_id, parent_id, kind, name, sort, request, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![
            item.id,
            item.collection_id,
            item.parent_id,
            kind_str(item.kind),
            item.name,
            item.sort,
            item.request.as_ref().map(to_json).transpose()?,
            t
        ],
    )?;
    Ok(())
}

/// Copies `items` (a subtree, parents first) with fresh ids into `collection_id`.
/// The first item is re-parented to `root_parent` with `root_name`/`root_sort`.
fn copy_items(
    tx: &Transaction,
    items: &[Item],
    collection_id: &str,
    root: Option<(Option<String>, String, f64)>,
) -> Result<Option<String>> {
    let mut ids = std::collections::HashMap::new();
    let mut first_id = None;
    for (i, item) in items.iter().enumerate() {
        let mut copy = item.clone();
        copy.id = new_id();
        copy.collection_id = collection_id.to_owned();
        copy.parent_id = item.parent_id.as_ref().and_then(|p| ids.get(p).cloned());
        if i == 0
            && let Some((parent, name, sort)) = &root
        {
            copy.parent_id = parent.clone();
            copy.name = name.clone();
            copy.sort = *sort;
        }
        ids.insert(item.id.clone(), copy.id.clone());
        first_id.get_or_insert(copy.id.clone());
        insert_item(tx, &copy)?;
    }
    Ok(first_id)
}

fn insert_tree(
    tx: &Transaction,
    collection_id: &str,
    parent_id: Option<&str>,
    items: &[TreeItem],
) -> Result<()> {
    for (i, item) in items.iter().enumerate() {
        let (name, kind, request, children) = match item {
            TreeItem::Folder { name, items } => (name, ItemKind::Folder, None, Some(items)),
            TreeItem::Request { name, request } => {
                (name, ItemKind::Request, Some(request.clone()), None)
            }
        };
        let row = Item {
            id: new_id(),
            collection_id: collection_id.to_owned(),
            parent_id: parent_id.map(str::to_owned),
            kind,
            name: name.clone(),
            sort: (i + 1) as f64,
            request,
            updated_at: 0,
        };
        insert_item(tx, &row)?;
        if let Some(children) = children {
            insert_tree(tx, collection_id, Some(&row.id), children)?;
        }
    }
    Ok(())
}

/// `items` sorted by `sort`; returns the children of `parent_id`, recursively.
fn build_tree(items: &[Item], parent_id: Option<&str>) -> Vec<TreeItem> {
    items
        .iter()
        .filter(|i| i.parent_id.as_deref() == parent_id)
        .map(|i| match i.kind {
            ItemKind::Folder => TreeItem::Folder {
                name: i.name.clone(),
                items: build_tree(items, Some(&i.id)),
            },
            ItemKind::Request => TreeItem::Request {
                name: i.name.clone(),
                request: i.request.clone().unwrap_or_default(),
            },
        })
        .collect()
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            conn.execute_batch(&format!(
                "BEGIN; {sql}; PRAGMA user_version = {}; COMMIT;",
                i + 1
            ))?;
        }
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| StoreError::new("Base local bloqueada"))?;
        f(&mut conn)
    }

    fn tx<T>(&self, f: impl FnOnce(&Transaction) -> Result<T>) -> Result<T> {
        self.with(|conn| {
            let tx = conn.transaction()?;
            let out = f(&tx)?;
            tx.commit()?;
            Ok(out)
        })
    }

    pub fn snapshot(&self) -> Result<Snapshot> {
        self.with(|conn| {
            let collections = conn
                .prepare(&format!(
                    "SELECT {COLLECTION_COLS} FROM collections WHERE deleted_at IS NULL ORDER BY sort"
                ))?
                .query_map([], collection_row)?
                .collect::<rusqlite::Result<_>>()?;
            let items = conn
                .prepare(&format!(
                    "SELECT {ITEM_COLS} FROM items WHERE deleted_at IS NULL ORDER BY sort"
                ))?
                .query_map([], item_row)?
                .collect::<rusqlite::Result<_>>()?;
            let environments = conn
                .prepare(&format!(
                    "SELECT {ENV_COLS} FROM environments WHERE deleted_at IS NULL ORDER BY sort"
                ))?
                .query_map([], env_row)?
                .collect::<rusqlite::Result<_>>()?;
            let setting = |key: &str| -> Result<Option<String>> {
                Ok(conn
                    .query_row("SELECT value FROM settings WHERE key = ?", [key], |r| {
                        r.get(0)
                    })
                    .optional()?)
            };
            let globals = match setting("globals")? {
                Some(json) => serde_json::from_str(&json)?,
                None => vec![],
            };
            let active_environment_id = setting("active_environment_id")?
                .map(|json| serde_json::from_str(&json))
                .transpose()?
                .flatten();
            Ok(Snapshot {
                collections,
                items,
                environments,
                globals,
                active_environment_id,
            })
        })
    }

    // ---- collections ----

    pub fn create_collection(&self, name: &str) -> Result<Collection> {
        self.tx(|tx| {
            let id = new_id();
            let t = now();
            tx.execute(
                "INSERT INTO collections (id, name, sort, created_at, updated_at)
                 VALUES (?1, ?2, (SELECT COALESCE(MAX(sort), 0) + 1 FROM collections WHERE deleted_at IS NULL), ?3, ?3)",
                params![id, name, t],
            )?;
            get_collection(tx, &id)
        })
    }

    pub fn update_collection(
        &self,
        id: &str,
        name: Option<&str>,
        variables: Option<&[KeyValue]>,
    ) -> Result<Collection> {
        self.tx(|tx| {
            get_collection(tx, id)?;
            let variables = variables.map(to_json).transpose()?;
            tx.execute(
                "UPDATE collections SET name = COALESCE(?2, name), variables = COALESCE(?3, variables), updated_at = ?4
                 WHERE id = ?1",
                params![id, name, variables, now()],
            )?;
            get_collection(tx, id)
        })
    }

    pub fn delete_collection(&self, id: &str) -> Result<()> {
        self.tx(|tx| {
            let t = now();
            tx.execute(
                "UPDATE collections SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1",
                params![id, t],
            )?;
            tx.execute(
                "UPDATE items SET deleted_at = ?2, updated_at = ?2 WHERE collection_id = ?1 AND deleted_at IS NULL",
                params![id, t],
            )?;
            Ok(())
        })
    }

    pub fn duplicate_collection(&self, id: &str) -> Result<Collection> {
        self.tx(|tx| {
            let original = get_collection(tx, id)?;
            let new_id_ = new_id();
            let t = now();
            tx.execute(
                "INSERT INTO collections (id, name, variables, sort, created_at, updated_at)
                 VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(sort), 0) + 1 FROM collections WHERE deleted_at IS NULL), ?4, ?4)",
                params![new_id_, format!("{} (copia)", original.name), to_json(&original.variables)?, t],
            )?;
            let roots: Vec<String> = tx
                .prepare("SELECT id FROM items WHERE collection_id = ? AND parent_id IS NULL AND deleted_at IS NULL ORDER BY sort")?
                .query_map([id], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            for root in roots {
                let items = subtree(tx, &root)?;
                copy_items(tx, &items, &new_id_, None)?;
            }
            get_collection(tx, &new_id_)
        })
    }

    /// Inserts a whole imported collection in one transaction (all or nothing).
    pub fn import_collection(&self, tree: &CollectionTree) -> Result<Collection> {
        self.tx(|tx| {
            let id = new_id();
            tx.execute(
                "INSERT INTO collections (id, name, variables, sort, created_at, updated_at)
                 VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(sort), 0) + 1 FROM collections WHERE deleted_at IS NULL), ?4, ?4)",
                params![id, tree.name, to_json(&tree.variables)?, now()],
            )?;
            insert_tree(tx, &id, None, &tree.items)?;
            get_collection(tx, &id)
        })
    }

    pub fn export_collection(&self, id: &str) -> Result<CollectionTree> {
        self.with(|conn| {
            let collection = get_collection(conn, id)?;
            let items: Vec<Item> = conn
                .prepare(&format!(
                    "SELECT {ITEM_COLS} FROM items WHERE collection_id = ? AND deleted_at IS NULL ORDER BY sort"
                ))?
                .query_map([id], item_row)?
                .collect::<rusqlite::Result<_>>()?;
            Ok(CollectionTree {
                name: collection.name,
                variables: collection.variables,
                items: build_tree(&items, None),
            })
        })
    }

    // ---- items (folders and requests) ----

    pub fn create_item(
        &self,
        collection_id: &str,
        parent_id: Option<&str>,
        kind: ItemKind,
        name: &str,
        request: Option<RequestSpec>,
    ) -> Result<Item> {
        self.tx(|tx| {
            get_collection(tx, collection_id)?;
            if let Some(parent) = parent_id {
                let p = get_item(tx, parent)?;
                if p.kind != ItemKind::Folder || p.collection_id != collection_id {
                    return Err(StoreError::new(
                        "Solo se puede crear dentro de una carpeta de la misma colección",
                    ));
                }
            }
            let item = Item {
                id: new_id(),
                collection_id: collection_id.to_owned(),
                parent_id: parent_id.map(str::to_owned),
                kind,
                name: name.to_owned(),
                sort: next_sort(tx, collection_id, parent_id)?,
                request: match kind {
                    ItemKind::Request => Some(request.unwrap_or_default()),
                    ItemKind::Folder => None,
                },
                updated_at: 0,
            };
            insert_item(tx, &item)?;
            get_item(tx, &item.id)
        })
    }

    pub fn update_item(
        &self,
        id: &str,
        name: Option<&str>,
        request: Option<&RequestSpec>,
    ) -> Result<Item> {
        self.tx(|tx| {
            let item = get_item(tx, id)?;
            if request.is_some() && item.kind != ItemKind::Request {
                return Err(StoreError::new("Una carpeta no guarda un request"));
            }
            let request = request.map(to_json).transpose()?;
            tx.execute(
                "UPDATE items SET name = COALESCE(?2, name), request = COALESCE(?3, request), updated_at = ?4 WHERE id = ?1",
                params![id, name, request, now()],
            )?;
            get_item(tx, id)
        })
    }

    /// Moves an item (and its subtree) under `parent_id` in `collection_id`.
    /// With `before_id`, it lands just before that sibling; otherwise at the end.
    pub fn move_item(
        &self,
        id: &str,
        collection_id: &str,
        parent_id: Option<&str>,
        before_id: Option<&str>,
    ) -> Result<Item> {
        self.tx(|tx| {
            get_collection(tx, collection_id)?;
            let tree = subtree(tx, id)?;
            if tree.is_empty() {
                return Err(StoreError::new("El elemento ya no existe"));
            }
            if let Some(parent) = parent_id {
                if tree.iter().any(|i| i.id == parent) {
                    return Err(StoreError::new("No se puede mover una carpeta dentro de sí misma"));
                }
                let p = get_item(tx, parent)?;
                if p.kind != ItemKind::Folder || p.collection_id != collection_id {
                    return Err(StoreError::new("El destino debe ser una carpeta de esa colección"));
                }
            }
            let sort = match before_id {
                Some(before) => {
                    let b = get_item(tx, before)?;
                    let prev: Option<f64> = tx.query_row(
                        "SELECT MAX(sort) FROM items WHERE collection_id = ?1 AND parent_id IS ?2
                         AND sort < ?3 AND id != ?4 AND deleted_at IS NULL",
                        params![collection_id, parent_id, b.sort, id],
                        |r| r.get(0),
                    )?;
                    match prev {
                        Some(p) => (p + b.sort) / 2.0,
                        None => b.sort - 1.0,
                    }
                }
                None => next_sort(tx, collection_id, parent_id)?,
            };
            let t = now();
            tx.execute(
                "UPDATE items SET parent_id = ?2, collection_id = ?3, sort = ?4, updated_at = ?5 WHERE id = ?1",
                params![id, parent_id, collection_id, sort, t],
            )?;
            for child in &tree[1..] {
                tx.execute(
                    "UPDATE items SET collection_id = ?2, updated_at = ?3 WHERE id = ?1",
                    params![child.id, collection_id, t],
                )?;
            }
            get_item(tx, id)
        })
    }

    /// Copies the item (and subtree) right after the original.
    pub fn duplicate_item(&self, id: &str) -> Result<Item> {
        self.tx(|tx| {
            let tree = subtree(tx, id)?;
            let original = tree
                .first()
                .ok_or_else(|| StoreError::new("El elemento ya no existe"))?;
            let next: Option<f64> = tx.query_row(
                "SELECT MIN(sort) FROM items WHERE collection_id = ?1 AND parent_id IS ?2 AND sort > ?3 AND deleted_at IS NULL",
                params![original.collection_id, original.parent_id, original.sort],
                |r| r.get(0),
            )?;
            let sort = next.map_or(original.sort + 1.0, |n| (original.sort + n) / 2.0);
            let root = (original.parent_id.clone(), format!("{} (copia)", original.name), sort);
            let new_root = copy_items(tx, &tree, &original.collection_id, Some(root))?
                .ok_or_else(|| StoreError::new("Nada que duplicar"))?;
            get_item(tx, &new_root)
        })
    }

    pub fn delete_item(&self, id: &str) -> Result<()> {
        self.tx(|tx| {
            let t = now();
            for item in subtree(tx, id)? {
                tx.execute(
                    "UPDATE items SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1",
                    params![item.id, t],
                )?;
            }
            Ok(())
        })
    }

    // ---- environments and globals ----

    pub fn create_environment(&self, name: &str) -> Result<Environment> {
        self.tx(|tx| {
            let id = new_id();
            let t = now();
            tx.execute(
                "INSERT INTO environments (id, name, sort, created_at, updated_at)
                 VALUES (?1, ?2, (SELECT COALESCE(MAX(sort), 0) + 1 FROM environments WHERE deleted_at IS NULL), ?3, ?3)",
                params![id, name, t],
            )?;
            Ok(tx.query_row(
                &format!("SELECT {ENV_COLS} FROM environments WHERE id = ?"),
                [&id],
                env_row,
            )?)
        })
    }

    pub fn update_environment(
        &self,
        id: &str,
        name: Option<&str>,
        variables: Option<&[KeyValue]>,
    ) -> Result<Environment> {
        self.tx(|tx| {
            let variables = variables.map(to_json).transpose()?;
            let changed = tx.execute(
                "UPDATE environments SET name = COALESCE(?2, name), variables = COALESCE(?3, variables), updated_at = ?4
                 WHERE id = ?1 AND deleted_at IS NULL",
                params![id, name, variables, now()],
            )?;
            if changed == 0 {
                return Err(StoreError::new("El entorno ya no existe"));
            }
            Ok(tx.query_row(
                &format!("SELECT {ENV_COLS} FROM environments WHERE id = ?"),
                [id],
                env_row,
            )?)
        })
    }

    pub fn delete_environment(&self, id: &str) -> Result<()> {
        self.tx(|tx| {
            tx.execute(
                "UPDATE environments SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1",
                params![id, now()],
            )?;
            tx.execute(
                "DELETE FROM settings WHERE key = 'active_environment_id' AND value = ?",
                [to_json(&id)?],
            )?;
            Ok(())
        })
    }

    pub fn set_globals(&self, variables: &[KeyValue]) -> Result<()> {
        self.set_setting("globals", &variables)
    }

    pub fn set_active_environment(&self, id: Option<&str>) -> Result<()> {
        self.set_setting("active_environment_id", &id)
    }

    fn set_setting<T: Serialize>(&self, key: &str, value: &T) -> Result<()> {
        let json = to_json(value)?;
        self.with(|conn| {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![key, json],
            )?;
            Ok(())
        })
    }

    // ---- history ----

    /// Records a sent request, keeping only the newest entries.
    pub fn add_history(&self, mut entry: HistoryEntry) -> Result<HistoryEntry> {
        entry.id = new_id();
        entry.created_at = now();
        self.tx(|tx| {
            tx.execute(
                "INSERT INTO history (id, created_at, request, status, duration_ms, size, error)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    entry.id,
                    entry.created_at,
                    to_json(&entry.request)?,
                    entry.status,
                    entry.duration_ms,
                    entry.size.map(|n| n as i64),
                    entry.error
                ],
            )?;
            tx.execute(
                "DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY created_at DESC, id DESC LIMIT ?)",
                [HISTORY_LIMIT],
            )?;
            Ok(())
        })?;
        Ok(entry)
    }

    pub fn list_history(&self) -> Result<Vec<HistoryEntry>> {
        self.with(|conn| {
            Ok(conn
                .prepare(
                    "SELECT id, created_at, request, status, duration_ms, size, error
                     FROM history ORDER BY created_at DESC, id DESC",
                )?
                .query_map([], history_row)?
                .collect::<rusqlite::Result<_>>()?)
        })
    }

    pub fn clear_history(&self) -> Result<()> {
        self.with(|conn| {
            conn.execute("DELETE FROM history", [])?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests;
