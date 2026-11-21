//! `curl …` commands (bash syntax, as "Copy as cURL" produces) into a request.

use endpilot_core::{
    http::{FormField, FormFieldKind, KeyValue, RawLanguage},
    model::{Auth, BodyMode, RawBody, RequestSpec},
};

use crate::{query_params, with_query};

/// Splits like a POSIX shell: quotes, backslash escapes and line continuations (`\`, `^`, `` ` ``).
fn tokenize(text: &str) -> Result<Vec<String>, String> {
    let unclosed = || "Comillas sin cerrar en el comando cURL.".to_owned();
    let mut out = vec![];
    let mut cur = String::new();
    let mut in_token = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                in_token = true;
                loop {
                    match chars.next().ok_or_else(unclosed)? {
                        '\'' => break,
                        ch => cur.push(ch),
                    }
                }
            }
            '"' => {
                in_token = true;
                loop {
                    match chars.next().ok_or_else(unclosed)? {
                        '"' => break,
                        '\\' => match chars.next().ok_or_else(unclosed)? {
                            n @ ('"' | '\\' | '$' | '`') => cur.push(n),
                            '\n' => {}
                            n => {
                                cur.push('\\');
                                cur.push(n);
                            }
                        },
                        ch => cur.push(ch),
                    }
                }
            }
            '\\' | '^' | '`' if matches!(chars.peek(), Some('\n' | '\r')) => {
                // Line continuation.
                if chars.next() == Some('\r') && chars.peek() == Some(&'\n') {
                    chars.next();
                }
            }
            '\\' => {
                if let Some(n) = chars.next() {
                    cur.push(n);
                    in_token = true;
                }
            }
            c if c.is_whitespace() => {
                if in_token {
                    out.push(std::mem::take(&mut cur));
                    in_token = false;
                }
            }
            c => {
                cur.push(c);
                in_token = true;
            }
        }
    }
    if in_token {
        out.push(cur);
    }
    Ok(out)
}

/// Options that take a value but do not change the request; their value must be skipped.
const IGNORED_WITH_VALUE: &[&str] = &[
    "-o",
    "--output",
    "-m",
    "--max-time",
    "--connect-timeout",
    "-x",
    "--proxy",
    "--retry",
    "-w",
    "--write-out",
    "-c",
    "--cookie-jar",
    "--cert",
    "--key",
    "--cacert",
    "-r",
    "--range",
    "--resolve",
    "-U",
    "--proxy-user",
];

