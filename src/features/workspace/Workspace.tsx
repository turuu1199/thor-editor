import clsx from "clsx";
import { Activity, FileCode2, Network, Plus, X } from "lucide-react";
import { useCallback, useState } from "react";
import { IconButton } from "../../components/ui";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { useApp, uid, type Connection } from "../../store/app";
import { SqlEditor } from "../editor/SqlEditor";
import { Explorer, kindIcon } from "../explorer/Explorer";
import { ObjectView } from "../explorer/ObjectView";
import { ErDiagram } from "../er/ErDiagram";
import { ImportDialog } from "../import/ImportDialog";
import { SessionBrowser } from "../session/SessionBrowser";

export function Workspace({ conn, visible }: { conn: Connection; visible: boolean }) {
  const { tabs, activeTab, setActiveTab, closeTab, openTab } = useApp();
  const [sidebar, setSidebar] = useState(270);
  const [importing, setImporting] = useState<{ schema: string; table?: string } | null>(null);
  const onImport = (schema: string, table?: string) => setImporting({ schema, table });
  const mine = tabs.filter((t) => t.connKey === conn.key);
  const active = activeTab[conn.key];

  const newSql = () => {
    const n = mine.filter((t) => t.kind === "sql").length + 1;
    openTab({ id: uid(), connKey: conn.key, kind: "sql", title: `SQL ${n}`, sql: "" });
  };

  const drag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const move = (ev: MouseEvent) => setSidebar(Math.min(600, Math.max(180, ev.clientX)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, []);

  return (
    <div className={clsx("min-h-0 flex-1", visible ? "flex" : "hidden")}>
      <div style={{ width: sidebar }} className="shrink-0 border-r border-line">
        <Explorer conn={conn} onImport={onImport} />
      </div>
      <div className="w-1 shrink-0 cursor-col-resize hover:bg-accent/30" onMouseDown={drag} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center overflow-x-auto border-b border-line bg-panel-2">
          {mine.map((t) => (
            <div
              key={t.id}
              onClick={() => setActiveTab(conn.key, t.id)}
              onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
              className={clsx(
                "group flex h-8 shrink-0 cursor-default items-center gap-1.5 border-r border-line px-3 text-xs",
                active === t.id ? "bg-panel font-semibold" : "text-muted hover:bg-hover",
              )}
            >
              {t.kind === "sql" ? (
                <FileCode2 size={13} className="text-accent" />
              ) : t.kind === "er" ? (
                <Network size={13} className="text-accent" />
              ) : t.kind === "sessions" ? (
                <Activity size={13} className="text-accent" />
              ) : (
                kindIcon(t.object.kind, 13)
              )}
              <span className="max-w-44 truncate" title={t.kind === "sql" ? t.filePath : undefined}>
                {t.title}
                {t.kind === "sql" && t.filePath && t.sql !== t.savedSql && <span className="text-warn"> ●</span>}
              </span>
              <button
                className="rounded opacity-50 hover:bg-hover hover:opacity-100"
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <IconButton title="New SQL editor (Ctrl+T)" onClick={newSql} className="mx-1">
            <Plus size={15} />
          </IconButton>
        </div>
        <div className="relative min-h-0 flex-1">
          {mine.length === 0 && (
            <div className="flex h-full items-center justify-center text-muted">
              <button className="rounded-md border border-dashed border-line px-4 py-3 hover:bg-hover" onClick={newSql}>
                Open a SQL editor
              </button>
            </div>
          )}
          {mine.map((t) => (
            <div key={t.id} className={clsx("absolute inset-0", active === t.id ? "block" : "hidden")}>
              <ErrorBoundary>
              {t.kind === "sql" ? (
                <SqlEditor tab={t} conn={conn} />
              ) : t.kind === "er" ? (
                <ErDiagram conn={conn} schema={t.schema} tables={t.tables} />
              ) : t.kind === "sessions" ? (
                <SessionBrowser conn={conn} visible={visible && active === t.id} />
              ) : (
                <ObjectView object={t.object} conn={conn} onImport={onImport} initialView={t.view} focus={t.focus} />
              )}
              </ErrorBoundary>
            </div>
          ))}
        </div>
      </div>
      {importing && <ImportDialog conn={conn} schema={importing.schema} table={importing.table} onClose={() => setImporting(null)} />}
    </div>
  );
}
