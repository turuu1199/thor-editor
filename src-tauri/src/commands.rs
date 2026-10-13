use crate::drivers::{self, CollectSink, Dialect, RowSink, Session};
use crate::export::{ExportOptions, Exporter, SharedBuf, Target};
use crate::model::{Cell, ColumnInfo, ColumnMeta, ConnectionProfile, DbObject, QueryResult};
use crate::oracle_env::{self, OracleHome};
use crate::store::{self, ProfileStore};
use crate::meta;
use dashmap::DashMap;
use serde::Serialize;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

const MAX_KEPT_RESULTS: usize = 40;

pub struct StoredResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Cell>>,
}

/// What is needed to silently re-open a session whose connection was dropped.
#[derive(Clone)]
pub struct ReconnectInfo {
    pub profile: ConnectionProfile,
    pub password: String,
    pub ssh_secret: String,
    pub autocommit: bool,
    /// Re-enable DBMS_OUTPUT after a reconnect.
    pub server_output: bool,
    /// Schema picked in the editor, restored after a reconnect.
    pub schema: Option<String>,
}

/// Idle sessions are pinged this often so server/firewall idle timeouts don't drop them.
const KEEPALIVE: std::time::Duration = std::time::Duration::from_secs(240);

pub struct AppState {
    pub store: ProfileStore,
    pub sessions: DashMap<String, Arc<dyn Session>>,
    pub tunnels: DashMap<String, crate::ssh::Tunnel>,
    pub reconnect_info: DashMap<String, ReconnectInfo>,
    /// Session-browser connections, keyed by the editor session id.
    pub monitors: DashMap<String, Arc<dyn Session>>,
    own_sids: DashMap<String, String>,
    reconnect_lock: tokio::sync::Mutex<()>,
    pub results: DashMap<String, Arc<StoredResult>>,
    pub result_order: Mutex<VecDeque<String>>,
}

impl AppState {
    pub fn new(store: ProfileStore) -> Self {
        Self {
            store,
            sessions: DashMap::new(),
            tunnels: DashMap::new(),
            reconnect_info: DashMap::new(),
            monitors: DashMap::new(),
            own_sids: DashMap::new(),
            reconnect_lock: tokio::sync::Mutex::new(()),
            results: DashMap::new(),
            result_order: Mutex::new(VecDeque::new()),
        }
    }

    fn session(&self, id: &str) -> CmdResult<Arc<dyn Session>> {
        self.sessions.get(id).map(|s| s.clone()).ok_or_else(|| "Session is closed. Reconnect.".to_string())
    }

    /// Re-opens session `id` after `failed` lost its connection. Concurrent callers share one reconnect.
    async fn reconnect(&self, id: &str, failed: &Arc<dyn Session>) -> anyhow::Result<Arc<dyn Session>> {
        let _g = self.reconnect_lock.lock().await;
        if let Some(cur) = self.sessions.get(id) {
            if !std::ptr::addr_eq(Arc::as_ptr(&cur), Arc::as_ptr(failed)) {
                return Ok(cur.clone()); // someone else already reconnected
            }
        }
        let info = self.reconnect_info.get(id).map(|r| r.clone()).ok_or_else(|| anyhow::anyhow!("session closed"))?;
        let c = drivers::connect(&info.profile, &info.password, &info.ssh_secret).await?;
        c.session.set_autocommit(info.autocommit).await?;
        if info.server_output {
            let _ = c.session.set_server_output(true).await;
        }
        if let Some(schema) = &info.schema {
            let _ = meta::set_current_schema(c.session.as_ref(), schema).await;
        }
        self.sessions.insert(id.to_string(), c.session.clone());
        self.own_sids.remove(id);
        match c.tunnel {
            Some(t) => {
                self.tunnels.insert(id.to_string(), t);
            }
            None => {
                self.tunnels.remove(id);
            }
        }
        Ok(c.session)
    }

