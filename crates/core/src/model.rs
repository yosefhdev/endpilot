//! Saved entities: requests as the editor holds them, collections, folders, environments, history.
//! Rows carry UUID v7 ids and timestamps (epoch ms) so the Phase 5 sync can build on them.

use serde::{Deserialize, Serialize};

use crate::http::{FormField, KeyValue, RawLanguage};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BodyMode {
    #[default]
    None,
    Raw,
    Urlencoded,
    Formdata,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawBody {
    pub content: String,
    pub language: RawLanguage,
}

impl Default for RawBody {
    fn default() -> Self {
        Self {
            content: String::new(),
            language: RawLanguage::Json,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ApiKeyLocation {
    #[default]
    Header,
    Query,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Auth {
    #[default]
    None,
    Bearer {
        token: String,
    },
    Basic {
        username: String,
        password: String,
    },
    Apikey {
        key: String,
        value: String,
        #[serde(rename = "in", default)]
        location: ApiKeyLocation,
    },
}

/// A request as edited and saved (unresolved: may contain `{{variables}}`).
/// Every body mode keeps its data so switching modes loses nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RequestSpec {
    pub method: String,
    pub url: String,
    pub params: Vec<KeyValue>,
    pub headers: Vec<KeyValue>,
    pub body_mode: BodyMode,
    pub raw: RawBody,
    pub urlencoded: Vec<KeyValue>,
    pub formdata: Vec<FormField>,
    pub auth: Auth,
}

impl Default for RequestSpec {
    fn default() -> Self {
        Self {
            method: "GET".into(),
            url: String::new(),
            params: vec![],
            headers: vec![],
            body_mode: BodyMode::None,
            raw: RawBody::default(),
            urlencoded: vec![],
            formdata: vec![],
            auth: Auth::None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub variables: Vec<KeyValue>,
    pub sort: f64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    Folder,
    Request,
}

/// A folder or a request inside a collection. `parent_id` is a folder id, or `None` at the collection root.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub collection_id: String,
    pub parent_id: Option<String>,
    pub kind: ItemKind,
    pub name: String,
    pub sort: f64,
    /// Present for requests only.
    pub request: Option<RequestSpec>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    pub name: String,
    pub variables: Vec<KeyValue>,
    pub sort: f64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub created_at: i64,
    pub request: RequestSpec,
    pub status: Option<u16>,
    pub duration_ms: Option<f64>,
    pub size: Option<u64>,
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_spec_fills_missing_fields() {
        let spec: RequestSpec = serde_json::from_str(r#"{"url":"http://x"}"#).unwrap();
        assert_eq!(spec.method, "GET");
        assert_eq!(spec.auth, Auth::None);
        assert_eq!(spec.raw.language, RawLanguage::Json);
    }

    #[test]
    fn auth_json_shape() {
        let auth = Auth::Apikey {
            key: "X-Key".into(),
            value: "v".into(),
            location: ApiKeyLocation::Query,
        };
        assert_eq!(
            serde_json::to_value(&auth).unwrap(),
            serde_json::json!({"type": "apikey", "key": "X-Key", "value": "v", "in": "query"})
        );
    }
}
