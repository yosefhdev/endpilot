//! Converts between outside formats and Endpilot's model ([`CollectionTree`], [`RequestSpec`]).
//! Import: Postman Collection v2.1/v2.0, Postman environments and globals, OpenAPI 3, cURL.
//! Export: Postman Collection v2.1 and environments.

mod curl;
mod openapi;
mod postman;

use endpilot_core::{
    http::KeyValue,
    model::{CollectionTree, RequestSpec},
};
use serde_json::Value;

pub use curl::parse_curl;
pub use postman::{export_collection, export_environment};

/// What a pasted text or a file turned out to be.
#[derive(Debug, Clone, PartialEq)]
pub enum Imported {
    Collection(CollectionTree),
    Environment {
        name: String,
        variables: Vec<KeyValue>,
    },
    Globals(Vec<KeyValue>),
    Request(RequestSpec),
}

/// Detects the format (cURL, Postman collection/environment/globals, OpenAPI; JSON or YAML) and imports it.
pub fn import(text: &str) -> Result<Imported, String> {
    let text = text.trim_start_matches('\u{feff}').trim();
    if text.starts_with("curl ") || text.starts_with("curl.exe ") {
        return parse_curl(text).map(Imported::Request);
    }
    let doc: Value = if text.starts_with('{') {
        serde_json::from_str(text).map_err(|e| format!("JSON inválido: {e}"))?
    } else {
        serde_yaml_ng::from_str(text).map_err(|_| {
            "No se reconoce el formato. Se acepta: colección o entorno de Postman, OpenAPI 3 o un comando cURL.".to_owned()
        })?
    };

    if doc.get("openapi").is_some() || doc.get("swagger").is_some() {
        return openapi::import_openapi(&doc).map(Imported::Collection);
    }
    if doc.get("info").is_some() && doc.get("item").is_some() {
        return Ok(Imported::Collection(postman::import_collection(&doc)));
    }
    if doc["values"].is_array() {
        let variables = kv_list(&doc["values"]);
        if doc["_postman_variable_scope"] == "globals" {
            return Ok(Imported::Globals(variables));
        }
        let name = non_empty(text_of(&doc["name"]), "Entorno importado");
        return Ok(Imported::Environment { name, variables });
    }
    Err("No se reconoce el formato. Se acepta: colección o entorno de Postman, OpenAPI 3 o un comando cURL.".into())
}

/// Any JSON scalar as text (Postman variables may hold numbers or booleans).
fn text_of(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn non_empty(s: String, fallback: &str) -> String {
    if s.trim().is_empty() {
        fallback.to_owned()
    } else {
        s
    }
}

/// Postman key/value lists: `disabled: true` (collections) or `enabled: false` (environments) turn a row off.
fn kv_list(v: &Value) -> Vec<KeyValue> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter(|row| row.get("key").is_some())
        .map(|row| KeyValue {
            key: text_of(&row["key"]),
            value: text_of(&row["value"]),
            enabled: row["enabled"].as_bool().unwrap_or(true)
                && !row["disabled"].as_bool().unwrap_or(false),
        })
        .collect()
}

/// Query params from a URL, kept as typed (no decoding), like the editor does.
fn query_params(url: &str) -> Vec<KeyValue> {
    let Some((_, query)) = url.split('#').next().unwrap_or("").split_once('?') else {
        return vec![];
    };
    query
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (key, value) = p.split_once('=').unwrap_or((p, ""));
            KeyValue {
                key: key.into(),
                value: value.into(),
                enabled: true,
            }
        })
        .collect()
}

/// Replaces the query of `url` with the enabled `params` (fragment kept).
fn with_query(url: &str, params: &[KeyValue]) -> String {
    let (rest, fragment) = url.split_once('#').map_or((url, ""), |(a, b)| (a, b));
    let base = rest.split('?').next().unwrap_or("");
    let query: Vec<String> = params
        .iter()
        .filter(|p| p.enabled)
        .map(|p| {
            if p.value.is_empty() {
                p.key.clone()
            } else {
                format!("{}={}", p.key, p.value)
            }
        })
        .collect();
    let mut out = base.to_owned();
    if !query.is_empty() {
        out = format!("{out}?{}", query.join("&"));
    }
    if !fragment.is_empty() {
        out = format!("{out}#{fragment}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_helpers_keep_text_as_typed() {
        let params = query_params("{{base}}/a?x=1&y={{v}}&flag#top");
        assert_eq!(
            params
                .iter()
                .map(|p| (p.key.as_str(), p.value.as_str()))
                .collect::<Vec<_>>(),
            [("x", "1"), ("y", "{{v}}"), ("flag", "")]
        );
        assert_eq!(
            with_query("{{base}}/a?old=1#top", &params),
            "{{base}}/a?x=1&y={{v}}&flag#top"
        );
    }

    #[test]
    fn detects_environment_and_globals() {
        let env = r#"{"name":"Dev","values":[{"key":"a","value":"1","enabled":true},{"key":"b","value":2,"enabled":false}]}"#;
        let Imported::Environment { name, variables } = import(env).unwrap() else {
            panic!("expected environment")
        };
        assert_eq!(name, "Dev");
        assert_eq!(variables[1].value, "2");
        assert!(!variables[1].enabled);

        let globals = r#"{"values":[{"key":"g","value":"x"}],"_postman_variable_scope":"globals"}"#;
        assert!(matches!(import(globals).unwrap(), Imported::Globals(v) if v.len() == 1));
        assert!(import("hola").is_err());
    }
}
