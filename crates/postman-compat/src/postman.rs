//! Postman Collection v2.1 / v2.0 and environments.
//!
//! Known limits (documented in README): scripts, examples, descriptions and auth types other than
//! Bearer/Basic/API key are dropped. Inherited auth (folder/collection) is resolved onto each request.

use endpilot_core::{
    http::{FormField, FormFieldKind, KeyValue, RawLanguage},
    model::{ApiKeyLocation, Auth, BodyMode, CollectionTree, RawBody, RequestSpec, TreeItem},
};
use serde_json::{Map, Value, json};

use crate::{kv_list, non_empty, query_params, text_of};

const SCHEMA_V21: &str = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

pub(crate) fn import_collection(doc: &Value) -> CollectionTree {
    let inherited = parse_auth(&doc["auth"]).unwrap_or_default();
    CollectionTree {
        name: non_empty(text_of(&doc["info"]["name"]), "Colección importada"),
        variables: kv_list(&doc["variable"]),
        items: import_items(&doc["item"], &inherited),
    }
}

fn import_items(items: &Value, inherited: &Auth) -> Vec<TreeItem> {
    items
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|it| {
            let name = text_of(&it["name"]);
            if it["item"].is_array() {
                let auth = parse_auth(&it["auth"]).unwrap_or_else(|| inherited.clone());
                Some(TreeItem::Folder {
                    name: non_empty(name, "Carpeta"),
                    items: import_items(&it["item"], &auth),
                })
            } else if !it["request"].is_null() {
                let request = import_request(&it["request"], inherited);
                Some(TreeItem::Request {
                    name: non_empty(name, &request.url),
                    request,
                })
            } else {
                None
            }
        })
        .collect()
}

/// `None` when the item inherits auth from its parent (absent or `inherit`).
fn parse_auth(auth: &Value) -> Option<Auth> {
    let param = |key: &str| -> String {
        let ty = text_of(&auth["type"]);
        match &auth[ty.as_str()] {
            // v2.1: [{ "key": "token", "value": "…" }]
            Value::Array(list) => list
                .iter()
                .find(|p| p["key"] == key)
                .map(|p| text_of(&p["value"]))
                .unwrap_or_default(),
            // v2.0: { "token": "…" }
            other => text_of(&other[key]),
        }
    };
    match auth["type"].as_str()? {
        "inherit" => None,
        "bearer" => Some(Auth::Bearer {
            token: param("token"),
        }),
        "basic" => Some(Auth::Basic {
            username: param("username"),
            password: param("password"),
        }),
        "apikey" => Some(Auth::Apikey {
            key: param("key"),
            value: param("value"),
            location: if param("in") == "query" {
                ApiKeyLocation::Query
            } else {
                ApiKeyLocation::Header
            },
        }),
        // noauth and types we do not support yet (oauth2, digest…).
        _ => Some(Auth::None),
    }
}

