//! OpenAPI 3.x (JSON or YAML) into a collection: one folder per tag, one request per operation.
//! Path params `{id}` become `{{id}}` variables; `servers[0]` becomes the `baseUrl` collection variable.

use endpilot_core::{
    http::{FormField, FormFieldKind, KeyValue, RawLanguage},
    model::{ApiKeyLocation, Auth, BodyMode, CollectionTree, RawBody, RequestSpec, TreeItem},
};
use serde_json::{Map, Value, json};

use crate::{non_empty, text_of, with_query};

const METHODS: [&str; 8] = [
    "get", "put", "post", "delete", "options", "head", "patch", "trace",
];
static NULL: Value = Value::Null;

/// Follows local `$ref`s (`#/components/...`).
fn deref<'a>(doc: &'a Value, mut v: &'a Value) -> &'a Value {
    for _ in 0..32 {
        match v["$ref"].as_str().and_then(|r| r.strip_prefix('#')) {
            Some(pointer) => v = doc.pointer(pointer).unwrap_or(&NULL),
            None => break,
        }
    }
    v
}

pub(crate) fn import_openapi(doc: &Value) -> Result<CollectionTree, String> {
    if !doc["openapi"].as_str().is_some_and(|v| v.starts_with('3')) {
        return Err(
            "Solo se importa OpenAPI 3.x. Para Swagger 2.0, conviértelo primero a OpenAPI 3."
                .into(),
        );
    }

    let server = &doc["servers"][0];
    let mut base_url = text_of(&server["url"]);
    for (name, var) in server["variables"].as_object().into_iter().flatten() {
        base_url = base_url.replace(&format!("{{{name}}}"), &text_of(&var["default"]));
    }
    let base_url = base_url.trim_end_matches('/').to_owned();

    let mut root: Vec<TreeItem> = vec![];
    for (path, path_item) in doc["paths"].as_object().into_iter().flatten() {
        let path_item = deref(doc, path_item);
        for method in METHODS {
            let op = &path_item[method];
            if op.is_null() {
                continue;
            }
            let request = operation(doc, path, method, path_item, op);
            let name = non_empty(
                text_of(&op["summary"]),
                &non_empty(
                    text_of(&op["operationId"]),
                    &format!("{} {path}", method.to_uppercase()),
                ),
            );
            let item = TreeItem::Request { name, request };
            match op["tags"][0].as_str() {
                Some(tag) => folder(&mut root, tag).push(item),
                None => root.push(item),
            }
        }
    }

    Ok(CollectionTree {
        name: non_empty(text_of(&doc["info"]["title"]), "API importada"),
        variables: vec![KeyValue {
            key: "baseUrl".into(),
            value: base_url,
            enabled: true,
        }],
        // Security is resolved per operation onto each request.
        settings: Default::default(),
        items: root,
    })
}

/// The folder named `tag` at the root, created on first use.
fn folder<'a>(root: &'a mut Vec<TreeItem>, tag: &str) -> &'a mut Vec<TreeItem> {
    let at = root
        .iter()
        .position(|i| matches!(i, TreeItem::Folder { name, .. } if name == tag))
        .unwrap_or_else(|| {
            root.push(TreeItem::Folder {
                name: tag.into(),
                settings: Default::default(),
                items: vec![],
            });
            root.len() - 1
        });
    match &mut root[at] {
        TreeItem::Folder { items, .. } => items,
        TreeItem::Request { .. } => unreachable!(),
    }
}

