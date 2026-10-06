//! mergit-core: version control for Mermaid boards.
//!
//! The same crate builds natively (tests, a future CLI / sync server) and to
//! `wasm32-unknown-unknown` for the browser. The wasm surface is deliberately
//! tiny and dependency-free: JSON in, JSON out, through a single `gm_call`.

pub mod diff;
pub mod mermaid;
pub mod repo;

use repo::{Board, Repo, Result};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::sync::Mutex;

static REPO: Mutex<Option<Repo>> = Mutex::new(None);
static OUT: Mutex<Vec<u8>> = Mutex::new(Vec::new());

fn arg<T: DeserializeOwned>(v: &Value, key: &str) -> Result<T> {
    serde_json::from_value(v.get(key).cloned().unwrap_or(Value::Null)).map_err(|e| format!("bad '{key}': {e}"))
}

fn ok<T: serde::Serialize>(v: T) -> Result<Value> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

fn run(req: &Value) -> Result<Value> {
    let op: String = arg(req, "op")?;
    let mut guard = REPO.lock().map_err(|_| "repository lock poisoned")?;

    match op.as_str() {
        "init" => {
            let board: Board = arg(req, "board")?;
            *guard = Some(Repo::init(&board, &arg::<String>(req, "author")?, arg(req, "time")?));
            return Ok(Value::Null);
        }
        "init_empty" => {
            *guard = Some(Repo::empty(&arg::<String>(req, "branch")?));
            return Ok(Value::Null);
        }
        "import" => {
            *guard = Some(arg(req, "repo")?);
            return Ok(Value::Null);
        }
        _ => {}
    }

    let repo = guard.as_mut().ok_or("repository not initialised")?;
    let rev = || arg::<String>(req, "rev");
    match op.as_str() {
        "export" => ok(&*repo),
        "status" => ok(repo.status(&arg(req, "board")?)),
        "log" => ok(repo.log()),
        "show" => ok(repo.board_at(&rev()?)?),
        "checkout" => ok(repo.checkout(&rev()?)?),
        "commit" => ok(repo.commit(&arg(req, "board")?, &arg::<String>(req, "message")?, &arg::<String>(req, "author")?, arg(req, "time")?)?),
        "branch" => {
            let name: String = arg(req, "name")?;
            repo.create_branch(&name, &arg::<Option<String>>(req, "rev")?.unwrap_or("HEAD".into()))?;
            if arg::<Option<bool>>(req, "switch")?.unwrap_or(false) {
                repo.attach(&name)?;
            }
            Ok(Value::Null)
        }
        "delete_branch" => ok(repo.delete_branch(&arg::<String>(req, "name")?)?),
        "diff" => ok(repo.diff(&rev()?, &arg(req, "board")?)?),
        "commit_diff" => ok(repo.commit_diff(&rev()?)?),
        "merge" => ok(repo.merge(&arg::<String>(req, "branch")?, &arg(req, "board")?, &arg::<String>(req, "author")?, arg(req, "time")?)?),
        "merge_abort" => ok(repo.merge_abort()?),
        "pack" => ok(repo.pack(&arg::<Vec<String>>(req, "tips")?, &arg::<Option<Vec<String>>>(req, "exclude")?.unwrap_or_default())?),
        "ingest" => ok(repo.ingest(&arg(req, "objects")?)?),
        "set_ref" => ok(repo.set_ref(&arg::<String>(req, "name")?, arg::<Option<String>>(req, "hash")?.as_deref())?),
        "attach" => ok(repo.attach(&arg::<String>(req, "name")?)?),
        "set_merge" => {
            repo.set_merge(arg(req, "head")?, arg(req, "branch")?);
            Ok(Value::Null)
        }
        other => Err(format!("unknown op '{other}'")),
    }
}

/// Dispatch one JSON request; always returns `{"ok": …}` or `{"err": "…"}`.
pub fn dispatch(req: &str) -> String {
    let result = serde_json::from_str::<Value>(req).map_err(|e| e.to_string()).and_then(|v| run(&v));
    match result {
        Ok(v) => json!({ "ok": v }),
        Err(e) => json!({ "err": e }),
    }
    .to_string()
}

// ---- wasm ABI ---------------------------------------------------------------

#[unsafe(no_mangle)]
pub extern "C" fn gm_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr`/`len` must come from a previous `gm_alloc(len)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gm_free(ptr: *mut u8, len: usize) {
    unsafe { drop(Vec::from_raw_parts(ptr, 0, len)) }
}

/// Runs the request in `ptr[..len]` and returns a pointer to the response,
/// valid until the next call; its length is `gm_out_len()`.
///
/// # Safety
/// `ptr[..len]` must be readable memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gm_call(ptr: *const u8, len: usize) -> *const u8 {
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let response = match std::str::from_utf8(bytes) {
        Ok(req) => dispatch(req),
        Err(_) => json!({ "err": "request was not UTF-8" }).to_string(),
    };
    let mut out = OUT.lock().unwrap_or_else(|e| e.into_inner());
    *out = response.into_bytes();
    out.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn gm_out_len() -> usize {
    OUT.lock().map(|o| o.len()).unwrap_or(0)
}