fn import_request(r: &Value, inherited: &Auth) -> RequestSpec {
    // v2.0 allows a request to be just its URL.
    if let Some(url) = r.as_str() {
        return RequestSpec {
            url: url.into(),
            params: query_params(url),
            auth: inherited.clone(),
            ..Default::default()
        };
    }
    let (url, params) = match &r["url"] {
        Value::String(raw) => (raw.clone(), query_params(raw)),
        obj @ Value::Object(_) => {
            let raw = text_of(&obj["raw"]);
            let params = if obj["query"].is_array() {
                kv_list(&obj["query"])
            } else {
                query_params(&raw)
            };
            (raw, params)
        }
        _ => (String::new(), vec![]),
    };
    let headers = match &r["header"] {
        // v2.0 also allows "Key: value\nKey2: value2".
        Value::String(text) => text
            .lines()
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| KeyValue {
                key: k.trim().into(),
                value: v.trim().into(),
                enabled: true,
            })
            .collect(),
        list => kv_list(list),
    };

    let mut spec = RequestSpec {
        method: non_empty(text_of(&r["method"]).to_uppercase(), "GET"),
        url,
        params,
        headers,
        auth: parse_auth(&r["auth"]).unwrap_or_else(|| inherited.clone()),
        ..Default::default()
    };

    let body = &r["body"];
    match body["mode"].as_str() {
        Some("raw") => {
            let language = match body["options"]["raw"]["language"].as_str() {
                Some("json") => RawLanguage::Json,
                Some("xml") => RawLanguage::Xml,
                Some("html") => RawLanguage::Html,
                Some("javascript") => RawLanguage::Javascript,
                Some(_) => RawLanguage::Text,
                // No language: guess from the Content-Type header, like Postman.
                None if spec.headers.iter().any(|h| {
                    h.key.eq_ignore_ascii_case("content-type") && h.value.contains("json")
                }) =>
                {
                    RawLanguage::Json
                }
                None => RawLanguage::Text,
            };
            spec.body_mode = BodyMode::Raw;
            spec.raw = RawBody {
                content: text_of(&body["raw"]),
                language,
            };
        }
        Some("urlencoded") => {
            spec.body_mode = BodyMode::Urlencoded;
            spec.urlencoded = kv_list(&body["urlencoded"]);
        }
        Some("formdata") => {
            spec.body_mode = BodyMode::Formdata;
            spec.formdata = body["formdata"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|f| {
                    let file = f["type"] == "file";
                    // File paths are dropped: a shared collection must not make us upload
                    // local files the user never picked (e.g. ~/.ssh/id_rsa). They re-pick it.
                    let value = if file {
                        String::new()
                    } else {
                        text_of(&f["value"])
                    };
                    FormField {
                        key: text_of(&f["key"]),
                        value,
                        kind: if file {
                            FormFieldKind::File
                        } else {
                            FormFieldKind::Text
                        },
                        enabled: !f["disabled"].as_bool().unwrap_or(false),
                    }
                })
                .collect();
        }
        _ => {}
    }
    spec
}

pub fn export_collection(tree: &CollectionTree) -> Value {
    json!({
        "info": { "name": tree.name, "schema": SCHEMA_V21 },
        "item": tree.items.iter().map(export_item).collect::<Vec<_>>(),
        "variable": kv_rows(&tree.variables, "string"),
    })
}

fn export_item(item: &TreeItem) -> Value {
    match item {
        TreeItem::Folder { name, items } => {
            json!({ "name": name, "item": items.iter().map(export_item).collect::<Vec<_>>() })
        }
        TreeItem::Request { name, request } => {
            json!({ "name": name, "request": export_request(request) })
        }
    }
}

/// `[{ key, value, type, disabled? }]`, `disabled` only when true (as Postman writes it).
fn kv_rows(rows: &[KeyValue], ty: &str) -> Vec<Value> {
    rows.iter()
        .map(|r| {
            let mut row = json!({ "key": r.key, "value": r.value, "type": ty });
            if !r.enabled {
                row["disabled"] = true.into();
            }
            row
        })
        .collect()
}

fn export_request(spec: &RequestSpec) -> Value {
    let mut req = json!({
        "method": spec.method,
        "header": kv_rows(&spec.headers, "text"),
        "url": export_url(&spec.url, &spec.params),
        "auth": export_auth(&spec.auth),
    });
    let body = match spec.body_mode {
        BodyMode::None => None,
        BodyMode::Raw => Some(json!({
            "mode": "raw",
            "raw": spec.raw.content,
            "options": { "raw": { "language": spec.raw.language } },
        })),
        BodyMode::Urlencoded => Some(json!({
            "mode": "urlencoded",
            "urlencoded": kv_rows(&spec.urlencoded, "text"),
        })),
        BodyMode::Formdata => Some(json!({
            "mode": "formdata",
            "formdata": spec.formdata.iter().map(|f| {
                let mut row = match f.kind {
                    FormFieldKind::Text => json!({ "key": f.key, "value": f.value, "type": "text" }),
                    FormFieldKind::File => json!({ "key": f.key, "src": f.value, "type": "file" }),
                };
                if !f.enabled {
                    row["disabled"] = true.into();
                }
                row
            }).collect::<Vec<_>>(),
        })),
    };
    if let Some(body) = body {
        req["body"] = body;
    }
    req
}