fn operation(doc: &Value, path: &str, method: &str, path_item: &Value, op: &Value) -> RequestSpec {
    let mut spec = RequestSpec {
        method: method.to_uppercase(),
        auth: security(doc, op),
        ..Default::default()
    };

    // Operation params override path-level ones with the same name and location.
    let mut params: Vec<&Value> = vec![];
    for p in [&path_item["parameters"], &op["parameters"]]
        .into_iter()
        .filter_map(Value::as_array)
        .flatten()
        .map(|p| deref(doc, p))
    {
        params.retain(|q| q["name"] != p["name"] || q["in"] != p["in"]);
        params.push(p);
    }
    for p in params {
        let row = KeyValue {
            key: text_of(&p["name"]),
            value: example_text(doc, p),
            enabled: p["required"].as_bool().unwrap_or(false),
        };
        match p["in"].as_str() {
            Some("query") => spec.params.push(row),
            Some("header") => spec.headers.push(KeyValue {
                enabled: true,
                ..row
            }),
            _ => {}
        }
    }
    let path = path.replace('{', "{{").replace('}', "}}");
    spec.url = with_query(&format!("{{{{baseUrl}}}}{path}"), &spec.params);

    let body = deref(doc, &op["requestBody"]);
    if let Some(content) = body["content"].as_object() {
        let pick = |pred: fn(&str) -> bool| content.iter().find(|(ct, _)| pred(ct));
        if let Some((_, media)) = pick(|ct| ct.contains("json")) {
            spec.body_mode = BodyMode::Raw;
            spec.raw = RawBody {
                content: serde_json::to_string_pretty(&media_example(doc, media))
                    .unwrap_or_default(),
                language: RawLanguage::Json,
            };
        } else if let Some((ct, media)) = pick(|ct| ct.contains("form")) {
            let schema = deref(doc, &media["schema"]);
            let props = schema["properties"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            if ct.contains("multipart") {
                spec.body_mode = BodyMode::Formdata;
                spec.formdata = props
                    .iter()
                    .map(|(k, s)| {
                        let s = deref(doc, s);
                        let file = s["format"] == "binary" || s["format"] == "base64";
                        FormField {
                            key: k.clone(),
                            value: if file {
                                String::new()
                            } else {
                                scalar_text(&sample(doc, s, 0))
                            },
                            kind: if file {
                                FormFieldKind::File
                            } else {
                                FormFieldKind::Text
                            },
                            enabled: true,
                        }
                    })
                    .collect();
            } else {
                spec.body_mode = BodyMode::Urlencoded;
                spec.urlencoded = props
                    .iter()
                    .map(|(k, s)| KeyValue {
                        key: k.clone(),
                        value: scalar_text(&sample(doc, deref(doc, s), 0)),
                        enabled: true,
                    })
                    .collect();
            }
        } else if let Some((ct, media)) = content.iter().next() {
            spec.body_mode = BodyMode::Raw;
            spec.raw = RawBody {
                content: scalar_text(&media_example(doc, media)),
                language: if ct.contains("xml") {
                    RawLanguage::Xml
                } else {
                    RawLanguage::Text
                },
            };
        }
    }
    spec
}

fn scalar_text(v: &Value) -> String {
    match v {
        Value::Object(_) | Value::Array(_) => v.to_string(),
        other => text_of(other),
    }
}

fn example_text(doc: &Value, param: &Value) -> String {
    if !param["example"].is_null() {
        return scalar_text(&param["example"]);
    }
    let schema = deref(doc, &param["schema"]);
    match (&schema["example"], &schema["default"]) {
        (e, _) if !e.is_null() => scalar_text(e),
        (_, d) if !d.is_null() => scalar_text(d),
        _ => String::new(),
    }
}

fn media_example(doc: &Value, media: &Value) -> Value {
    if !media["example"].is_null() {
        return media["example"].clone();
    }
    if let Some((_, ex)) = media["examples"].as_object().and_then(|e| e.iter().next()) {
        return deref(doc, ex)["value"].clone();
    }
    sample(doc, deref(doc, &media["schema"]), 0)
}

/// A plausible example value for a schema, for request bodies.
fn sample(doc: &Value, schema: &Value, depth: usize) -> Value {
    if depth > 8 {
        return Value::Null;
    }
    for key in ["example", "default"] {
        if !schema[key].is_null() {
            return schema[key].clone();
        }
    }
    if let Some(first) = schema["enum"].get(0) {
        return first.clone();
    }
    if let Some(all) = schema["allOf"].as_array() {
        let mut merged = Map::new();
        for part in all {
            if let Value::Object(obj) = sample(doc, deref(doc, part), depth + 1) {
                merged.extend(obj);
            }
        }
        return Value::Object(merged);
    }
    for key in ["oneOf", "anyOf"] {
        if let Some(first) = schema[key].get(0) {
            return sample(doc, deref(doc, first), depth + 1);
        }
    }
    let ty = match &schema["type"] {
        // OpenAPI 3.1: ["string", "null"].
        Value::Array(types) => types
            .iter()
            .find(|t| *t != "null")
            .and_then(Value::as_str)
            .unwrap_or(""),
        t => t.as_str().unwrap_or(if schema["properties"].is_object() {
            "object"
        } else {
            ""
        }),
    };
    match ty {
        "object" => Value::Object(
            schema["properties"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(k, s)| (k.clone(), sample(doc, deref(doc, s), depth + 1)))
                .collect(),
        ),
        "array" => json!([sample(doc, deref(doc, &schema["items"]), depth + 1)]),
        "integer" | "number" => json!(0),
        "boolean" => json!(true),
        "string" => json!(match schema["format"].as_str() {
            Some("date-time") => "2024-01-01T00:00:00Z",
            Some("date") => "2024-01-01",
            Some("email") => "user@example.com",
            Some("uuid") => "00000000-0000-0000-0000-000000000000",
            Some("uri" | "url") => "https://example.com",
            _ => "string",
        }),
        _ => Value::Null,
    }
}

/// First security scheme that applies (operation-level wins; `security: []` means none).
fn security(doc: &Value, op: &Value) -> Auth {
    let requirements = if op["security"].is_array() {
        &op["security"]
    } else {
        &doc["security"]
    };
    let Some(name) = requirements[0].as_object().and_then(|r| r.keys().next()) else {
        return Auth::None;
    };
    let scheme = deref(doc, &doc["components"]["securitySchemes"][name]);
    match (
        scheme["type"].as_str(),
        scheme["scheme"]
            .as_str()
            .map(str::to_ascii_lowercase)
            .as_deref(),
    ) {
        (Some("http"), Some("basic")) => Auth::Basic {
            username: "{{username}}".into(),
            password: "{{password}}".into(),
        },
        (Some("http"), _) => Auth::Bearer {
            token: "{{bearerToken}}".into(),
        },
        (Some("apiKey"), _) if scheme["in"] != "cookie" => Auth::Apikey {
            key: text_of(&scheme["name"]),
            value: "{{apiKey}}".into(),
            location: if scheme["in"] == "query" {
                ApiKeyLocation::Query
            } else {
                ApiKeyLocation::Header
            },
        },
        (Some("oauth2" | "openIdConnect"), _) => Auth::Bearer {
            token: "{{accessToken}}".into(),
        },
        _ => Auth::None,
    }
}
