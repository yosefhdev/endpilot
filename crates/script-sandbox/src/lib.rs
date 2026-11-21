//! Runs pre-request and post-response scripts with an essential subset of Postman's `pm.*` API.
//!
//! Each run gets a fresh QuickJS runtime with no file system, network or timers, a memory cap
//! and a deadline. Data goes in and out as JSON; the `pm` API itself lives in `prelude.js`.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use rquickjs::{CatchResultExt, Context, Runtime};
use serde::{Deserialize, Serialize};

const PRELUDE: &str = include_str!("prelude.js");
const MEMORY_LIMIT: usize = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);

/// Enabled variables of one scope, by name.
pub type Vars = BTreeMap<String, String>;

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Variables {
    pub globals: Vars,
    pub collection: Vars,
    /// `None` when no environment is active: `pm.environment.set` then fails with a clear error.
    pub environment: Option<Vars>,
    /// `pm.variables.set`: highest priority, lives only for this request.
    #[serde(default)]
    pub local: Vars,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub key: String,
    pub value: String,
    pub enabled: bool,
}

/// The parts of the request a script may read and change (`pm.request`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<Header>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptResponse {
    pub code: u16,
    pub status: String,
    pub headers: Vec<Header>,
    pub body: String,
    pub response_time: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Script {
    /// Where it comes from, for error messages ("Colección API", "Request").
    pub source: String,
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptInput {
    /// Run in order; the first one that throws stops the rest.
    pub scripts: Vec<Script>,
    pub variables: Variables,
    pub request: ScriptRequest,
    /// Present for post-response scripts.
    pub response: Option<ScriptResponse>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub level: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub name: String,
    pub passed: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptOutput {
    pub variables: Variables,
    pub request: ScriptRequest,
    pub logs: Vec<LogLine>,
    pub tests: Vec<TestResult>,
    /// Script errors (syntax, exceptions). A timeout or a crash of the engine also lands here.
    pub errors: Vec<String>,
}

impl ScriptOutput {
    /// Nothing changed: what a run that could not start returns, plus the error.
    fn failed(input: &ScriptInput, error: String) -> Self {
        Self {
            variables: input.variables.clone(),
            request: input.request.clone(),
            logs: vec![],
            tests: vec![],
            errors: vec![error],
        }
    }
}

pub fn run(input: &ScriptInput) -> ScriptOutput {
    run_with_timeout(input, DEFAULT_TIMEOUT)
}

pub fn run_with_timeout(input: &ScriptInput, timeout: Duration) -> ScriptOutput {
    if input.scripts.iter().all(|s| s.code.trim().is_empty()) {
        return ScriptOutput {
            errors: vec![],
            ..ScriptOutput::failed(input, String::new())
        };
    }
    match execute(input, timeout) {
        Ok(out) => out,
        Err(e) => ScriptOutput::failed(input, e),
    }
}

fn execute(input: &ScriptInput, timeout: Duration) -> Result<ScriptOutput, String> {
    let engine = |e: rquickjs::Error| format!("Motor de scripts: {e}");
    let runtime = Runtime::new().map_err(engine)?;
    runtime.set_memory_limit(MEMORY_LIMIT);
    runtime.set_max_stack_size(1024 * 1024);
    let deadline = Instant::now() + timeout;
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() > deadline)));
    let context = Context::full(&runtime).map_err(engine)?;
    let json = serde_json::to_string(input).map_err(|e| e.to_string())?;

    context.with(|ctx| {
        ctx.globals().set("__input", json).map_err(engine)?;
        let result: Result<String, String> = ctx
            .eval::<(), _>(PRELUDE)
            .and_then(|()| ctx.eval::<String, _>("__run()"))
            .catch(&ctx)
            .map_err(|e| {
                if Instant::now() > deadline {
                    format!(
                        "El script tardó más de {} s y se detuvo.",
                        timeout.as_secs_f32()
                    )
                } else {
                    format!("Error del script: {e}")
                }
            });
        let text = result?;
        serde_json::from_str(&text).map_err(|e| format!("Salida inválida del script: {e}"))
    })
}

#[cfg(test)]
mod tests;