fn export_auth(auth: &Auth) -> Value {
    let params = |pairs: &[(&str, &str)]| -> Vec<Value> {
        pairs
            .iter()
            .map(|(k, v)| json!({ "key": k, "value": v, "type": "string" }))
            .collect()
    };
    match auth {
        Auth::None => json!({ "type": "noauth" }),
        Auth::Bearer { token } => {
            json!({ "type": "bearer", "bearer": params(&[("token", token)]) })
        }
        Auth::Basic { username, password } => json!({
            "type": "basic",
            "basic": params(&[("username", username), ("password", password)]),
        }),
        Auth::Apikey {
            key,
            value,
            location,
        } => {
            let place = match location {
                ApiKeyLocation::Header => "header",
                ApiKeyLocation::Query => "query",
            };
            json!({ "type": "apikey", "apikey": params(&[("key", key), ("value", value), ("in", place)]) })
        }
    }
}

/// Postman's URL object. `raw` is authoritative; the split parts help Postman's own UI.
fn export_url(raw: &str, params: &[KeyValue]) -> Value {
    let mut url = Map::new();
    url.insert("raw".into(), raw.into());
    let base = raw.split(['?', '#']).next().unwrap_or("");
    let rest = match base.split_once("://") {
        Some((protocol, rest)) => {
            url.insert("protocol".into(), protocol.into());
            rest
        }
        None => base,
    };
    let (host_port, path) = rest.split_once('/').unwrap_or((rest, ""));
    let host = match host_port.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => {
            url.insert("port".into(), port.into());
            host
        }
        _ => host_port,
    };
    if !host.is_empty() {
        url.insert("host".into(), host.split('.').collect::<Vec<_>>().into());
    }
    if !path.is_empty() {
        url.insert("path".into(), path.split('/').collect::<Vec<_>>().into());
    }
    if !params.is_empty() {
        url.insert("query".into(), kv_rows(params, "text").into());
    }
    Value::Object(url)
}

pub fn export_environment(name: &str, variables: &[KeyValue]) -> Value {
    json!({
        "name": name,
        "values": variables.iter().map(|v| json!({
            "key": v.key, "value": v.value, "type": "default", "enabled": v.enabled,
        })).collect::<Vec<_>>(),
        "_postman_variable_scope": "environment",
        "_postman_exported_using": concat!("Endpilot/", env!("CARGO_PKG_VERSION")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_object_splits_parts() {
        let params = vec![KeyValue {
            key: "q".into(),
            value: "1".into(),
            enabled: false,
        }];
        let url = export_url("https://api.example.com:8443/v1/users?x=2", &params);
        assert_eq!(url["protocol"], "https");
        assert_eq!(url["host"], json!(["api", "example", "com"]));
        assert_eq!(url["port"], "8443");
        assert_eq!(url["path"], json!(["v1", "users"]));
        assert_eq!(url["query"][0]["disabled"], true);

        let url = export_url("{{baseUrl}}/users", &[]);
        assert_eq!(url["host"], json!(["{{baseUrl}}"]));
        assert!(url.get("protocol").is_none());
    }

    #[test]
    fn auth_inherits_down_the_tree_unless_overridden() {
        let doc = json!({
            "info": { "name": "C" },
            "auth": { "type": "bearer", "bearer": [{ "key": "token", "value": "{{t}}" }] },
            "item": [
                { "name": "F", "auth": { "type": "noauth" }, "item": [
                    { "name": "in folder", "request": { "method": "GET", "url": "x" } }
                ]},
                { "name": "root", "request": { "method": "GET", "url": "x", "auth": { "type": "inherit" } } },
                { "name": "v2.0", "request": { "url": "x", "auth": { "type": "basic", "basic": { "username": "u", "password": "p" } } } },
            ]
        });
        let tree = import_collection(&doc);
        let auth_of = |item: &TreeItem| match item {
            TreeItem::Request { request, .. } => request.auth.clone(),
            TreeItem::Folder { items, .. } => match &items[0] {
                TreeItem::Request { request, .. } => request.auth.clone(),
                _ => unreachable!(),
            },
        };
        assert_eq!(auth_of(&tree.items[0]), Auth::None);
        assert_eq!(
            auth_of(&tree.items[1]),
            Auth::Bearer {
                token: "{{t}}".into()
            }
        );
        assert_eq!(
            auth_of(&tree.items[2]),
            Auth::Basic {
                username: "u".into(),
                password: "p".into()
            }
        );
    }
}
