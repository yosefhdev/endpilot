//! Request/response types sent between the UI and the HTTP engine.
//! Body modes follow Postman's names (`raw`, `urlencoded`, `formdata`) to keep import/export lossless.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyValue {
    pub key: String,
    pub value: String,
    #[serde(default = "enabled")]
    pub enabled: bool,
}

fn enabled() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RawLanguage {
    Text,
    Json,
    Xml,
    Html,
    Javascript,
}

impl RawLanguage {
    /// Content-Type sent when the user has not set one.
    pub fn content_type(self) -> &'static str {
        match self {
            Self::Text => "text/plain",
            Self::Json => "application/json",
            Self::Xml => "application/xml",
            Self::Html => "text/html",
            Self::Javascript => "application/javascript",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FormFieldKind {
    Text,
    /// `value` is a local file path.
    File,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormField {
    pub key: String,
    pub value: String,
    pub kind: FormFieldKind,
    #[serde(default = "enabled")]
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum RequestBody {
    #[default]
    None,
    Raw {
        content: String,
        language: RawLanguage,
    },
    Urlencoded {
        fields: Vec<KeyValue>,
    },
    Formdata {
        fields: Vec<FormField>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub method: String,
    /// Full URL including the query string (the UI keeps params and URL in sync).
    pub url: String,
    #[serde(default)]
    pub headers: Vec<KeyValue>,
    #[serde(default)]
    pub body: RequestBody,
    /// `None` means no timeout.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default = "enabled")]
    pub follow_redirects: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cookie {
    pub name: String,
    pub value: String,
    pub domain: Option<String>,
    pub path: Option<String>,
    /// Unix epoch milliseconds, when the cookie sets `Expires`.
    pub expires_at_ms: Option<u64>,
    pub max_age_secs: Option<u64>,
    pub http_only: bool,
    pub secure: bool,
    pub same_site: Option<String>,
}

/// Durations in milliseconds. `dns_ms` is `None` when no lookup happened (IP literal, proxy, reused connection).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Timings {
    pub dns_ms: Option<f64>,
    /// From sending until response headers arrive (includes connect, TLS and server time).
    pub ttfb_ms: f64,
    pub download_ms: f64,
    pub total_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Redirect {
    pub status: u16,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub http_version: String,
    /// Final URL after redirects.
    pub url: String,
    pub headers: Vec<KeyValue>,
    pub cookies: Vec<Cookie>,
    /// UTF-8 text, or base64 when `body_is_base64`.
    pub body: String,
    pub body_is_base64: bool,
    /// Decoded body size in bytes.
    pub body_size: u64,
    pub headers_size: u64,
    pub redirects: Vec<Redirect>,
    pub timings: Timings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HttpErrorKind {
    InvalidUrl,
    InvalidRequest,
    Dns,
    Connection,
    Tls,
    Timeout,
    TooManyRedirects,
    Body,
    File,
    Cancelled,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpError {
    pub kind: HttpErrorKind,
    pub message: String,
}

impl HttpError {
    pub fn new(kind: HttpErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for HttpError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_uses_postman_mode_tags() {
        let raw = RequestBody::Raw {
            content: "{}".into(),
            language: RawLanguage::Json,
        };
        assert_eq!(
            serde_json::to_value(&raw).unwrap(),
            serde_json::json!({"mode": "raw", "content": "{}", "language": "json"})
        );
        assert_eq!(
            serde_json::to_value(RequestBody::None).unwrap(),
            serde_json::json!({"mode": "none"})
        );
    }

    #[test]
    fn request_defaults_when_fields_missing() {
        let req: HttpRequest =
            serde_json::from_str(r#"{"method":"GET","url":"http://x"}"#).unwrap();
        assert!(req.follow_redirects);
        assert_eq!(req.body, RequestBody::None);
        let kv: KeyValue = serde_json::from_str(r#"{"key":"a","value":"b"}"#).unwrap();
        assert!(kv.enabled);
    }
}
