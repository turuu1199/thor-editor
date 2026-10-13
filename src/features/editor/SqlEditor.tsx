import { confirmAsk } from "../../lib/confirm";
import Editor, { type OnMount } from "@monaco-editor/react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import clsx from "clsx";
import {
  AlignLeft,
  BookmarkPlus,
  CheckCheck,
  FileCode2,
  History,
  ListTree,
  Play,
  PlaySquare,
  Square,
  Undo2,
  X,
  Terminal,
  Eraser,
  Copy,
  Save,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { canFormat, formatSql } from "../../lib/formatter";
import { Button, IconButton, Input, Modal, Spinner } from "../../components/ui";
import { api, errorText, isSql, onSessionReconnected, type Dialect, type Plan, type QueryResult } from "../../lib/ipc";
import { ExplainPlanView } from "./ExplainPlanView";
import { editorTheme, useObjectHighlight } from "../../lib/editorTheme";
import { explainSql, findBindVars, qualified, splitStatements, statementAt, substituteBinds, type Stmt } from "../../lib/sql";
import { useThemeColors } from "../../lib/theme";
import { writeTextFile } from "../../lib/fs";
import { useApp, uid, type Connection, type EditorTab } from "../../store/app";
import { ExportDialog } from "../export/ExportDialog";
import { ResultGrid, type EditTarget } from "../grid/ResultGrid";
import { modelConn, registerCompletion } from "./completion";
import { attachInspections } from "./inspections";
import { identifierAt, resolveIdentifier } from "./navigate";
import type * as Monaco from "monaco-editor/editor/editor.api";

interface ResultTab {
  id: string;
  title: string;
  sql: string;
  result: QueryResult;
}

interface LogLine {
  at: string;
  text: string;
  ok: boolean;
  /** Editor line of the statement (script errors are clickable). */
  line?: number;
  /** Absolute model offsets of the statement, to select it when clicked. */
  range?: { start: number; end: number };
}

/** DBMS_OUTPUT lines produced by one statement. */
interface OutputBlock {
  id: string;
  at: string;
  line?: number;
  sql: string;
  lines: string[];
}

export const LANG: Record<Dialect, string> = {
  postgres: "pgsql",
  mysql: "mysql",
  sqlite: "sql",
  mssql: "sql",
  oracle: "sql",
  clickhouse: "sql",
  redis: "redis",
  mongodb: "javascript",
  neo4j: "cypher",
  // Gremlin scripts are Groovy; Java highlighting is the closest built-in grammar.
  janusgraph: "java",
  // Kibana console requests + SQL (registered in completion.ts).
  elasticsearch: "esconsole",
};
const TRANSACTIONAL: Dialect[] = ["postgres", "mysql", "sqlite", "mssql", "oracle"];
/** Elasticsearch requests that delete or close data: DELETE, *_by_query deletes, index close/shrink, bulk deletes. */
function isDestructiveEsRequest(req: string): boolean {
  const [line, ...body] = req.trim().split("\n");
  if (/^DELETE\s/i.test(line)) return true;
  if (/\/?_(delete_by_query|close|shrink|split|rollover)\b/i.test(line)) return true;
  return /\b_bulk\b/i.test(line) && /"delete"\s*:/.test(body.join("\n"));
}

const PLACEHOLDER: Partial<Record<Dialect, string>> = {
  redis: "SCAN 0 MATCH user:* COUNT 100\nHGETALL user:1",
  mongodb: "db.users.find({ age: { $gt: 30 } }).sort({ name: 1 }).limit(50)",
  neo4j: "MATCH (p:Person)-[r:KNOWS]->(f) RETURN p, r, f LIMIT 50",
  janusgraph: "g.V().hasLabel('person').outE('knows').inV().path().limit(50)",
  elasticsearch: 'GET my-index/_search\n{ "query": { "match": { "title": "hello" } }, "size": 50 }\n\nSELECT city, COUNT(*) FROM "my-index" GROUP BY city;',
};

export function SqlEditor({ tab, conn }: { tab: Extract<EditorTab, { kind: "sql" }>; conn: Connection }) {
  const { updateSql, setTabFile, addHistory, settings, history, saveSnippet, setAutocommit, setCurrentSchema, invalidateObjects, setConnStatus, openTab, setConnServerOutput, updateSettings } = useApp();
  const colors = useThemeColors();
  const dialect = conn.info.dialect;
  const graphDb = dialect === "neo4j" || dialect === "janusgraph";
  const fetchEdges = useCallback((ids: string[]) => api.graphEdges(conn.info.sessionId, ids), [conn.info.sessionId]);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const [editorInst, setEditorInst] = useState<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const [results, setResults] = useState<ResultTab[]>([]);
  const [activeResult, setActiveResult] = useState<string>("log");
  const [log, setLog] = useState<LogLine[]>([]);
  const [plan, setPlan] = useState<{ sql: string; plan: Plan } | null>(null);
  const [output, setOutput] = useState<OutputBlock[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [txPending, setTxPending] = useState(false);
  const [split, setSplit] = useState(0.5);
  const [binds, setBinds] = useState<{ names: string[]; resolve: (v: Record<string, string> | null) => void } | null>(null);
  const [bindValues, setBindValues] = useState<Record<string, string>>({});
  const [exportFor, setExportFor] = useState<ResultTab | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const addLog = (text: string, ok = true, extra: Partial<LogLine> = {}) =>
    setLog((l) => [...l.slice(-499), { at: new Date().toLocaleTimeString(), text, ok, ...extra }]);

  // DBMS_OUTPUT is a session setting (shared by all tabs of the connection); on by default for Oracle, like Toad.
  const serverOutput = dialect === "oracle" && conn.serverOutput !== false;
  useEffect(() => {
    if (dialect !== "oracle" || conn.serverOutput !== undefined) return;
    api
      .setServerOutput(conn.info.sessionId, true)
      .then((ok) => setConnServerOutput(conn.key, ok))
      .catch(() => setConnServerOutput(conn.key, false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.info.sessionId]);

  const toggleServerOutput = async () => {
    try {
      const ok = await api.setServerOutput(conn.info.sessionId, !serverOutput);
      setConnServerOutput(conn.key, ok && !serverOutput);
      addLog(`DBMS Output ${!serverOutput ? "ON" : "OFF"}`);
    } catch (e) {
      addLog(errorText(e), false);
    }
  };

  const pushOutput = (lines: string[], sql: string, line?: number) => {
    if (!lines.length) return;
    setOutput((o) => [...o.slice(-199), { id: uid("o"), at: new Date().toLocaleTimeString(), sql, line, lines }]);
  };

  /** 1-based editor line of an absolute model offset. */
  const lineOf = (offset: number) => editorRef.current?.getModel()?.getPositionAt(offset).lineNumber;

  const revealRange = (r: { start: number; end: number }) => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (!ed || !model) return;
    const a = model.getPositionAt(r.start);
    const b = model.getPositionAt(r.end);
    ed.setSelection({ startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column });
    ed.revealLineInCenter(a.lineNumber);
    ed.focus();
  };

  // Keep-alive found the connection dead and reconnected in the background.
  useEffect(() => {
    const un = onSessionReconnected((e) => {
      if (e.sessionId !== conn.info.sessionId) return;
      addLog(
        e.ok
          ? `⚠ Connection was lost (${e.reason.split("\n")[0]}) and re-established automatically.${conn.autocommit ? "" : " Uncommitted changes were rolled back by the server."}`
          : `Connection lost (${e.reason.split("\n")[0]}); automatic reconnect failed. It will be retried on the next statement.`,
        false,
      );
      if (!conn.autocommit) setTxPending(false);
    });
    return () => {
      un.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.info.sessionId, conn.autocommit]);

  // Toad-style olive colour for names of existing tables / views / packages.
  useObjectHighlight(editorInst, conn.key, isSql(dialect) && (settings.highlightObjects ?? true));

  const resultsRef = useRef(results);
  resultsRef.current = results;
  // release server-side result buffers when the tab unmounts
  useEffect(() => () => resultsRef.current.forEach((r) => api.releaseResult(r.result.resultId).catch(() => {})), []);

  const askBinds = (names: string[]) =>
    new Promise<Record<string, string> | null>((resolve) => setBinds({ names, resolve }));

  /**
   * Runs statements in order. F9 runs one; F5 (`script`) runs all and, with "Continue on error",
   * keeps going after failures (Toad's script mode). DBMS_OUTPUT is collected after each statement.
   */
  const exec = async (stmts: Stmt[], opts: { replace: boolean; maxRows?: number; script?: boolean }) => {
    if (!stmts.length) return;
    setRunning(true);
    const continueOnError = !!opts.script && settings.scriptOnError === "continue";
    const fresh: ResultTab[] = [];
    let lastTab: string | null = null;
    let errors = 0;
    let done = 0;
    let gotOutput = false;
    const started = performance.now();
    try {
      for (let idx = 0; idx < stmts.length; idx++) {
        const s = stmts[idx];
        const line = lineOf(s.start);
        const where = line ? { line, range: { start: s.start, end: s.end } } : {};
        if (stmts.length > 1) setProgress(`Executing ${idx + 1}/${stmts.length}`);
        let sql = s.sql;
        const names = findBindVars(sql, dialect);
        if (names.length) {
          const vals = await askBinds(names);
          if (!vals) {
            addLog("Cancelled (bind variables).", false);
            break;
          }
          sql = substituteBinds(sql, vals);
        }
        if (settings.confirmDml && isSql(dialect) && /^\s*(update|delete)\b/i.test(sql) && !/\bwhere\b/i.test(sql)) {
          if (!(await confirmAsk(`This ${sql.trim().split(/\s/)[0].toUpperCase()} has no WHERE clause and will affect every row.\n\nRun it anyway?`, { danger: true }))) {
            addLog("Cancelled by user.", false);
            break;
          }
        }
        if (settings.confirmDml && dialect === "elasticsearch" && isDestructiveEsRequest(sql)) {
          const requestLine = sql.trim().split("\n")[0];
          if (!(await confirmAsk(`${requestLine}\n\nThis request deletes or closes data in the cluster. Run it anyway?`, { danger: true }))) {
            addLog("Cancelled by user.", false);
            break;
          }
        }
        const t0 = performance.now();
        try {
          const r = await api.execute(conn.info.sessionId, sql, opts.maxRows ?? settings.fetchSize);
          const ms = Math.round(performance.now() - t0);
          done++;
          if (r.notice) addLog(`⚠ ${r.notice}`, false);
          if (conn.status === "lost" || r.notice) setConnStatus(conn.key, "ok", r.notice ? "Reconnected" : undefined);
          addHistory({ sql, conn: conn.profile.id, at: new Date().toISOString(), ms, ok: true });
          if (r.output?.length) {
            pushOutput(r.output, sql, line);
            gotOutput = true;
          }
          if (r.columns.length) {
            const t: ResultTab = { id: uid("r"), title: `Result ${fresh.length + 1}`, sql, result: r };
            fresh.push(t);
            lastTab = t.id;
            addLog(`${r.rows.length.toLocaleString()} row(s) fetched${r.truncated ? " (more available)" : ""} in ${r.elapsedMs} ms`, true, where);
          } else {
            const kw = sql.trim().split(/\s+/)[0].toUpperCase();
            const plsql = /^(BEGIN|DECLARE)$/.test(kw) || (kw === "CREATE" && /\b(PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE)\b/i.test(sql.slice(0, 200)));
            const what = plsql ? (kw === "CREATE" ? "Compiled" : "PL/SQL block completed") : `${kw} OK`;
            const rows = !plsql && r.affected !== null ? ` — ${r.affected.toLocaleString()} row(s) affected` : "";
            addLog(`${what}${rows} (${r.elapsedMs} ms)`, true, where);
            if (!conn.autocommit && /^(INSERT|UPDATE|DELETE|MERGE)$/.test(kw)) setTxPending(true);
            if (/^(COMMIT|ROLLBACK)$/.test(kw)) setTxPending(false);
            if (/^(CREATE|DROP|ALTER|RENAME|TRUNCATE)$/.test(kw) || /\.(drop|createCollection|insertOne|insertMany|createIndex)\(/.test(sql)) invalidateObjects(conn.key);
          }
        } catch (e) {
          errors++;
          addHistory({ sql, conn: conn.profile.id, at: new Date().toISOString(), ms: 0, ok: false });
          const msg = errorText(e);
          if (msg.includes("Reconnect failed")) setConnStatus(conn.key, "lost", msg);
          else if (msg.includes("has been re-established")) setConnStatus(conn.key, "ok", "Reconnected");
          addLog(`${line ? `Line ${line}: ` : ""}${msg}\n  at: ${sql.slice(0, 200)}`, false, where);
          // Lines printed before a PL/SQL block failed are still in the buffer.
          if (serverOutput) {
            const left = await api.takeServerOutput(conn.info.sessionId).catch(() => [] as string[]);
            if (left.length) {
              pushOutput(left, sql, line);
              gotOutput = true;
            }
          }
          if (!continueOnError) {
            lastTab = "log";
            if (opts.script && idx < stmts.length - 1) addLog(`Script stopped at statement ${idx + 1} of ${stmts.length} (On error: Stop).`, false);
            break;
          }
        }
      }
    } finally {
      setRunning(false);
      setProgress("");
    }
    if (opts.script && stmts.length > 1) {
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      addLog(`Script done: ${done} of ${stmts.length} statement(s) succeeded, ${errors} error(s), ${secs} s`, errors === 0);
      if (errors) lastTab = "log";
    }
    if (fresh.length) {
      setResults((prev) => {
        if (opts.replace) prev.forEach((r) => api.releaseResult(r.result.resultId).catch(() => {}));
        return opts.replace ? fresh : [...prev, ...fresh];
      });
    }
    // Show DBMS Output when the run produced output but no grid (typical PL/SQL block).
    setActiveResult(lastTab ?? (gotOutput ? "output" : "log"));
  };

  const currentStatement = (): Stmt | null => {
    const ed = editorRef.current;
    if (!ed) return null;
    const model = ed.getModel()!;
    const sel = ed.getSelection();
    if (sel && !sel.isEmpty()) {
      const text = model.getValueInRange(sel);
      const start = model.getOffsetAt(sel.getStartPosition());
      return { sql: text.trim().replace(/;\s*$/, ""), start, end: model.getOffsetAt(sel.getEndPosition()) };
    }
    const offset = model.getOffsetAt(ed.getPosition()!);
    const s = statementAt(model.getValue(), offset, dialect);
    if (s) {
      const a = model.getPositionAt(s.start), b = model.getPositionAt(s.end);
      ed.setSelection({ startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column });
      setTimeout(() => ed.setPosition(ed.getSelection()!.getEndPosition()), 400);
    }
    return s;
  };

  const runStatement = () => {
    const s = currentStatement();
    if (s) exec([s], { replace: true });
  };

  const runScript = () => {
    const ed = editorRef.current;
    if (!ed) return;
    const model = ed.getModel()!;
    const sel = ed.getSelection();
    const partial = sel && !sel.isEmpty();
    const text = partial ? model.getValueInRange(sel!) : ed.getValue();
    const base = partial ? model.getOffsetAt(sel!.getStartPosition()) : 0;
    // statement offsets become absolute so errors can point at the right line
    const stmts = splitStatements(text, dialect).map((st) => ({ ...st, start: st.start + base, end: st.end + base }));
    exec(stmts, { replace: true, script: true });
  };

  const explain = async () => {
    const s = currentStatement();
    if (!s) return;
    if (dialect === "oracle" || dialect === "postgres") {
      setRunning(true);
      try {
        const p = await api.explainPlan(conn.info.sessionId, s.sql);
        setPlan({ sql: s.sql, plan: p });
        setActiveResult("plan");
        addLog(`Explain plan: ${p.nodes.length} step(s)`);
      } catch (e) {
        addLog(errorText(e), false);
        setActiveResult("log");
      } finally {
        setRunning(false);
      }
      return;
    }
    exec([{ ...s, sql: explainSql(dialect, s.sql) }], { replace: false });
  };

  const format = () => {
    const ed = editorRef.current;
    if (!ed) return;
    try {
      const sel = ed.getSelection();
      const model = ed.getModel()!;
      const whole = !sel || sel.isEmpty();
      const src = whole ? model.getValue() : model.getValueInRange(sel!);
      if (!canFormat(dialect)) {
        ed.getAction("editor.action.formatDocument")?.run();
        return;
      }
      // The timestamp header belongs to the document, so only add it when formatting everything.
      const out = formatSql(src, dialect, {
        style: settings.formatStyle ?? "toad",
        header: whole && (settings.formatHeader ?? true),
      });
      ed.executeEdits("format", [{ range: whole ? model.getFullModelRange() : sel!, text: out }]);
    } catch (e) {
      addLog(`Format failed: ${errorText(e)}`, false);
      setActiveResult("log");
    }
  };

  const txn = async (what: "commit" | "rollback") => {
    try {
      await (what === "commit" ? api.commit(conn.info.sessionId) : api.rollback(conn.info.sessionId));
      setTxPending(false);
      addLog(what === "commit" ? "Committed." : "Rolled back.");
    } catch (e) {
      addLog(errorText(e), false);
    }
    setActiveResult("log");
  };

  const toggleAutocommit = async () => {
    const on = !conn.autocommit;
    if (on && txPending && !(await confirmAsk("Enabling auto-commit will COMMIT the pending transaction. Continue?"))) return;
    try {
      await api.setAutocommit(conn.info.sessionId, on);
      setAutocommit(conn.key, on);
      if (on) setTxPending(false);
      addLog(`Auto-commit ${on ? "ON" : "OFF"}`);
    } catch (e) {
      addLog(errorText(e), false);
    }
  };

  // Keep latest handlers for Monaco commands registered once.
  const openObject = async (text: string) => {
    if (/^(select|from|where|and|or|not|in|is|null|join|left|right|inner|outer|on|as|by|group|order|having|insert|into|update|delete|set|values|with|union|all|distinct|case|when|then|else|end|begin|declare)$/i.test(text)) return;
    const obj = await resolveIdentifier(conn, text, editorRef.current?.getValue() ?? "");
    if (!obj) {
      addLog(`Object not found: ${text}`, false);
      return;
    }
    // Toad: tables/views open on the describe (columns) view, code on its source.
    const describe = ["table", "view", "materialized view", "collection", "label", "relationship"].includes(obj.kind);
    openTab({ id: uid(), connKey: conn.key, kind: "object", title: obj.name, object: obj, view: describe ? "columns" : "ddl" });
  };

  const connRef = useRef(conn);
  connRef.current = conn;
  /** Ctrl+S: writes the tab to its file (asking for one the first time, or always with `as`). */
  const saveFile = async (as = false) => {
    const sql = editorRef.current?.getValue() ?? tab.sql;
    let path: string | null | undefined = as ? undefined : tab.filePath;
    if (!path) {
      path = await saveDialog({
        defaultPath: tab.filePath ?? `${tab.title.replace(/[\\/:*?"<>|]/g, "_").replace(/\.sql$/i, "")}.sql`,
        filters: [{ name: "SQL", extensions: ["sql"] }, { name: "All files", extensions: ["*"] }],
      });
      if (!path) return;
    }
    try {
      await writeTextFile(path, sql);
      setTabFile(tab.id, path, sql);
    } catch (e) {
      addLog(`Save failed: ${errorText(e)}`, false);
      setActiveResult("log");
    }
  };

  const handlers = useRef({ runStatement, runScript, format, explain, openObject, saveFile });
  handlers.current = { runStatement, runScript, format, explain, openObject, saveFile };

  const onMount: OnMount = (ed, monaco) => {
    editorRef.current = ed;
    setEditorInst(ed);
    registerCompletion(monaco as unknown as typeof Monaco);
    modelConn.set(ed.getModel()!.uri.toString(), conn.key);
    // Syntax errors / unknown tables / unknown alias.columns underlined while typing.
    const inspections = attachInspections(ed, monaco as unknown as typeof Monaco, () => connRef.current);
    ed.onDidDispose(() => inspections.dispose());

    // Toad-style navigation: Ctrl+hover underlines an object name, Ctrl+click / F4 opens it.
    const link = ed.createDecorationsCollection();
    ed.onMouseMove((e) => {
      const pos = e.target.position;
      const hit = e.event.ctrlKey && pos ? identifierAt(ed.getModel()!, pos) : null;
      link.set(hit ? [{ range: hit.range, options: { inlineClassName: "ctrl-object-link" } }] : []);
    });
    ed.onKeyUp((e) => e.keyCode === monaco.KeyCode.Ctrl && link.clear());
    ed.onMouseDown((e) => {
      if (!e.event.ctrlKey || !e.target.position) return;
      const hit = identifierAt(ed.getModel()!, e.target.position);
      if (!hit) return;
      e.event.preventDefault();
      handlers.current.openObject(hit.text);
    });
    // Per-editor actions. NOT ed.addCommand: Monaco registers those in a keybinding service shared by
    // every editor, so the most recently created tab's handler wins — F9 in "SQL 1" would run "SQL 2".
    const bind = (id: string, label: string, keys: number[], run: () => void) =>
      ed.addAction({ id: `thor.${id}`, label, keybindings: keys, run: () => run() });
    const K = monaco.KeyCode, M = monaco.KeyMod;
    bind("openObject", "Open object at cursor", [K.F4], () => {
      const hit = identifierAt(ed.getModel()!, ed.getPosition()!);
      if (hit) handlers.current.openObject(hit.text);
    });
    bind("runStatement", "Execute statement", [M.CtrlCmd | K.Enter, K.F9], () => handlers.current.runStatement());
    bind("runScript", "Execute as script", [K.F5, M.CtrlCmd | M.Shift | K.Enter], () => handlers.current.runScript());
    bind("format", "Format SQL", [M.CtrlCmd | M.Shift | K.KeyF], () => handlers.current.format());
    bind("explain", "Explain plan", [M.CtrlCmd | K.KeyE], () => handlers.current.explain());
    bind("save", "Save to file", [M.CtrlCmd | K.KeyS], () => handlers.current.saveFile());
    bind("saveAs", "Save to file as…", [M.CtrlCmd | M.Shift | K.KeyS], () => handlers.current.saveFile(true));
    ed.focus();
  };

  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const box = containerRef.current!.getBoundingClientRect();
    const move = (ev: MouseEvent) => setSplit(Math.min(0.85, Math.max(0.15, (ev.clientY - box.top) / box.height)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, []);

  const active = results.find((r) => r.id === activeResult);

  // Current schema switcher (the session is shared by every SQL tab of this connection).
  const canSwitchSchema = dialect === "oracle" || dialect === "postgres" || dialect === "mysql";
  const [schemas, setSchemas] = useState<string[]>([]);
  useEffect(() => {
    if (canSwitchSchema) api.listSchemas(conn.info.sessionId).then(setSchemas).catch(() => {});
  }, [conn.info.sessionId, canSwitchSchema]);
  const currentSchema = schemas.find((x) => x.toLowerCase() === conn.info.currentSchema.toLowerCase()) ?? conn.info.currentSchema;
  const switchSchema = async (schema: string) => {
    try {
      const now = await api.setCurrentSchema(conn.info.sessionId, schema);
      setCurrentSchema(conn.key, now || schema);
      addLog(`Current schema: ${now || schema}`, true);
    } catch (e) {
      addLog(errorText(e), false);
      setActiveResult("log");
    }
  };

  // Result tab id -> table its rows can be edited in (null: not a plain single-table SELECT).
  const [editTargets, setEditTargets] = useState<Record<string, EditTarget | null>>({});
  useEffect(() => {
    if (!active || active.id in editTargets) return;
    const id = active.id;
    editTargetFor(active.sql)
      .catch(() => null)
      .then((t) => setEditTargets((p) => ({ ...p, [id]: t })));
  }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const editTargetFor = async (sql: string): Promise<EditTarget | null> => {
    if (!["postgres", "mysql", "sqlite", "mssql", "oracle"].includes(dialect)) return null;
    const stmt = sql.trim().replace(/;\s*$/, "");
    if (!/^select\b/i.test(stmt) || /\b(group\s+by|distinct|union|intersect|minus|except|connect\s+by|pivot)\b/i.test(stmt)) return null;
    const [a] = await api.sqlAnalyze(dialect, [stmt]);
    if (!a || a.error || a.derived.length || a.tables.length !== 1 || a.tables[0].cte) return null;
    const ident = (p: string) =>
      /^["`[]/.test(p) ? p.slice(1, -1) : dialect === "oracle" ? p.toUpperCase() : dialect === "postgres" ? p.toLowerCase() : p;
    const parts = a.tables[0].name.split(".").map(ident);
    let name = parts[parts.length - 1];
    let schema = parts.length > 1 ? parts[parts.length - 2] : conn.info.currentSchema;
    if (dialect === "oracle") {
      // Follows synonyms; only real tables are editable.
      const o = await api.resolveObject(conn.info.sessionId, schema, name);
      if (!o || o.kind !== "table") return null;
      ({ schema, name } = o);
    }
    const columns = await api.tableColumns(conn.info.sessionId, schema, name);
    return columns.length ? { table: qualified(dialect, schema, name), columns } : null;
  };

  /** Runs grid-generated DML in this session, optionally commits, then re-runs the result's query. */
  const applyGridChanges = async (tab: ResultTab, stmts: string[], commit: boolean) => {
    for (let i = 0; i < stmts.length; i++) {
      try {
        await api.execute(conn.info.sessionId, stmts[i], 0);
      } catch (e) {
        if (!conn.autocommit && i > 0) setTxPending(true);
        const left = !conn.autocommit && i > 0 ? `\n${i} earlier statement(s) are pending in the transaction; Rollback to undo them.` : "";
        throw new Error(`Statement ${i + 1} failed: ${errorText(e)}${left}`);
      }
    }
    addLog(`${stmts.length} grid change(s) applied${conn.autocommit ? "" : commit ? " and committed" : " (not committed)"}.`, true);
    if (commit) {
      await api.commit(conn.info.sessionId);
      setTxPending(false);
    } else if (!conn.autocommit) setTxPending(true);
    try {
      const r = await api.execute(conn.info.sessionId, tab.sql, settings.fetchSize);
      api.releaseResult(tab.result.resultId).catch(() => {});
      setResults((rs) => rs.map((x) => (x.id === tab.id ? { ...x, result: r } : x)));
    } catch (e) {
      addLog(`Refresh failed: ${errorText(e)}`, false);
    }
  };
  const connHistory = history.filter((h) => h.conn === conn.profile.id).slice(0, 100);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 border-b border-line bg-panel px-2 py-1">
        <IconButton title="Execute statement (Ctrl+Enter / F9)" onClick={runStatement} disabled={running}>
          <Play size={16} className="text-ok" fill="currentColor" />
        </IconButton>
        <IconButton title="Execute script (F5)" onClick={runScript} disabled={running}>
          <PlaySquare size={16} className="text-ok" />
        </IconButton>
        <IconButton title="Cancel running statement" onClick={() => api.cancel(conn.info.sessionId).catch((e) => addLog(errorText(e), false))} disabled={!running}>
          <Square size={14} className="text-danger" fill="currentColor" />
        </IconButton>
        <IconButton title="Explain plan (Ctrl+E)" onClick={explain} disabled={running || ["mssql", "redis", "mongodb", "janusgraph", "elasticsearch"].includes(dialect)}>
          <ListTree size={16} />
        </IconButton>
        <div className="mx-1 h-5 w-px bg-line" />
        <IconButton title="Format SQL (Ctrl+Shift+F)" onClick={format}>
          <AlignLeft size={16} />
        </IconButton>
        <IconButton title={tab.filePath ? `Save to ${tab.filePath} (Ctrl+S; Ctrl+Shift+S: save as)` : "Save to file (Ctrl+S)"} onClick={() => saveFile()}>
          <Save size={15} />
        </IconButton>
        <IconButton
          title="Save selection as snippet"
          onClick={() => {
            const ed = editorRef.current;
            const sel = ed?.getSelection();
            const text = sel && !sel.isEmpty() ? ed!.getModel()!.getValueInRange(sel) : ed?.getValue();
            if (!text?.trim()) return;
            const name = prompt("Snippet name (use it from autocomplete):");
            if (name) saveSnippet({ name, sql: text });
          }}
        >
          <BookmarkPlus size={16} />
        </IconButton>
        <IconButton title="Query history" active={showHistory} onClick={() => setShowHistory((v) => !v)}>
          <History size={16} />
        </IconButton>
        {TRANSACTIONAL.includes(dialect) && (<>
        <div className="mx-1 h-5 w-px bg-line" />
        <button
          onClick={toggleAutocommit}
          title="Toggle auto-commit"
          className={clsx(
            "h-7 rounded-md px-2 text-xs font-medium",
            conn.autocommit ? "text-muted hover:bg-hover" : "bg-warn/15 text-warn hover:bg-warn/25",
          )}
        >
          Auto-commit: {conn.autocommit ? "ON" : "OFF"}
        </button>
        {!conn.autocommit && (
          <>
            <Button size="sm" variant={txPending ? "primary" : "ghost"} onClick={() => txn("commit")} title="Commit">
              <CheckCheck size={14} /> Commit
            </Button>
            <Button size="sm" variant="ghost" onClick={() => txn("rollback")} title="Rollback">
              <Undo2 size={14} /> Rollback
            </Button>
          </>
        )}
        {txPending && <span className="ml-1 text-xs font-medium text-warn">● uncommitted changes</span>}
        </>)}
        {dialect === "oracle" && (
          <button
            onClick={toggleServerOutput}
            title="Capture DBMS_OUTPUT.PUT_LINE output after every statement"
            className={clsx("ml-1 h-7 rounded-md px-2 text-xs font-medium", serverOutput ? "text-ok hover:bg-hover" : "text-muted hover:bg-hover")}
          >
            DBMS Output: {serverOutput ? "ON" : "OFF"}
          </button>
        )}
        <select
          className="ml-1 h-7 rounded-md border border-line bg-panel px-1 text-xs outline-none"
          value={settings.scriptOnError ?? "stop"}
          onChange={(e) => updateSettings({ scriptOnError: e.target.value as "stop" | "continue" })}
          title="F5 script: what to do when a statement fails"
        >
          <option value="stop">F5 on error: Stop</option>
          <option value="continue">F5 on error: Continue</option>
        </select>
        <div className="flex-1" />
        {running && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <Spinner size={12} /> {progress || "Running…"}
          </span>
        )}
        {canSwitchSchema && (
          <select
            className="ml-2 h-7 max-w-48 rounded-md border border-line bg-panel px-1 text-xs outline-none"
            value={currentSchema}
            onChange={(e) => switchSchema(e.target.value)}
            disabled={running}
            title="Current schema for unqualified names (all SQL tabs of this connection)"
          >
            {!schemas.includes(currentSchema) && <option value={currentSchema}>{currentSchema || "—"}</option>}
            {schemas.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        )}
      </div>

      <div ref={containerRef} className="flex min-h-0 flex-1 flex-col">
        <div className="relative min-h-0" style={{ height: `${split * 100}%` }}>
          <Editor
            language={LANG[dialect]}
            value={tab.sql}
            onChange={(v) => updateSql(tab.id, v ?? "")}
            onMount={onMount}
            theme={editorTheme(colors.dark, settings.editorScheme)}            options={{
                  // Toad shows brackets black; Monaco colours bracket pairs by default.
                  bracketPairColorization: { enabled: settings.editorScheme === "vscode" },
              fontSize: settings.fontSize,
              fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
              minimap: { enabled: false },
              automaticLayout: true,
              scrollBeyondLastLine: false,
              wordWrap: "off",
              renderLineHighlight: "all",
              tabSize: 2,
              quickSuggestions: { other: true, strings: false, comments: false },
              suggestOnTriggerCharacters: true,
            }}
          />
          {showHistory && (
            <div className="absolute inset-y-0 right-0 z-10 flex w-96 flex-col border-l border-line bg-panel shadow-xl">
              <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
                <span className="text-xs font-semibold">History (this connection)</span>
                <IconButton title="Close" onClick={() => setShowHistory(false)}>
                  <X size={14} />
                </IconButton>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {connHistory.length === 0 && <div className="p-4 text-xs text-muted">No history yet.</div>}
                {connHistory.map((h, i) => (
                  <button
                    key={i}
                    className="block w-full border-b border-line/60 px-3 py-2 text-left hover:bg-hover"
                    onClick={() => {
                      const ed = editorRef.current!;
                      ed.executeEdits("history", [{ range: ed.getSelection()!, text: h.sql + (dialect === "redis" ? "\n" : ";\n") }]);
                      ed.focus();
                    }}
                  >
                    <div className="flex justify-between text-[11px] text-muted">
                      <span>{new Date(h.at).toLocaleString()}</span>
                      <span className={h.ok ? "" : "text-danger"}>{h.ok ? `${h.ms} ms` : "failed"}</span>
                    </div>
                    <div className="line-clamp-3 font-mono text-xs">{h.sql}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="h-1.5 shrink-0 cursor-row-resize border-y border-line bg-panel-2 hover:bg-accent/30" onMouseDown={startDrag} />
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-0.5 overflow-x-auto border-b border-line bg-panel-2 px-1">
            <ResultTabButton active={activeResult === "log"} onClick={() => setActiveResult("log")}>
              <FileCode2 size={13} /> Messages
              {log.some((l) => !l.ok) && <span className="h-1.5 w-1.5 rounded-full bg-danger" />}
            </ResultTabButton>
            {(dialect === "oracle" || output.length > 0) && (
              <ResultTabButton active={activeResult === "output"} onClick={() => setActiveResult("output")}>
                <Terminal size={13} /> DBMS Output
                {output.length > 0 && <span className="text-muted">({output.reduce((n, b) => n + b.lines.length, 0)})</span>}
              </ResultTabButton>
            )}
            {plan && (
              <ResultTabButton active={activeResult === "plan"} onClick={() => setActiveResult("plan")}>
                <ListTree size={13} /> Explain Plan
                <span
                  role="button"
                  className="ml-0.5 rounded hover:bg-hover"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPlan(null);
                    if (activeResult === "plan") setActiveResult("log");
                  }}
                >
                  <X size={12} />
                </span>
              </ResultTabButton>
            )}
            {results.map((r) => (
              <ResultTabButton key={r.id} active={activeResult === r.id} onClick={() => setActiveResult(r.id)}>
                {r.title}
                <span className="text-muted">({r.result.rows.length}{r.result.truncated ? "+" : ""})</span>
                <span
                  role="button"
                  className="ml-0.5 rounded hover:bg-hover"
                  onClick={(e) => {
                    e.stopPropagation();
                    api.releaseResult(r.result.resultId).catch(() => {});
                    setResults((rs) => rs.filter((x) => x.id !== r.id));
                    if (activeResult === r.id) setActiveResult("log");
                  }}
                >
                  <X size={12} />
                </span>
              </ResultTabButton>
            ))}
          </div>
          <div className="min-h-0 flex-1">
            {activeResult === "plan" && plan ? (
              <ExplainPlanView plan={plan.plan} sql={plan.sql} />
            ) : activeResult === "output" ? (
              <div className="flex h-full flex-col bg-panel">
                <div className="flex items-center gap-2 border-b border-line px-3 py-1 text-xs">
                  <span className={serverOutput ? "text-ok" : "text-muted"}>
                    {dialect === "oracle" ? (serverOutput ? "Capturing DBMS_OUTPUT" : "DBMS Output is OFF") : "Server output"}
                  </span>
                  <div className="flex-1" />
                  <Button size="sm" variant="ghost" disabled={!output.length} onClick={() => navigator.clipboard.writeText(output.flatMap((b) => b.lines).join("\n"))}>
                    <Copy size={13} /> Copy
                  </Button>
                  <Button size="sm" variant="ghost" disabled={!output.length} onClick={() => setOutput([])}>
                    <Eraser size={13} /> Clear
                  </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-2 font-mono text-xs select-text">
                  {output.length === 0 && (
                    <div className="p-3 font-sans text-[13px] text-muted">
                      Output of <code>DBMS_OUTPUT.PUT_LINE</code> appears here after each statement.
                    </div>
                  )}
                  {output.map((b) => (
                    <div key={b.id} className="mb-2">
                      <div className="text-[11px] text-muted">
                        [{b.at}]{b.line ? ` line ${b.line}` : ""} · {b.sql.replace(/\s+/g, " ").slice(0, 80)}
                      </div>
                      {b.lines.map((l, i) => (
                        <div key={i} className="whitespace-pre-wrap">
                          {l || "\u00a0"}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ) : active ? (
              <ResultGrid
                result={active.result}
                dialect={dialect}
                fetchEdges={graphDb ? fetchEdges : undefined}
                onExport={() => setExportFor(active)}
                edit={editTargets[active.id] ?? undefined}
                onApplySql={(stmts, commit) => applyGridChanges(active, stmts, commit)}
                autocommit={conn.autocommit}
                onFetchAll={async () => {
                  setRunning(true);
                  try {
                    const r = await api.execute(conn.info.sessionId, active.sql, 0);
                    api.releaseResult(active.result.resultId).catch(() => {});
                    setResults((rs) => rs.map((x) => (x.id === active.id ? { ...x, result: r } : x)));
                  } catch (e) {
                    addLog(errorText(e), false);
                  } finally {
                    setRunning(false);
                  }
                }}
              />
            ) : (
              <div className="h-full overflow-auto bg-panel p-2 font-mono text-xs select-text">
                {log.length === 0 && (
                  <div className="p-4 font-sans text-[13px] text-muted">
                    {PLACEHOLDER[dialect] && (
                      <pre className="mb-3 rounded bg-panel-2 p-2 font-mono text-xs">{"Example:\n" + PLACEHOLDER[dialect]}</pre>
                    )}
                    <b>Ctrl+Enter</b> / <b>F9</b> run statement at cursor · <b>F5</b> run script · <b>Ctrl+E</b> explain ·{" "}
                    <b>Ctrl+Shift+F</b> format · <b>Ctrl+Space</b> autocomplete · <b>Ctrl+Click</b> / <b>F4</b> open object
                  </div>
                )}
                {log.map((l, i) => (
                  <div
                    key={i}
                    onClick={() => l.range && revealRange(l.range)}
                    title={l.range ? "Go to statement" : undefined}
                    className={clsx("whitespace-pre-wrap py-0.5", !l.ok && "text-danger", l.range && "cursor-pointer hover:bg-hover")}
                  >
                    <span className="text-muted">[{l.at}]</span>
                    {l.line && <span className="ml-1 text-muted underline">L{l.line}</span>} {l.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {binds && (
        <Modal
          title="Bind variables"
          width={420}
          onClose={() => {
            binds.resolve(null);
            setBinds(null);
          }}
          footer={
            <>
              <Button onClick={() => { binds.resolve(null); setBinds(null); }}>Cancel</Button>
              <Button variant="primary" onClick={() => { binds.resolve(bindValues); setBinds(null); }}>
                Run
              </Button>
            </>
          }
        >
          <div className="space-y-2">
            {binds.names.map((n, i) => (
              <div key={n} className="grid grid-cols-[120px_1fr] items-center gap-2">
                <span className="font-mono text-xs">:{n}</span>
                <Input
                  autoFocus={i === 0}
                  value={bindValues[n] ?? ""}
                  onChange={(e) => setBindValues((v) => ({ ...v, [n]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      binds.resolve(bindValues);
                      setBinds(null);
                    }
                  }}
                />
              </div>
            ))}
            <div className="text-xs text-muted">Numbers are inserted as-is, text is quoted, NULL is NULL.</div>
          </div>
        </Modal>
      )}

      {exportFor && (
        <ExportDialog
          resultId={exportFor.result.resultId}
          rowCount={exportFor.result.rows.length}
          truncated={exportFor.result.truncated}
          sessionId={conn.info.sessionId}
          sql={exportFor.sql}
          dialect={dialect}
          onClose={() => setExportFor(null)}
        />
      )}
    </div>
  );
}

function ResultTabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "inline-flex h-7 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-xs",
        active ? "border-accent bg-panel font-semibold" : "border-transparent text-muted hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