    /// Runs `f`; if the connection turns out to be lost, reconnects once and runs it again.
    /// Only for operations that are safe to repeat (metadata, read-only queries).
    async fn with_retry<T, F, Fut>(&self, id: &str, f: F) -> CmdResult<T>
    where
        F: Fn(Arc<dyn Session>) -> Fut,
        Fut: std::future::Future<Output = anyhow::Result<T>>,
    {
        let s = self.session(id)?;
        match f(s.clone()).await {
            Ok(v) => Ok(v),
            Err(e) if drivers::is_connection_lost(&format!("{e:#}")) => {
                let s2 = self
                    .reconnect(id, &s)
                    .await
                    .map_err(|e2| format!("Connection lost ({e:#}). Reconnect failed: {e2:#}"))?;
                f(s2).await.map_err(err)
            }
            Err(e) => Err(err(e)),
        }
    }

    fn keep_result(&self, id: String, r: StoredResult) {
        self.results.insert(id.clone(), Arc::new(r));
        let mut order = self.result_order.lock().unwrap();
        order.push_back(id);
        while order.len() > MAX_KEPT_RESULTS {
            if let Some(old) = order.pop_front() {
                self.results.remove(&old);
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    #[serde(flatten)]
    pub profile: ConnectionProfile,
    pub has_password: bool,
}

#[tauri::command]
pub fn list_profiles(state: State<'_, AppState>) -> CmdResult<Vec<ProfileView>> {
    let list = state.store.load().map_err(err)?;
    Ok(list
        .into_iter()
        .map(|p| {
            let has_password = p.save_password && store::get_password(&p.id).is_some();
            ProfileView { profile: p, has_password }
        })
        .collect())
}

#[tauri::command]
pub fn save_profile(
    state: State<'_, AppState>,
    mut profile: ConnectionProfile,
    password: Option<String>,
    ssh_password: Option<String>,
    copy_password_from: Option<String>,
) -> CmdResult<ConnectionProfile> {
    if profile.id.is_empty() {
        profile.id = uuid::Uuid::new_v4().to_string();
    }
    // Saving a modified copy of another entry (Toad-style): reuse its stored secrets
    // when no new password was typed.
    let password = password.filter(|p| !p.is_empty()).or_else(|| {
        copy_password_from.as_deref().filter(|src| *src != profile.id).and_then(store::get_password)
    });
    let ssh_password = ssh_password.filter(|p| !p.is_empty()).or_else(|| {
        copy_password_from.as_deref().filter(|src| *src != profile.id).and_then(|src| store::get_password(&ssh_key(src)))
    });
    if let Some(pw) = ssh_password.filter(|p| !p.is_empty()) {
        store::set_password(&ssh_key(&profile.id), &pw).map_err(err)?;
    }
    if profile.save_password {
        if let Some(pw) = password.filter(|p| !p.is_empty()) {
            store::set_password(&profile.id, &pw).map_err(err)?;
        }
    } else {
        let _ = store::delete_password(&profile.id);
    }
    state.store.upsert(profile.clone()).map_err(err)?;
    Ok(profile)
}

#[tauri::command]
pub fn delete_profile(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.store.delete(&id).map_err(err)
}

#[tauri::command]
pub fn export_profiles(state: State<'_, AppState>, path: String) -> CmdResult<usize> {
    let list = state.store.load().map_err(err)?;
    std::fs::write(&path, serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(list.len())
}

#[tauri::command]
pub fn import_profiles(state: State<'_, AppState>, path: String) -> CmdResult<usize> {
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let list: Vec<ConnectionProfile> = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let n = list.len();
    for p in list {
        state.store.upsert(p).map_err(err)?;
    }
    Ok(n)
}

fn ssh_key(id: &str) -> String {
    format!("{id}#ssh")
}

fn resolve_password(profile: &ConnectionProfile, password: Option<String>) -> String {
    password.filter(|p| !p.is_empty()).or_else(|| store::get_password(&profile.id)).unwrap_or_default()
}

fn resolve_ssh(profile: &ConnectionProfile, ssh_password: Option<String>) -> String {
    ssh_password.filter(|p| !p.is_empty()).or_else(|| store::get_password(&ssh_key(&profile.id))).unwrap_or_default()
}

#[tauri::command]
pub async fn test_connection(
    profile: ConnectionProfile,
    password: Option<String>,
    ssh_password: Option<String>,
) -> CmdResult<String> {
    let pw = resolve_password(&profile, password);
    let c = drivers::connect(&profile, &pw, &resolve_ssh(&profile, ssh_password)).await.map_err(err)?;
    c.session.server_version().await.map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    pub session_id: String,
    pub version: String,
    pub dialect: String,
    pub autocommit: bool,
    pub current_schema: String,
}

fn dialect_name(d: Dialect) -> &'static str {
    match d {
        Dialect::Postgres => "postgres",
        Dialect::Mysql => "mysql",
        Dialect::Sqlite => "sqlite",
        Dialect::Mssql => "mssql",
        Dialect::Oracle => "oracle",
        Dialect::Clickhouse => "clickhouse",
        Dialect::Redis => "redis",
        Dialect::Mongo => "mongodb",
        Dialect::Neo4j => "neo4j",
        Dialect::Janus => "janusgraph",
        Dialect::Elastic => "elasticsearch",
    }
}

#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    password: Option<String>,
    ssh_password: Option<String>,
) -> CmdResult<ConnectInfo> {
    let pw = resolve_password(&profile, password);
    let ssh_secret = resolve_ssh(&profile, ssh_password);
    let c = drivers::connect(&profile, &pw, &ssh_secret).await.map_err(err)?;
    let s = c.session;
    let version = s.server_version().await.unwrap_or_default();
    let current_schema = meta::current_schema(s.as_ref()).await.unwrap_or_default();
    let id = uuid::Uuid::new_v4().to_string();
    let dialect = dialect_name(s.dialect()).to_string();
    state.sessions.insert(id.clone(), s);
    if let Some(t) = c.tunnel {
        state.tunnels.insert(id.clone(), t);
    }
    state.reconnect_info.insert(
        id.clone(),
        ReconnectInfo {
            profile: profile.clone(),
            password: pw,
            ssh_secret,
            autocommit: profile.autocommit_default(),
            server_output: false,
            schema: None,
        },
    );
    spawn_keepalive(app, id.clone());
    let _ = state.store.touch(&profile.id);
    Ok(ConnectInfo { session_id: id, version, dialect, autocommit: profile.autocommit_default(), current_schema })
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, session_id: String) -> CmdResult<()> {
    state.sessions.remove(&session_id);
    state.tunnels.remove(&session_id);
    state.reconnect_info.remove(&session_id);
    state.monitors.remove(&session_id);
    state.own_sids.remove(&session_id);
    state.tunnels.remove(&format!("{session_id}#monitor"));
    Ok(())
}

#[tauri::command]
pub async fn execute(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    max_rows: Option<usize>,
) -> CmdResult<QueryResult> {
    state.execute_sql(&session_id, &sql, max_rows).await
}

impl AppState {
    /// Runs one statement; on a lost connection reconnects and re-runs it only if read-only.
    pub async fn execute_sql(&self, session_id: &str, sql: &str, max_rows: Option<usize>) -> CmdResult<QueryResult> {
        let state = self;
        let session_id = session_id.to_string();
        let sql = sql.to_string();
        let s = state.session(&session_id)?;
        let started = Instant::now();
        let limit = max_rows.unwrap_or(500);
        let mut sink = CollectSink::new(limit);
        let mut notice = None;
        let outcome = match s.run(&sql, &mut sink).await {
            Ok(o) => o,
            Err(e) if drivers::is_connection_lost(&format!("{e:#}")) => {
                let s2 = state
                    .reconnect(&session_id, &s)
                    .await
                    .map_err(|e2| format!("Connection lost ({e:#}). Reconnect failed: {e2:#}"))?;
                let manual = state.reconnect_info.get(&session_id).map(|r| !r.autocommit).unwrap_or(false);
                if !drivers::is_read_only(&sql) {
                    return Err(format!(
                        "Connection was lost ({}) and has been re-established.\nThe statement was NOT executed — run it again.{}",
                        format!("{e:#}").lines().next().unwrap_or_default(),
                        if manual { "\nUncommitted changes from the old session were rolled back by the server." } else { "" }
                    ));
                }
                sink = CollectSink::new(limit);
                notice = Some(format!(
                    "Connection was lost and re-established automatically; the query was re-run.{}",
                    if manual { " Uncommitted changes from the old session were rolled back by the server." } else { "" }
                ));
                s2.run(&sql, &mut sink).await.map_err(err)?
            }
            Err(e) => return Err(err(e)),
        };
        // DBMS_OUTPUT of this statement (read from the live session — it may have been reconnected).
        let output = match state.sessions.get(&session_id).map(|x| x.clone()) {
            Some(cur) => cur.take_server_output().await.unwrap_or_default(),
            None => vec![],
        };
        let result_id = uuid::Uuid::new_v4().to_string();
        let result = QueryResult {
            result_id: result_id.clone(),
            columns: sink.columns.clone(),
            rows: sink.rows.clone(),
            truncated: sink.truncated,
            affected: outcome.affected,
            elapsed_ms: started.elapsed().as_millis(),
            notice,
            output,
        };
        if !sink.columns.is_empty() {
            state.keep_result(result_id, StoredResult { columns: sink.columns, rows: sink.rows });
        }
        Ok(result)
    }
}

#[tauri::command]
pub async fn cancel_query(state: State<'_, AppState>, session_id: String) -> CmdResult<()> {
    let s = state.session(&session_id)?;
    s.cancel().await.map_err(err)
}

#[tauri::command]
pub async fn commit(state: State<'_, AppState>, session_id: String) -> CmdResult<()> {
    state.session(&session_id)?.commit().await.map_err(err)
}

#[tauri::command]
pub async fn rollback(state: State<'_, AppState>, session_id: String) -> CmdResult<()> {
    state.session(&session_id)?.rollback().await.map_err(err)
}

#[tauri::command]
pub async fn set_autocommit(state: State<'_, AppState>, session_id: String, on: bool) -> CmdResult<()> {
    state.session(&session_id)?.set_autocommit(on).await.map_err(err)?;
    if let Some(mut r) = state.reconnect_info.get_mut(&session_id) {
        r.autocommit = on;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_current_schema(state: State<'_, AppState>, session_id: String, schema: String) -> CmdResult<String> {
    let current = state
        .with_retry(&session_id, |s| {
            let schema = schema.clone();
            async move { meta::set_current_schema(s.as_ref(), &schema).await }
        })
        .await?;
    if let Some(mut r) = state.reconnect_info.get_mut(&session_id) {
        r.schema = Some(schema);
    }
    Ok(current)
}

/// Pings the session every few minutes; if the ping shows the connection died, reconnects
/// right away and tells the UI, so the next statement just works.
fn spawn_keepalive(app: AppHandle, id: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(KEEPALIVE).await;
            let state = app.state::<AppState>();
            let Some(s) = state.sessions.get(&id).map(|s| s.clone()) else { break };
            if let Err(e) = s.ping().await {
                let msg = format!("{e:#}");
                if drivers::is_connection_lost(&msg) {
                    let ok = state.reconnect(&id, &s).await.is_ok();
                    let _ = app.emit("session-reconnected", SessionEvent { session_id: id.clone(), ok, reason: msg });
                }
            }
        }
    });
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionEvent {
    session_id: String,
    ok: bool,
    reason: String,
}

#[tauri::command]
pub fn release_result(state: State<'_, AppState>, result_id: String) {
    state.results.remove(&result_id);
}

#[tauri::command]
pub async fn list_schemas(state: State<'_, AppState>, session_id: String) -> CmdResult<Vec<String>> {
    state.with_retry(&session_id, |s| async move { meta::list_schemas(s.as_ref()).await }).await
}

#[tauri::command]
pub async fn list_objects(state: State<'_, AppState>, session_id: String, schema: String) -> CmdResult<Vec<DbObject>> {
    state
        .with_retry(&session_id, |s| {
            let schema = schema.clone();
            async move { meta::list_objects(s.as_ref(), &schema).await }
        })
        .await
}

#[tauri::command]
pub async fn table_columns(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
) -> CmdResult<Vec<ColumnInfo>> {
    state
        .with_retry(&session_id, |s| {
            let (schema, table) = (schema.clone(), table.clone());
            async move { meta::columns(s.as_ref(), &schema, &table).await }
        })
        .await
}

/// Syntax-tree analysis of editor statements (completion context, inspections).
#[tauri::command]
pub async fn sql_analyze(dialect: String, statements: Vec<String>) -> CmdResult<Vec<crate::sqlparse::Analysis>> {
    tokio::task::spawn_blocking(move || statements.iter().map(|s| crate::sqlparse::analyze(&dialect, s)).collect())
        .await
        .map_err(|e| e.to_string())
}

/// Edges between the given graph nodes (Neo4j / JanusGraph), for the result graph view.
#[tauri::command]
pub async fn graph_edges(state: State<'_, AppState>, session_id: String, ids: Vec<String>) -> CmdResult<Vec<serde_json::Value>> {
    state
        .with_retry(&session_id, |s| {
            let ids = ids.clone();
            async move { s.graph_edges(&ids, 5000).await }
        })
        .await
}

#[tauri::command]
pub async fn object_ddl(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    name: String,
    kind: String,
    full: Option<bool>,
) -> CmdResult<String> {
    let full = full.unwrap_or(false);
    state
        .with_retry(&session_id, |s| {
            let (schema, name, kind) = (schema.clone(), name.clone(), kind.clone());
            async move {
                if full && s.dialect() == Dialect::Oracle {
                    meta::oracle_metadata_ddl(s.as_ref(), &schema, &name, &kind).await
                } else {
                    meta::ddl(s.as_ref(), &schema, &name, &kind).await
                }
            }
        })
        .await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProgress {
    job_id: String,
    rows: u64,
}

fn progress_cb(app: &AppHandle, job_id: &str) -> Box<dyn FnMut(u64) + Send> {
    let app = app.clone();
    let job_id = job_id.to_string();
    Box::new(move |rows| {
        let _ = app.emit("export-progress", ExportProgress { job_id: job_id.clone(), rows });
    })
}

fn replay(r: &StoredResult, sink: &mut dyn RowSink) -> anyhow::Result<()> {
    sink.columns(r.columns.clone())?;
    for row in &r.rows {
        if !sink.row(row.clone())? {
            break;
        }
    }
    Ok(())
}

/// Export an in-memory grid result.
#[tauri::command]
pub async fn export_result(
    state: State<'_, AppState>,
    result_id: String,
    options: ExportOptions,
    path: String,
) -> CmdResult<u64> {
    let r = state.results.get(&result_id).map(|r| r.clone()).ok_or("Result expired; re-run the query")?;
    tokio::task::spawn_blocking(move || -> anyhow::Result<u64> {
        let mut e = Exporter::new(options, Target::File(PathBuf::from(path)), None)?;
        replay(&r, &mut e)?;
        e.finish()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(err)
}

/// Export an in-memory result as text (for the clipboard).
#[tauri::command]
pub fn export_to_string(state: State<'_, AppState>, result_id: String, options: ExportOptions) -> CmdResult<String> {
    let r = state.results.get(&result_id).map(|r| r.clone()).ok_or("Result expired; re-run the query")?;
    let buf = SharedBuf::default();
    let mut e = Exporter::new(options, Target::Buffer(buf.clone()), None).map_err(err)?;
    replay(&r, &mut e).map_err(err)?;
    e.finish().map_err(err)?;
    let bytes = buf.0.lock().unwrap().clone();
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Re-execute a query and stream every row straight to a file (no row limit).
#[tauri::command]
pub async fn export_query(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    options: ExportOptions,
    path: String,
    job_id: String,
) -> CmdResult<u64> {
    let s = state.session(&session_id)?;
    let mut e = Exporter::new(options, Target::File(PathBuf::from(path)), Some(progress_cb(&app, &job_id))).map_err(err)?;
    s.run(&sql, &mut e).await.map_err(err)?;
    let n = tokio::task::block_in_place(|| e.finish()).map_err(err)?;
    let _ = app.emit("export-progress", ExportProgress { job_id, rows: n });
    Ok(n)
}

#[tauri::command]
pub fn oracle_homes() -> Vec<OracleHome> {
    oracle_env::list_homes()
}

#[tauri::command]
pub fn tns_aliases(config_dir: String) -> Vec<String> {
    oracle_env::tns_aliases(&config_dir)
}

// ---------- Phase 2: ER diagram, import, connection import, compare ----------

#[tauri::command]
pub async fn foreign_keys(state: State<'_, AppState>, session_id: String, schema: String) -> CmdResult<Vec<meta::ForeignKey>> {
    state
        .with_retry(&session_id, |s| {
            let schema = schema.clone();
            async move { meta::foreign_keys(s.as_ref(), &schema).await }
        })
        .await
}

#[tauri::command]
pub async fn import_preview(
    state: State<'_, AppState>,
    session_id: Option<String>,
    path: String,
    options: crate::importer::SourceOptions,
) -> CmdResult<crate::importer::Preview> {
    let dialect = session_id.and_then(|id| state.sessions.get(&id).map(|s| s.dialect()));
    tokio::task::spawn_blocking(move || crate::importer::preview(std::path::Path::new(&path), &options, dialect))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)
}

#[tauri::command]
pub async fn import_file(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    source: crate::importer::SourceOptions,
    target: crate::importer::TargetOptions,
    job_id: String,
) -> CmdResult<u64> {
    let s = state.session(&session_id)?;
    let job = job_id.clone();
    let app2 = app.clone();
    crate::importer::run(s.as_ref(), std::path::Path::new(&path), &source, &target, move |rows| {
        let _ = app2.emit("import-progress", ExportProgress { job_id: job.clone(), rows });
    })
    .await
    .map_err(err)
}

#[tauri::command]
pub fn import_type_names(dialect: String) -> (String, String, String) {
    let d = match dialect.as_str() {
        "postgres" => Dialect::Postgres,
        "mysql" => Dialect::Mysql,
        "sqlite" => Dialect::Sqlite,
        "mssql" => Dialect::Mssql,
        "oracle" => Dialect::Oracle,
        _ => Dialect::Clickhouse,
    };
    let (a, b, c) = crate::importer::type_names(d);
    (a.into(), b.into(), c.into())
}

#[tauri::command]
pub fn connection_sources() -> Vec<crate::connimport::KnownSource> {
    crate::connimport::known_sources()
}

#[tauri::command]
pub fn parse_connections(kind: String, path: String) -> CmdResult<Vec<ConnectionProfile>> {
    crate::connimport::parse(&kind, std::path::Path::new(&path)).map_err(err)
}

#[tauri::command]
pub fn compare_results(
    state: State<'_, AppState>,
    a: String,
    b: String,
    keys: Vec<String>,
) -> CmdResult<crate::compare::CompareResult> {
    let ra = state.results.get(&a).map(|r| r.clone()).ok_or("Result A expired; re-run it")?;
    let rb = state.results.get(&b).map(|r| r.clone()).ok_or("Result B expired; re-run it")?;
    crate::compare::compare(&ra.columns, &ra.rows, &rb.columns, &rb.rows, &keys).map_err(err)
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> CmdResult<()> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn object_source(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    name: String,
    kind: String,
) -> CmdResult<meta::ObjectSource> {
    state
        .with_retry(&session_id, |s| {
            let (schema, name, kind) = (schema.clone(), name.clone(), kind.clone());
            async move { meta::source(s.as_ref(), &schema, &name, &kind).await }
        })
        .await
}

#[tauri::command]
pub async fn explain_plan(state: State<'_, AppState>, session_id: String, sql: String) -> CmdResult<crate::explain::Plan> {
    state
        .with_retry(&session_id, |s| {
            let sql = sql.clone();
            async move { crate::explain::explain(s.as_ref(), &sql).await }
        })
        .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTest {
    pub alive: bool,
    pub reconnected: bool,
    pub latency_ms: u128,
    pub version: String,
    pub error: Option<String>,
}

/// Toad's "Test Connection (Reconnect)": round-trip to the server; if the connection is gone,
/// reconnect with the saved credentials.
#[tauri::command]
pub async fn test_session(state: State<'_, AppState>, session_id: String) -> CmdResult<SessionTest> {
    let s = state.session(&session_id)?;
    let started = Instant::now();
    let probe = async {
        s.ping().await?;
        s.server_version().await
    };
    match probe.await {
        Ok(version) => Ok(SessionTest { alive: true, reconnected: false, latency_ms: started.elapsed().as_millis(), version, error: None }),
        Err(e) => {
            let msg = format!("{e:#}");
            if !drivers::is_connection_lost(&msg) {
                return Ok(SessionTest { alive: false, reconnected: false, latency_ms: 0, version: String::new(), error: Some(msg) });
            }
            match state.reconnect(&session_id, &s).await {
                Ok(s2) => Ok(SessionTest {
                    alive: true,
                    reconnected: true,
                    latency_ms: started.elapsed().as_millis(),
                    version: s2.server_version().await.unwrap_or_default(),
                    error: Some(msg),
                }),
                Err(e2) => Ok(SessionTest {
                    alive: false,
                    reconnected: false,
                    latency_ms: 0,
                    version: String::new(),
                    error: Some(format!("{msg}\nReconnect failed: {e2:#}")),
                }),
            }
        }
    }
}

#[tauri::command]
pub async fn resolve_object(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    name: String,
) -> CmdResult<Option<DbObject>> {
    state
        .with_retry(&session_id, |s| {
            let (schema, name) = (schema.clone(), name.clone());
            async move { meta::resolve_object(s.as_ref(), &schema, &name).await }
        })
        .await
}

// ---------- Session browser ----------

impl AppState {
    /// Separate connection used by the session browser, so it works while the editor's own
    /// session is busy or blocked.
    async fn monitor(&self, id: &str) -> CmdResult<Arc<dyn Session>> {
        if let Some(m) = self.monitors.get(id) {
            return Ok(m.clone());
        }
        let info = self.reconnect_info.get(id).map(|r| r.clone()).ok_or("Session is closed. Reconnect.")?;
        let c = drivers::connect(&info.profile, &info.password, &info.ssh_secret).await.map_err(err)?;
        c.session.set_autocommit(true).await.map_err(err)?;
        if let Some(t) = c.tunnel {
            self.tunnels.insert(format!("{id}#monitor"), t);
        }
        self.monitors.insert(id.to_string(), c.session.clone());
        Ok(c.session)
    }

    /// Server-side id of the editor's own session (cached; cleared on reconnect).
    async fn own_sid(&self, id: &str) -> Option<String> {
        if let Some(v) = self.own_sids.get(id) {
            return Some(v.clone());
        }
        let s = self.sessions.get(id)?.clone();
        let sql = match s.dialect() {
            Dialect::Oracle => "select sys_context('USERENV', 'SID') from dual",
            Dialect::Postgres => "select pg_backend_pid()",
            Dialect::Mysql => "select connection_id()",
            Dialect::Mssql => "select @@spid",
            _ => return None,
        };
        let mut sink = CollectSink::new(1);
        // Don't hang the browser if the editor session is busy.
        tokio::time::timeout(std::time::Duration::from_secs(2), s.run(sql, &mut sink)).await.ok()?.ok()?;
        let v = sink.rows.first()?.first()?.to_text();
        self.own_sids.insert(id.to_string(), v.clone());
        Some(v)
    }

    async fn with_monitor<T, F, Fut>(&self, id: &str, f: F) -> CmdResult<T>
    where
        F: Fn(Arc<dyn Session>) -> Fut,
        Fut: std::future::Future<Output = anyhow::Result<T>>,
    {
        let m = self.monitor(id).await?;
        match f(m).await {
            Ok(v) => Ok(v),
            Err(e) if drivers::is_connection_lost(&format!("{e:#}")) => {
                self.monitors.remove(id);
                let m = self.monitor(id).await?;
                f(m).await.map_err(err)
            }
            Err(e) => Err(err(e)),
        }
    }
}

#[tauri::command]
pub async fn session_list(state: State<'_, AppState>, session_id: String) -> CmdResult<Vec<crate::sessions::DbSession>> {
    let own = state.own_sid(&session_id).await;
    let mut list = state.with_monitor(&session_id, |m| async move { crate::sessions::list(m.as_ref()).await }).await?;
    // The monitor connection itself is noise; mark the editor's own session instead.
    list.retain(|s| !s.is_self);
    for s in &mut list {
        s.is_self = own.as_deref() == Some(s.sid.as_str());
    }
    Ok(list)
}

#[tauri::command]
pub async fn session_detail(
    state: State<'_, AppState>,
    session_id: String,
    id: String,
    sql_id: String,
) -> CmdResult<crate::sessions::SessionDetail> {
    state
        .with_monitor(&session_id, |m| {
            let (id, sql_id) = (id.clone(), sql_id.clone());
            async move { crate::sessions::detail(m.as_ref(), &id, &sql_id).await }
        })
        .await
}

#[tauri::command]
pub async fn session_kill(state: State<'_, AppState>, session_id: String, id: String, cancel_only: bool) -> CmdResult<()> {
    state
        .with_monitor(&session_id, |m| {
            let id = id.clone();
            async move { crate::sessions::kill(m.as_ref(), &id, cancel_only).await }
        })
        .await
}

#[cfg(test)]
impl AppState {
    pub async fn session_list_for_test(&self, id: &str) -> Vec<crate::sessions::DbSession> {
        let own = self.own_sid(id).await;
        let mut list = self.with_monitor(id, |m| async move { crate::sessions::list(m.as_ref()).await }).await.unwrap();
        list.retain(|s| !s.is_self);
        for s in &mut list {
            s.is_self = own.as_deref() == Some(s.sid.as_str());
        }
        list
    }
    pub async fn session_detail_for_test(&self, id: &str, sid: &str, sql_id: &str) -> crate::sessions::SessionDetail {
        let (sid, sql_id) = (sid.to_string(), sql_id.to_string());
        self.with_monitor(id, |m| {
            let (sid, sql_id) = (sid.clone(), sql_id.clone());
            async move { crate::sessions::detail(m.as_ref(), &sid, &sql_id).await }
        })
        .await
        .unwrap()
    }
    pub async fn session_kill_for_test(&self, id: &str, sid: &str, cancel_only: bool) {
        let sid = sid.to_string();
        self.with_monitor(id, |m| {
            let sid = sid.clone();
            async move { crate::sessions::kill(m.as_ref(), &sid, cancel_only).await }
        })
        .await
        .unwrap()
    }
}


/// Turns server output (Oracle DBMS_OUTPUT) on/off for the session; false = engine has none.
#[tauri::command]
pub async fn set_server_output(state: State<'_, AppState>, session_id: String, on: bool) -> CmdResult<bool> {
    let supported = state.session(&session_id)?.set_server_output(on).await.map_err(err)?;
    if let Some(mut r) = state.reconnect_info.get_mut(&session_id) {
        r.server_output = on && supported;
    }
    Ok(supported)
}

/// Output left in the buffer, e.g. lines printed before a PL/SQL block failed.
#[tauri::command]
pub async fn take_server_output(state: State<'_, AppState>, session_id: String) -> CmdResult<Vec<String>> {
    state.session(&session_id)?.take_server_output().await.map_err(err)
}
