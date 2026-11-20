//! Executes a user's [`HttpRequest`] with reqwest and returns a [`HttpResponse`] with timings,
//! cookies and redirects, or a classified [`HttpError`]. Cancellation is the caller's job
//! (drop or abort the future).

use std::error::Error as StdError;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use base64::Engine;
use endpilot_core::http::{
    Cookie, FormFieldKind, HttpError, HttpErrorKind, HttpRequest, HttpResponse, KeyValue, Redirect,
    RequestBody, Timings,
};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue, USER_AGENT};
use reqwest::multipart;
use reqwest::redirect::Policy;

const MAX_REDIRECTS: usize = 10;

pub async fn send(req: HttpRequest) -> Result<HttpResponse, HttpError> {
    let url = parse_url(&req.url)?;
    let method =
        reqwest::Method::from_bytes(req.method.trim().to_uppercase().as_bytes()).map_err(|_| {
            HttpError::new(
                HttpErrorKind::InvalidRequest,
                format!("Método HTTP inválido: {}", req.method),
            )
        })?;

    let dns_ms = Arc::new(Mutex::new(None));
    let redirects = Arc::new(Mutex::new(Vec::new()));

    // shortcut: one client per request (needed for per-request DNS timing and redirect log); pool across requests if this shows up in profiles
    let mut client = reqwest::Client::builder()
        .dns_resolver(Arc::new(TimedResolver(dns_ms.clone())))
        .redirect(redirect_policy(req.follow_redirects, redirects.clone()));
    if let Some(ms) = req.timeout_ms.filter(|ms| *ms > 0) {
        client = client.timeout(Duration::from_millis(ms));
    }
    let client = client.build().map_err(classify)?;

    let user_headers = build_headers(&req.headers)?;
    let mut builder = client.request(method, url);
    builder = apply_body(builder, &req.body, &user_headers).await?;
    // Defaults first, then the user's headers replace them key by key.
    let mut headers = HeaderMap::new();
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static(concat!("Endpilot/", env!("CARGO_PKG_VERSION"))),
    );
    headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
    builder = builder.headers(headers).headers(user_headers);

    let start = Instant::now();
    let resp = builder.send().await.map_err(classify)?;
    let ttfb_ms = ms_since(start);

    let status = resp.status();
    let http_version = format!("{:?}", resp.version());
    let final_url = resp.url().to_string();
    let headers: Vec<KeyValue> = resp
        .headers()
        .iter()
        .map(|(k, v)| KeyValue {
            key: k.as_str().to_owned(),
            value: String::from_utf8_lossy(v.as_bytes()).into_owned(),
            enabled: true,
        })
        .collect();
    let headers_size = headers
        .iter()
        .map(|h| (h.key.len() + h.value.len() + 4) as u64)
        .sum();
    let cookies = resp.cookies().map(to_cookie).collect();

    let bytes = resp.bytes().await.map_err(classify)?;
    let total_ms = ms_since(start);

    // shortcut: non-UTF-8 text (e.g. latin-1 HTML) is shown as binary; decode by charset if users hit it
    let (body, body_is_base64) = match std::str::from_utf8(&bytes) {
        Ok(text) => (text.to_owned(), false),
        Err(_) => (
            base64::engine::general_purpose::STANDARD.encode(&bytes),
            true,
        ),
    };

    Ok(HttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or_default().to_owned(),
        http_version,
        url: final_url,
        headers,
        cookies,
        body,
        body_is_base64,
        body_size: bytes.len() as u64,
        headers_size,
        redirects: std::mem::take(&mut *redirects.lock().unwrap()),
        timings: Timings {
            dns_ms: *dns_ms.lock().unwrap(),
            ttfb_ms,
            download_ms: total_ms - ttfb_ms,
            total_ms,
        },
    })
}

/// Accepts URLs without a scheme (`localhost:3000/x`) like Postman does, defaulting to http.
fn parse_url(raw: &str) -> Result<reqwest::Url, HttpError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(HttpError::new(
            HttpErrorKind::InvalidUrl,
            "La URL está vacía",
        ));
    }
    let with_scheme = if raw.contains("://") {
        raw.to_owned()
    } else {
        format!("http://{raw}")
    };
    let url = reqwest::Url::parse(&with_scheme).map_err(|e| {
        HttpError::new(
            HttpErrorKind::InvalidUrl,
            format!("URL inválida ({e}): {raw}"),
        )
    })?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        s => Err(HttpError::new(
            HttpErrorKind::InvalidUrl,
            format!("Esquema no soportado: {s}"),
        )),
    }
}

fn build_headers(list: &[KeyValue]) -> Result<HeaderMap, HttpError> {
    let mut map = HeaderMap::new();
    for h in list
        .iter()
        .filter(|h| h.enabled && !h.key.trim().is_empty())
    {
        let name = HeaderName::from_bytes(h.key.trim().as_bytes()).map_err(|_| {
            HttpError::new(
                HttpErrorKind::InvalidRequest,
                format!("Nombre de header inválido: {}", h.key),
            )
        })?;
        let value = HeaderValue::from_str(&h.value).map_err(|_| {
            HttpError::new(
                HttpErrorKind::InvalidRequest,
                format!("Valor inválido en el header {}", h.key),
            )
        })?;
        map.append(name, value);
    }
    Ok(map)
}

