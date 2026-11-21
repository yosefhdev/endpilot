use super::*;

fn input(code: &str) -> ScriptInput {
    ScriptInput {
        scripts: vec![Script {
            source: "Request".into(),
            code: code.into(),
        }],
        variables: Variables {
            globals: Vars::from([("g".into(), "1".into())]),
            collection: Vars::from([("baseUrl".into(), "http://c".into())]),
            environment: Some(Vars::new()),
            local: Vars::new(),
        },
        request: ScriptRequest {
            method: "POST".into(),
            url: "{{baseUrl}}/login".into(),
            headers: vec![],
        },
        response: None,
    }
}

fn with_response(code: &str, status: u16, body: &str) -> ScriptInput {
    ScriptInput {
        response: Some(ScriptResponse {
            code: status,
            status: "OK".into(),
            headers: vec![Header {
                key: "Content-Type".into(),
                value: "application/json".into(),
                enabled: true,
            }],
            body: body.into(),
            response_time: 12.0,
        }),
        ..input(code)
    }
}

#[test]
fn saves_a_token_from_the_login_response() {
    let out = run(&with_response(
        r#"pm.environment.set("token", pm.response.json().token);"#,
        200,
        r#"{"token":"abc"}"#,
    ));
    assert_eq!(out.errors, Vec::<String>::new());
    assert_eq!(out.variables.environment.unwrap()["token"], "abc");
}

#[test]
fn tests_and_expect() {
    let out = run(&with_response(
        r#"
        pm.test("status", () => pm.response.to.have.status(200));
        pm.test("body", () => pm.expect(pm.response.json().items).to.have.property("length"));
        pm.test("falla", () => pm.expect(pm.response.code).to.equal(201));
        pm.test("not", () => pm.expect("abc").to.not.include("z"));
        "#,
        200,
        r#"{"items":[1]}"#,
    ));
    let passed: Vec<_> = out
        .tests
        .iter()
        .map(|t| (t.name.as_str(), t.passed))
        .collect();
    assert_eq!(
        passed,
        [
            ("status", true),
            ("body", true),
            ("falla", false),
            ("not", true)
        ]
    );
    assert_eq!(
        out.tests[2].error.as_deref(),
        Some("se esperaba 201 y llegó 200")
    );
}

#[test]
fn variables_scopes_and_console() {
    let out = run(&input(
        r#"
        pm.collectionVariables.set("n", 2);
        pm.globals.unset("g");
        pm.variables.set("local", {a: 1});
        console.log("url", pm.variables.replaceIn(pm.request.url), {x: 1});
        "#,
    ));
    assert!(out.errors.is_empty(), "{:?}", out.errors);
    assert_eq!(out.variables.collection["n"], "2");
    assert!(out.variables.globals.is_empty());
    assert_eq!(out.variables.local["local"], r#"{"a":1}"#);
    assert_eq!(out.logs[0].text, r#"url http://c/login {"x":1}"#);
}

#[test]
fn pre_request_can_change_headers_and_url() {
    let out = run(&input(
        r#"
        pm.request.headers.add({ key: "X-Id", value: 7 });
        pm.request.headers.upsert({ key: "x-id", value: "8" });
        pm.request.url = pm.request.url + "?v=2";
        "#,
    ));
    assert_eq!(out.request.headers.len(), 1);
    assert_eq!(out.request.headers[0].value, "8");
    assert_eq!(out.request.url, "{{baseUrl}}/login?v=2");
}

#[test]
fn environment_set_without_active_environment_explains_why() {
    let mut i = input(r#"pm.environment.set("a", 1);"#);
    i.variables.environment = None;
    let out = run(&i);
    assert_eq!(out.errors.len(), 1);
    assert!(out.errors[0].starts_with("Request: No hay entorno activo"));
}

#[test]
fn a_failing_script_stops_the_chain() {
    let mut i = input("throw new Error('boom')");
    i.scripts.push(Script {
        source: "Otro".into(),
        code: "pm.globals.set('ran', 1)".into(),
    });
    let out = run(&i);
    assert_eq!(out.errors, ["Request: boom"]);
    assert!(!out.variables.globals.contains_key("ran"));
}

#[test]
fn no_host_access() {
    let out = run(&input(
        r#"console.log(typeof require, typeof fetch, typeof XMLHttpRequest, typeof std, typeof os, typeof setTimeout);"#,
    ));
    assert_eq!(
        out.logs[0].text,
        "undefined undefined undefined undefined undefined undefined"
    );
}

#[test]
fn infinite_loops_are_stopped() {
    let out = run_with_timeout(&input("while (true) {}"), Duration::from_millis(200));
    assert_eq!(out.errors.len(), 1);
    assert!(out.errors[0].contains("se detuvo"), "{:?}", out.errors);
}

#[test]
fn memory_is_capped() {
    let out = run(&input(
        "const a = []; while (true) a.push('x'.repeat(1e6));",
    ));
    assert_eq!(out.errors.len(), 1, "{:?}", out.errors);
}

#[test]
fn syntax_errors_are_reported() {
    let out = run(&input("pm.test("));
    assert_eq!(out.errors.len(), 1);
    assert!(out.errors[0].starts_with("Request: "));
}
