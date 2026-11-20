use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Redirect};
use axum::routing::{any, get};
use endpilot_core::http::{
    FormField, FormFieldKind, HttpErrorKind, HttpRequest, KeyValue, RawLanguage, RequestBody,
};

/// Echoes method, content-type, user-agent, a custom header and the body.
async fn echo(method: axum::http::Method, headers: HeaderMap, body: Bytes) -> String {
    let h = |n: &str| {
        headers
            .get(n)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned()
    };
    format!(
        "{}|{}|{}|{}|{}",
        method,
        h("content-type"),
        h("user-agent"),
        h("x-test"),
        String::from_utf8_lossy(&body)
    )
}

async fn server() -> String {
    let app = Router::new()
        .route("/echo", any(echo))
        .route("/redirect", get(|| async { Redirect::temporary("/echo") }))
        .route("/loop", get(|| async { Redirect::temporary("/loop") }))
        .route(
            "/slow",
            get(|| async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                "late"
            }),
        )
        .route(
            "/cookie",
            get(|| async {
                (
                    [(
                        header::SET_COOKIE,
                        "session=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=60",
                    )],
                    "ok",
                )
            }),
        )
        .route(
            "/binary",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "image/png")],
                    vec![0x89u8, 0x50, 0xff, 0x00],
                )
            }),
        )
        .route(
            "/teapot",
            get(|| async { (StatusCode::IM_A_TEAPOT, "short and stout").into_response() }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

fn get_req(url: String) -> HttpRequest {
    HttpRequest {
        method: "GET".into(),
        url,
        headers: vec![],
        body: RequestBody::None,
        timeout_ms: None,
        follow_redirects: true,
    }
}

fn kv(key: &str, value: &str) -> KeyValue {
    KeyValue {
        key: key.into(),
        value: value.into(),
        enabled: true,
    }
}

#[tokio::test]
async fn raw_json_sets_content_type_and_user_headers_apply() {
    let base = server().await;
    let mut req = get_req(format!("{base}/echo"));
    req.method = "post".into();
    req.headers = vec![
        kv("X-Test", "yes"),
        KeyValue {
            key: "X-Off".into(),
            value: "x".into(),
            enabled: false,
        },
    ];
    req.body = RequestBody::Raw {
        content: r#"{"a":1}"#.into(),
        language: RawLanguage::Json,
    };

    let res = endpilot_http::send(req).await.unwrap();
    assert_eq!(res.status, 200);
    assert!(
        res.body.starts_with(r#"POST|application/json|Endpilot/"#),
        "{}",
        res.body
    );
    assert!(res.body.ends_with(r#"|yes|{"a":1}"#), "{}", res.body);
    assert_eq!(res.body_size, res.body.len() as u64);
    assert!(res.timings.total_ms >= res.timings.ttfb_ms);
    assert_eq!(res.http_version, "HTTP/1.1");
}

#[tokio::test]
async fn user_content_type_wins_over_raw_language() {
    let base = server().await;
    let mut req = get_req(format!("{base}/echo"));
    req.method = "POST".into();
    req.headers = vec![kv("Content-Type", "application/vnd.api+json")];
    req.body = RequestBody::Raw {
        content: "{}".into(),
        language: RawLanguage::Json,
    };
    let res = endpilot_http::send(req).await.unwrap();
    assert!(
        res.body.starts_with("POST|application/vnd.api+json|"),
        "{}",
        res.body
    );
}

#[tokio::test]
async fn urlencoded_and_multipart_bodies() {
    let base = server().await;
    let mut req = get_req(format!("{base}/echo"));
    req.method = "POST".into();
    req.body = RequestBody::Urlencoded {
        fields: vec![kv("a", "1 2"), kv("b", "&")],
    };
    let res = endpilot_http::send(req.clone()).await.unwrap();
    assert!(
        res.body.contains("application/x-www-form-urlencoded"),
        "{}",
        res.body
    );
    assert!(res.body.ends_with("|a=1+2&b=%26"), "{}", res.body);

    let file = std::env::temp_dir().join("endpilot-upload-test.txt");
    std::fs::write(&file, "file-content").unwrap();
    req.body = RequestBody::Formdata {
        fields: vec![
            FormField {
                key: "name".into(),
                value: "ana".into(),
                kind: FormFieldKind::Text,
                enabled: true,
            },
            FormField {
                key: "doc".into(),
                value: file.to_string_lossy().into_owned(),
                kind: FormFieldKind::File,
                enabled: true,
            },
        ],
    };
    let res = endpilot_http::send(req.clone()).await.unwrap();
    assert!(
        res.body.contains("multipart/form-data; boundary="),
        "{}",
        res.body
    );
    assert!(
        res.body.contains("filename=\"endpilot-upload-test.txt\""),
        "{}",
        res.body
    );
    assert!(
        res.body.contains("file-content") && res.body.contains("ana"),
        "{}",
        res.body
    );

    req.body = RequestBody::Formdata {
        fields: vec![FormField {
            key: "doc".into(),
            value: "Z:/no/such/file.bin".into(),
            kind: FormFieldKind::File,
            enabled: true,
        }],
    };
    assert_eq!(
        endpilot_http::send(req).await.unwrap_err().kind,
        HttpErrorKind::File
    );
}

#[tokio::test]
async fn redirects_are_followed_and_logged() {
    let base = server().await;
    let res = endpilot_http::send(get_req(format!("{base}/redirect")))
        .await
        .unwrap();
    assert_eq!(res.status, 200);
    assert_eq!(res.url, format!("{base}/echo"));
    assert_eq!(res.redirects.len(), 1);
    assert_eq!(res.redirects[0].status, 307);
    assert_eq!(res.redirects[0].from, format!("{base}/redirect"));

    let mut req = get_req(format!("{base}/redirect"));
    req.follow_redirects = false;
    let res = endpilot_http::send(req).await.unwrap();
    assert_eq!(res.status, 307);
    assert!(res.redirects.is_empty());

    let err = endpilot_http::send(get_req(format!("{base}/loop")))
        .await
        .unwrap_err();
    assert_eq!(err.kind, HttpErrorKind::TooManyRedirects, "{}", err.message);
}

#[tokio::test]
async fn cookies_status_text_and_binary_body() {
    let base = server().await;
    let res = endpilot_http::send(get_req(format!("{base}/cookie")))
        .await
        .unwrap();
    let c = &res.cookies[0];
    assert_eq!((c.name.as_str(), c.value.as_str()), ("session", "abc"));
    assert!(c.http_only && !c.secure);
    assert_eq!(c.same_site.as_deref(), Some("Lax"));
    assert_eq!(c.max_age_secs, Some(60));

    let res = endpilot_http::send(get_req(format!("{base}/binary")))
        .await
        .unwrap();
    assert!(res.body_is_base64);
    assert_eq!(res.body, "iVD/AA==");
    assert_eq!(res.body_size, 4);

    let res = endpilot_http::send(get_req(format!("{base}/teapot")))
        .await
        .unwrap();
    assert_eq!(
        (res.status, res.status_text.as_str()),
        (418, "I'm a teapot")
    );
}

#[tokio::test]
async fn errors_are_classified() {
    let base = server().await;

    let mut req = get_req(format!("{base}/slow"));
    req.timeout_ms = Some(200);
    assert_eq!(
        endpilot_http::send(req).await.unwrap_err().kind,
        HttpErrorKind::Timeout
    );

    // Grab a free port, then close it so the connection is refused.
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let err = endpilot_http::send(get_req(format!("http://127.0.0.1:{port}/")))
        .await
        .unwrap_err();
    assert_eq!(err.kind, HttpErrorKind::Connection, "{}", err.message);

    // TLS handshake against a plain-HTTP server fails.
    let err = endpilot_http::send(get_req(base.replace("http://", "https://")))
        .await
        .unwrap_err();
    assert_eq!(err.kind, HttpErrorKind::Tls, "{}", err.message);

    let err = endpilot_http::send(get_req("http://endpilot-test.invalid/".into()))
        .await
        .unwrap_err();
    assert_eq!(err.kind, HttpErrorKind::Dns, "{}", err.message);

    let mut req = get_req(format!("{base}/echo"));
    req.method = "GE T".into();
    assert_eq!(
        endpilot_http::send(req).await.unwrap_err().kind,
        HttpErrorKind::InvalidRequest
    );

    let mut req = get_req(format!("{base}/echo"));
    req.headers = vec![kv("Bad Header", "x")];
    assert_eq!(
        endpilot_http::send(req).await.unwrap_err().kind,
        HttpErrorKind::InvalidRequest
    );
}

#[tokio::test]
async fn dns_time_is_recorded_for_hostnames() {
    let base = server().await.replace("127.0.0.1", "localhost");
    let res = endpilot_http::send(get_req(format!("{base}/echo")))
        .await
        .unwrap();
    assert!(res.timings.dns_ms.is_some());
}