pub fn parse_curl(text: &str) -> Result<RequestSpec, String> {
    let args = tokenize(text)?;
    let mut args = args.into_iter();
    match args.next().as_deref() {
        Some("curl" | "curl.exe") => {}
        _ => return Err("El comando debe empezar con curl.".into()),
    }

    let mut method = None;
    let mut url = None;
    let mut headers: Vec<KeyValue> = vec![];
    let mut data: Vec<String> = vec![];
    let mut form: Vec<String> = vec![];
    let mut get = false;
    let mut head = false;
    let mut user = None;
    let header = |key: &str, value: String| KeyValue {
        key: key.into(),
        value,
        enabled: true,
    };

    while let Some(arg) = args.next() {
        // --opt=value and -Xvalue forms.
        let (opt, inline) = if let Some(long) = arg.strip_prefix("--") {
            match long.split_once('=') {
                Some((o, v)) => (format!("--{o}"), Some(v.to_owned())),
                None => (arg.clone(), None),
            }
        } else if arg.starts_with('-') && arg.len() > 2 && arg.is_char_boundary(2) {
            (arg[..2].to_owned(), Some(arg[2..].to_owned()))
        } else {
            (arg.clone(), None)
        };
        let mut value = || -> Result<String, String> {
            inline
                .clone()
                .or_else(|| args.next())
                .ok_or_else(|| format!("Falta el valor de {opt}."))
        };
        match opt.as_str() {
            "-X" | "--request" => method = Some(value()?.to_uppercase()),
            "-H" | "--header" => {
                let v = value()?;
                if let Some((k, val)) = v.split_once(':') {
                    headers.push(header(k.trim(), val.trim().to_owned()));
                }
            }
            "-d" | "--data" | "--data-raw" | "--data-binary" | "--data-ascii"
            | "--data-urlencode" => data.push(value()?),
            "--json" => {
                data.push(value()?);
                headers.push(header("Content-Type", "application/json".into()));
                headers.push(header("Accept", "application/json".into()));
            }
            "-F" | "--form" | "--form-string" => form.push(value()?),
            "-u" | "--user" => user = Some(value()?),
            "-b" | "--cookie" => headers.push(header("Cookie", value()?)),
            "-A" | "--user-agent" => headers.push(header("User-Agent", value()?)),
            "-e" | "--referer" => headers.push(header("Referer", value()?)),
            "--url" => url = Some(value()?),
            "-G" | "--get" => get = true,
            "-I" | "--head" => head = true,
            o if IGNORED_WITH_VALUE.contains(&o) => {
                value()?;
            }
            // Flags without value (-L, -k, -s, --compressed…).
            o if o.starts_with('-') => {}
            _ => {
                if url.is_none() {
                    url = Some(arg)
                }
            }
        }
    }

    let mut url = url.ok_or("El comando cURL no tiene URL.")?;
    let mut spec = RequestSpec::default();

    if get && !data.is_empty() {
        let mut params = query_params(&url);
        params.extend(query_params(&format!("?{}", data.join("&"))));
        url = with_query(&url, &params);
        data.clear();
    }

    let content_type = headers
        .iter()
        .find(|h| h.key.eq_ignore_ascii_case("content-type"))
        .map(|h| h.value.to_ascii_lowercase())
        .unwrap_or_default();
    if !form.is_empty() {
        spec.body_mode = BodyMode::Formdata;
        spec.formdata = form
            .iter()
            .map(|f| {
                let (key, value) = f.split_once('=').unwrap_or((f, ""));
                match value.strip_prefix('@') {
                    // The path is dropped: a pasted command must not pick which local file gets sent.
                    Some(_) => FormField {
                        key: key.into(),
                        value: String::new(),
                        kind: FormFieldKind::File,
                        enabled: true,
                    },
                    None => FormField {
                        key: key.into(),
                        value: value.into(),
                        kind: FormFieldKind::Text,
                        enabled: true,
                    },
                }
            })
            .collect();
    } else if !data.is_empty() {
        let body = data.join("&");
        let trimmed = body.trim_start();
        let raw = |language| RawBody {
            content: body.clone(),
            language,
        };
        if content_type.contains("json") || trimmed.starts_with('{') || trimmed.starts_with('[') {
            spec.body_mode = BodyMode::Raw;
            spec.raw = raw(RawLanguage::Json);
        } else if content_type.contains("xml") {
            spec.body_mode = BodyMode::Raw;
            spec.raw = raw(RawLanguage::Xml);
        } else if (content_type.is_empty() || content_type.contains("x-www-form-urlencoded"))
            && body.split('&').all(|p| p.contains('='))
        {
            spec.body_mode = BodyMode::Urlencoded;
            spec.urlencoded = query_params(&format!("?{body}"));
        } else {
            spec.body_mode = BodyMode::Raw;
            spec.raw = raw(RawLanguage::Text);
        }
    }

    spec.method = method.unwrap_or_else(|| {
        if head {
            "HEAD".into()
        } else if spec.body_mode != BodyMode::None {
            "POST".into()
        } else {
            "GET".into()
        }
    });
    if let Some(user) = user {
        let (username, password) = user.split_once(':').unwrap_or((&user, ""));
        spec.auth = Auth::Basic {
            username: username.into(),
            password: password.into(),
        };
    }
    spec.params = query_params(&url);
    spec.url = url;
    spec.headers = headers;
    Ok(spec)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chrome_style_json_post() {
        let spec = parse_curl(
            "curl 'https://api.x.com/users?page=2' \\\n  -H 'content-type: application/json' \\\n  -H \"Authorization: Bearer abc\" \\\n  --data-raw '{\"name\":\"Ana\"}' \\\n  --compressed",
        )
        .unwrap();
        assert_eq!(spec.method, "POST");
        assert_eq!(spec.url, "https://api.x.com/users?page=2");
        assert_eq!(spec.params[0].key, "page");
        assert_eq!(spec.headers.len(), 2);
        assert_eq!(spec.headers[1].value, "Bearer abc");
        assert_eq!(spec.body_mode, BodyMode::Raw);
        assert_eq!(spec.raw.content, r#"{"name":"Ana"}"#);
        assert_eq!(spec.raw.language, RawLanguage::Json);
    }

    #[test]
    fn form_user_and_get() {
        let spec = parse_curl(
            "curl -XPUT -u ana:s3cr3t -F name=Ana -F 'file=@/tmp/a.png;type=image/png' example.com",
        )
        .unwrap();
        assert_eq!(spec.method, "PUT");
        assert_eq!(
            spec.auth,
            Auth::Basic {
                username: "ana".into(),
                password: "s3cr3t".into()
            }
        );
        assert_eq!(spec.formdata[1].kind, FormFieldKind::File);
        assert_eq!(
            spec.formdata[1].value, "",
            "imported file paths are dropped"
        );

        let spec = parse_curl("curl -G https://x.com/s -d q=rust -d n=5").unwrap();
        assert_eq!(spec.method, "GET");
        assert_eq!(spec.url, "https://x.com/s?q=rust&n=5");
        assert_eq!(spec.body_mode, BodyMode::None);

        let spec = parse_curl("curl https://x.com -d a=1 -d b=2 -o out.txt").unwrap();
        assert_eq!(spec.body_mode, BodyMode::Urlencoded);
        assert_eq!(spec.urlencoded.len(), 2);
    }

    #[test]
    fn errors_are_reported() {
        assert!(parse_curl("curl 'https://x.com").is_err());
        assert!(parse_curl("curl -X POST").is_err());
        assert!(parse_curl("wget x").is_err());
    }
}
