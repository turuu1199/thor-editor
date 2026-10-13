import Editor from "@monaco-editor/react";
import { Copy, FileInput, KeyRound, RefreshCw, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, Spinner, Tabs } from "../../components/ui";
import { api, errorText, isSql, type ColumnInfo, type DbObject, type QueryResult } from "../../lib/ipc";
import { LANG } from "../editor/SqlEditor";
import { qualified, selectAllSql } from "../../lib/sql";
import { useThemeColors } from "../../lib/theme";
import { editorTheme } from "../../lib/editorTheme";
import { useApp, uid, type Connection, type SourceFocus } from "../../store/app";
import { ExportDialog } from "../export/ExportDialog";
import { ResultGrid } from "../grid/ResultGrid";
import { DATA_KINDS, kindIcon } from "./Explorer";
import { SourceView } from "./SourceView";

const SOURCE_KINDS = new Set(["package", "package body", "procedure", "function", "trigger", "type", "type body"]);

/** DDL per connection/object, so reopening an object's script is instant (Refresh reloads). */
const ddlCache = new Map<string, string>();

type View = "data" | "columns" | "ddl";

export function ObjectView({
  object,
  conn,
  onImport,
  initialView,
  focus,
}: {
  object: DbObject;
  conn: Connection;
  onImport?: (schema: string, table?: string) => void;
  initialView?: View;
  focus?: SourceFocus;
}) {
  const d = conn.info.dialect;
  const fetchEdges = useCallback((ids: string[]) => api.graphEdges(conn.info.sessionId, ids), [conn.info.sessionId]);
  const hasData = DATA_KINDS.has(object.kind);
  const hasColumns = hasData && d !== "redis";
  const sqlish = isSql(d);
  // Oracle stored code gets the Toad-style Spec/Body source editor.
  const plsql = d === "oracle" && SOURCE_KINDS.has(object.kind);
  // Toad opens the describe (columns) view first.
  const defaultView: View = hasColumns ? "columns" : hasData ? "data" : "ddl";
  const [view, setView] = useState<View>(
    initialView && (initialView !== "data" || hasData) && (initialView !== "columns" || hasColumns) ? initialView : defaultView,
  );
  // Explorer tree clicks on Spec / Body / members jump to the source view.
  useEffect(() => {
    if (focus) setView("ddl");
  }, [focus?.seq]);
  const ddlKey = `${conn.info.sessionId}|${object.schema}|${object.name}|${object.kind}`;
  const [ddlMode, setDdlMode] = useState<"fast" | "full">("fast");
  const [colFilter, setColFilter] = useState("");
  const [data, setData] = useState<QueryResult | null>(null);
  const [cols, setCols] = useState<ColumnInfo[] | null>(
    () => useApp.getState().columns[conn.key]?.[`${object.schema}.${object.name}`] ?? null,
  );
  const [ddl, setDdl] = useState<string | null>(() => ddlCache.get(ddlKey) ?? null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const { settings, openTab, cacheColumns } = useApp();
  const colors = useThemeColors();
  const sql = selectAllSql(d, object.schema, object.name, settings.fetchSize, object.kind);
  const table = qualified(d, object.schema, object.name);
  const allRowsSql = sqlish ? `SELECT * FROM ${table}` : sql;

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const r = await api.execute(conn.info.sessionId, sql, settings.fetchSize);
      setData((old) => {
        if (old) api.releaseResult(old.resultId).catch(() => {});
        return r;
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [conn.info.sessionId, sql, settings.fetchSize]);

  const loadCols = useCallback(async () => {
    try {
      const c = await api.tableColumns(conn.info.sessionId, object.schema, object.name);
      setCols(c);
      cacheColumns(conn.key, `${object.schema}.${object.name}`, c);
    } catch (e) {
      setError(errorText(e));
    }
  }, [conn.info.sessionId, conn.key, object.schema, object.name, cacheColumns]);

  const loadDdl = useCallback(
    async (full = false) => {
      setLoading(true);
      setError("");
      try {
        const text = await api.objectDdl(conn.info.sessionId, object.schema, object.name, object.kind, full);
        setDdl(text);
        setDdlMode(full ? "full" : "fast");
        if (!full) ddlCache.set(ddlKey, text);
      } catch (e) {
        setError(errorText(e));
      } finally {
        setLoading(false);
      }
    },
    [conn.info.sessionId, object, ddlKey],
  );

  useEffect(() => {
    if (hasColumns && !cols) loadCols();
    if (view === "data" && !data) loadData();
    if (view === "ddl" && ddl === null && !plsql) loadDdl(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const tabs: { value: View; label: string }[] = [
    ...(hasColumns ? [{ value: "columns" as View, label: "Columns" }] : []),
    ...(hasData ? [{ value: "data" as View, label: "Data" }] : []),
    { value: "ddl", label: plsql ? "Source" : d === "redis" ? "Info" : "DDL" },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-1.5">
        {kindIcon(object.kind, 16)}
        <span className="font-semibold">{object.name}</span>
        <span className="text-xs text-muted">
          {object.kind} · {object.schema}
        </span>
        <Tabs className="ml-4 w-64" value={view} onChange={setView} items={tabs} />
        <div className="flex-1" />
        {loading && <Spinner size={12} />}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => (view === "data" ? loadData() : view === "ddl" ? loadDdl(ddlMode === "full") : loadCols())}
          title="Refresh"
        >
          <RefreshCw size={13} /> Refresh
        </Button>
        {sqlish && object.kind === "table" && onImport && (
          <Button size="sm" variant="ghost" onClick={() => onImport(object.schema, object.name)} title="Import CSV / Excel into this table">
            <Upload size={13} /> Import
          </Button>
        )}
        {hasData && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => openTab({ id: uid(), connKey: conn.key, kind: "sql", title: object.name, sql: sql + (d === "redis" || d === "elasticsearch" ? "" : ";") })}
            title="Open query in SQL editor"
          >
            <FileInput size={13} /> Query
          </Button>
        )}
      </div>
      {error && <div className="m-2 rounded bg-danger/10 p-2 text-xs text-danger select-text">{error}</div>}
      <div className="min-h-0 flex-1">
        {view === "data" && data && (
          <ResultGrid
            result={data}
            dialect={d}
            fetchEdges={d === "neo4j" || d === "janusgraph" ? fetchEdges : undefined}
            onExport={() => setExporting(true)}
            onFetchAll={!sqlish ? undefined : async () => {
              setLoading(true);
              try {
                const r = await api.execute(conn.info.sessionId, allRowsSql, 0);
                api.releaseResult(data.resultId).catch(() => {});
                setData(r);
              } catch (e) {
                setError(errorText(e));
              } finally {
                setLoading(false);
              }
            }}
            edit={sqlish && d !== "clickhouse" && object.kind === "table" && cols ? { table, columns: cols } : undefined}
            autocommit={conn.autocommit}
            onApplySql={async (stmts, commit) => {
              for (const s of stmts) await api.execute(conn.info.sessionId, s, 0);
              if (commit) await api.commit(conn.info.sessionId);
              if (conn.autocommit || commit) await loadData();
              else {
                await loadData();
                setError("Changes applied in the open transaction. Use Commit in a SQL tab (or auto-commit) to persist them.");
              }
            }}
          />
        )}
        {view === "columns" && !cols && !error && (
          <div className="flex h-full items-center justify-center text-muted">
            <Spinner size={14} />
          </div>
        )}
        {view === "columns" && cols && (
          <div className="flex h-full flex-col bg-panel">
            <div className="flex items-center gap-3 border-b border-line px-3 py-1.5 text-xs">
              <input
                className="h-7 w-56 rounded-md border border-line bg-panel px-2 outline-none focus:border-accent"
                placeholder="Filter columns…"
                value={colFilter}
                onChange={(e) => setColFilter(e.target.value)}
              />
              <span className="text-muted">
                {cols.length} columns
                {cols.some((c) => c.primaryKey) && (
                  <>
                    {" "}
                    · PK: <span className="font-mono text-fg">{cols.filter((c) => c.primaryKey).map((c) => c.name).join(", ")}</span>
                  </>
                )}
              </span>
              <div className="flex-1" />
              <Button size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(cols.map((c) => c.name).join(", "))}>
                <Copy size={13} /> Copy names
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead className="sticky top-0 z-10 bg-panel-2 text-left text-xs text-muted">
                  <tr>
                    <th className="w-[22%] border-b border-line px-3 py-1.5">Column Name</th>
                    <th className="w-10 border-b border-line px-2 py-1.5 text-right">ID</th>
                    <th className="w-10 border-b border-line px-2 py-1.5 text-center">PK</th>
                    <th className="w-14 border-b border-line px-2 py-1.5 text-center">Null?</th>
                    <th className="w-[18%] border-b border-line px-3 py-1.5">Data Type</th>
                    <th className="w-[14%] border-b border-line px-3 py-1.5">Default</th>
                    <th className="border-b border-line px-3 py-1.5">Comments</th>
                  </tr>
                </thead>
                <tbody className="select-text">
                  {cols
                    .map((c, i) => ({ c, i }))
                    .filter(({ c }) => !colFilter || `${c.name} ${c.comment ?? ""}`.toLowerCase().includes(colFilter.toLowerCase()))
                    .map(({ c, i }) => (
                      <tr key={c.name} className={i % 2 ? "bg-panel-2/40 hover:bg-hover" : "hover:bg-hover"}>
                        <td className="border-b border-line/50 px-3 py-1 font-mono text-xs font-semibold">{c.name}</td>
                        <td className="border-b border-line/50 px-2 py-1 text-right text-xs text-muted">{i + 1}</td>
                        <td className="border-b border-line/50 px-2 py-1 text-center">
                          {c.primaryKey && <KeyRound size={12} className="inline text-warn" />}
                        </td>
                        <td className="border-b border-line/50 px-2 py-1 text-center text-xs">
                          {c.nullable ? "Y" : <b className="text-danger">N</b>}
                        </td>
                        <td className="border-b border-line/50 px-3 py-1 font-mono text-xs text-accent">{c.dataType}</td>
                        <td
                          className="max-w-48 truncate border-b border-line/50 px-3 py-1 font-mono text-xs text-muted"
                          title={c.defaultValue ?? ""}
                        >
                          {c.defaultValue ?? ""}
                        </td>
                        <td className="border-b border-line/50 px-3 py-1 text-xs">{c.comment ?? ""}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {view === "ddl" && plsql && <SourceView object={object} conn={conn} focus={focus} />}
        {view === "ddl" && !plsql && ddl !== null && (
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-1 border-b border-line bg-panel px-2 py-1">
              {d === "oracle" && (
                <Tabs
                  className="mr-2 w-80"
                  value={ddlMode}
                  onChange={(m) => {
                    if (m === "full") loadDdl(true);
                    else if (ddlCache.has(ddlKey)) {
                      setDdl(ddlCache.get(ddlKey)!);
                      setDdlMode("fast");
                    } else loadDdl(false);
                  }}
                  items={[
                    { value: "fast", label: "Script (fast)" },
                    { value: "full", label: <span title="Exact DDL from DBMS_METADATA (slower)">Full DDL</span> },
                  ]}
                />
              )}
              <Button size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(ddl)}>
                <Copy size={13} /> Copy
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => openTab({ id: uid(), connKey: conn.key, kind: "sql", title: `${object.name} DDL`, sql: ddl })}
              >
                <FileInput size={13} /> Open in editor
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <Editor
                language={d === "redis" ? "plaintext" : LANG[d]}
                value={ddl || "-- DDL not available"}
                theme={editorTheme(colors.dark, settings.editorScheme)}
                options={{
                  // Toad shows brackets black; Monaco colours bracket pairs by default.
                  bracketPairColorization: { enabled: settings.editorScheme === "vscode" },
                  readOnly: true,
                  minimap: { enabled: false },
                  automaticLayout: true,
                  fontSize: settings.fontSize,
                  fontFamily: "Cascadia Code, Consolas, monospace",
                  scrollBeyondLastLine: false,
                  renderLineHighlight: "none",
                  padding: { top: 8 },
                  folding: true,
                }}
              />
            </div>
          </div>
        )}
      </div>
      {exporting && data && (
        <ExportDialog
          resultId={data.resultId}
          rowCount={data.rows.length}
          truncated={data.truncated}
          sessionId={conn.info.sessionId}
          sql={allRowsSql}
          dialect={d}
          defaultTable={object.name}
          onClose={() => setExporting(false)}
        />
      )}
    </div>
  );
}