async fn apply_body(
    builder: reqwest::RequestBuilder,
    body: &RequestBody,
    user_headers: &HeaderMap,
) -> Result<reqwest::RequestBuilder, HttpError> {
    Ok(match body {
        RequestBody::None => builder,
        RequestBody::Raw { content, language } => {
            let builder = builder.body(content.clone());
            if user_headers.contains_key(CONTENT_TYPE) {
                builder
            } else {
                builder.header(CONTENT_TYPE, language.content_type())
            }
        }
        RequestBody::Urlencoded { fields } => {
            let pairs: Vec<(&str, &str)> = fields
                .iter()
                .filter(|f| f.enabled && !f.key.is_empty())
                .map(|f| (f.key.as_str(), f.value.as_str()))
                .collect();
            builder.form(&pairs)
        }
        RequestBody::Formdata { fields } => {
            let mut form = multipart::Form::new();
            for f in fields.iter().filter(|f| f.enabled && !f.key.is_empty()) {
                form = match f.kind {
                    FormFieldKind::Text => form.text(f.key.clone(), f.value.clone()),
                    FormFieldKind::File => {
                        let bytes = tokio::fs::read(&f.value).await.map_err(|e| {
                            HttpError::new(
                                HttpErrorKind::File,
                                format!("No se pudo leer {}: {e}", f.value),
                            )
                        })?;
                        let name = std::path::Path::new(&f.value)
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default();
                        form.part(f.key.clone(), multipart::Part::bytes(bytes).file_name(name))
                    }
                };
            }
            builder.multipart(form)
        }
    })
}

fn redirect_policy(follow: bool, log: Arc<Mutex<Vec<Redirect>>>) -> Policy {
    if !follow {
        return Policy::none();
    }
    Policy::custom(move |attempt| {
        if attempt.previous().len() > MAX_REDIRECTS {
            return attempt.error(format!("más de {MAX_REDIRECTS} redirecciones"));
        }
        let from = attempt
            .previous()
            .last()
            .map(|u| u.to_string())
            .unwrap_or_default();
        log.lock().unwrap().push(Redirect {
            status: attempt.status().as_u16(),
            from,
            to: attempt.url().to_string(),
        });
        attempt.follow()
    })
}

fn to_cookie(c: reqwest::cookie::Cookie<'_>) -> Cookie {
    let same_site = if c.same_site_strict() {
        Some("Strict")
    } else if c.same_site_lax() {
        Some("Lax")
    } else {
        None
    };
    Cookie {
        name: c.name().to_owned(),
        value: c.value().to_owned(),
        domain: c.domain().map(str::to_owned),
        path: c.path().map(str::to_owned),
        expires_at_ms: c
            .expires()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64),
        max_age_secs: c.max_age().map(|d| d.as_secs()),
        http_only: c.http_only(),
        secure: c.secure(),
        same_site: same_site.map(str::to_owned),
    }
}

fn ms_since(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

/// Marker so DNS failures can be told apart from other connect errors.
#[derive(Debug)]
struct DnsError(String);

impl std::fmt::Display for DnsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl StdError for DnsError {}

/// System resolver that records how long the lookup took.
struct TimedResolver(Arc<Mutex<Option<f64>>>);

impl Resolve for TimedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let slot = self.0.clone();
        Box::pin(async move {
            let start = Instant::now();
            let host = name.as_str().to_owned();
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map_err(|e| {
                    Box::new(DnsError(format!("no se pudo resolver {host}: {e}")))
                        as Box<dyn StdError + Send + Sync>
                })?
                .collect();
            *slot.lock().unwrap() = Some(ms_since(start));
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

/// rustls errors arrive wrapped in one or more `io::Error`s, whose `source()` skips the wrapped value.
fn is_rustls(e: &(dyn StdError + 'static)) -> bool {
    if e.is::<rustls::Error>() {
        return true;
    }
    match e
        .downcast_ref::<std::io::Error>()
        .and_then(|io| io.get_ref())
    {
        Some(inner) => is_rustls(inner),
        None => false,
    }
}

fn classify(e: reqwest::Error) -> HttpError {
    let mut message = e.to_string();
    let (mut is_dns, mut is_tls) = (false, false);
    let mut source = e.source();
    while let Some(s) = source {
        is_dns |= s.downcast_ref::<DnsError>().is_some();
        is_tls |= is_rustls(s);
        message.push_str(": ");
        message.push_str(&s.to_string());
        source = s.source();
    }

    let kind = if e.is_timeout() {
        HttpErrorKind::Timeout
    } else if is_dns {
        HttpErrorKind::Dns
    } else if e.is_redirect() {
        HttpErrorKind::TooManyRedirects
    } else if e.is_builder() {
        HttpErrorKind::InvalidRequest
    } else if is_tls {
        HttpErrorKind::Tls
    } else if e.is_connect() || e.is_request() {
        HttpErrorKind::Connection
    } else if e.is_body() || e.is_decode() {
        HttpErrorKind::Body
    } else {
        HttpErrorKind::Other
    };
    HttpError::new(kind, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_without_scheme_defaults_to_http() {
        assert_eq!(
            parse_url("localhost:3000/a?b=1").unwrap().as_str(),
            "http://localhost:3000/a?b=1"
        );
        assert_eq!(parse_url("  ").unwrap_err().kind, HttpErrorKind::InvalidUrl);
        assert_eq!(
            parse_url("ftp://x").unwrap_err().kind,
            HttpErrorKind::InvalidUrl
        );
    }

    #[test]
    fn disabled_and_empty_headers_are_skipped() {
        let list = vec![
            KeyValue {
                key: "X-A".into(),
                value: "1".into(),
                enabled: true,
            },
            KeyValue {
                key: "X-B".into(),
                value: "2".into(),
                enabled: false,
            },
            KeyValue {
                key: " ".into(),
                value: "3".into(),
                enabled: true,
            },
        ];
        let map = build_headers(&list).unwrap();
        assert_eq!(map.len(), 1);
        assert_eq!(map["x-a"], "1");
    }
}
