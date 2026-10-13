import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ColumnInfo, ConnectInfo, DbObject, ProfileView } from "../lib/ipc";

export interface Connection {
  key: string;
  profile: ProfileView;
  info: ConnectInfo;
  autocommit: boolean;
  /** Result of the last check / keep-alive. */
  status?: "ok" | "lost" | "checking";
  /** DBMS_OUTPUT capture (Oracle); undefined = not set up yet. */
  serverOutput?: boolean;
  statusText?: string;
}

/** Explorer-tree navigation into a Spec/Body part (and line); `seq` makes repeat clicks re-apply. */
export interface SourceFocus {
  part: string;
  line?: number;
  seq: number;
}

export type EditorTab =
  | { id: string; connKey: string; kind: "sql"; title: string; sql: string; filePath?: string; savedSql?: string }
  | { id: string; connKey: string; kind: "object"; title: string; object: DbObject; view?: "data" | "columns" | "ddl"; focus?: SourceFocus }
  | { id: string; connKey: string; kind: "er"; title: string; schema: string; tables?: string[] }
  | { id: string; connKey: string; kind: "sessions"; title: string };

/** A SQL tab kept across restarts (per connection profile) until the user closes it. */
export interface SavedSqlTab {
  title: string;
  sql: string;
  filePath?: string;
  /** File content as last saved, to show unsaved changes. */
  savedSql?: string;
}

export interface HistoryEntry {
  sql: string;
  conn: string;
  at: string;
  ms: number;
  ok: boolean;
}

export interface Snippet {
  name: string;
  sql: string;
}

export interface Settings {
  theme: "light" | "dark" | "system";
  fetchSize: number;
  fontSize: number;
  confirmDml: boolean;
  formatStyle: "toad" | "standard";
  formatHeader: boolean;
  /** F5 script: stop at the first error or keep going (Toad's script mode). */
  scriptOnError: "stop" | "continue";
  /** Editor colours: Toad (default) or VS Code. */
  editorScheme: "toad" | "vscode";
  /** Colour table / view / package names that exist in the database (Toad-style). */
  highlightObjects: boolean;
}

interface State {
  connections: Connection[];
  activeConn: string | null;
  tabs: EditorTab[];
  activeTab: Record<string, string>;
  loginOpen: boolean;
  settingsOpen: boolean;
  objects: Record<string, Record<string, DbObject[]>>;
  columns: Record<string, Record<string, ColumnInfo[]>>;
  history: HistoryEntry[];
  snippets: Snippet[];
  settings: Settings;
  /** Profile id -> its SQL tabs, restored when the profile connects again. */
  savedTabs: Record<string, SavedSqlTab[]>;

  addConnection(c: Connection): void;
  closeConnection(key: string): void;
  setActiveConn(key: string): void;
  setAutocommit(key: string, on: boolean): void;
  setCurrentSchema(key: string, schema: string): void;
  setConnStatus(key: string, status: Connection["status"], text?: string): void;
  setConnServerOutput(key: string, on: boolean): void;
  openTab(tab: EditorTab): void;
  closeTab(id: string): void;
  setActiveTab(connKey: string, id: string): void;
  updateSql(id: string, sql: string): void;
  setTabFile(id: string, filePath: string, savedSql: string): void;
  setLoginOpen(v: boolean): void;
  setSettingsOpen(v: boolean): void;
  cacheObjects(connKey: string, schema: string, list: DbObject[]): void;
  invalidateObjects(connKey: string): void;
  cacheColumns(connKey: string, table: string, list: ColumnInfo[]): void;
  addHistory(h: HistoryEntry): void;
  clearHistory(): void;
  saveSnippet(s: Snippet): void;
  deleteSnippet(name: string): void;
  updateSettings(s: Partial<Settings>): void;
}

let seq = 0;

const savedSqlTabs = (s: Pick<State, "tabs">, connKey: string): SavedSqlTab[] =>
  s.tabs.flatMap((t) => (t.kind === "sql" && t.connKey === connKey ? [{ title: t.title, sql: t.sql, filePath: t.filePath, savedSql: t.savedSql }] : []));

/** Saved tabs of every profile, with the live tabs of connected profiles taking precedence. */
const allSavedTabs = (s: State): Record<string, SavedSqlTab[]> => {
  const out = { ...s.savedTabs };
  for (const c of s.connections) out[c.profile.id] = savedSqlTabs(s, c.key);
  return out;
};
export const uid = (p = "t") => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

export const useApp = create<State>()(
  persist(
    (set) => ({
      connections: [],
      activeConn: null,
      tabs: [],
      activeTab: {},
      loginOpen: true,
      settingsOpen: false,
      objects: {},
      columns: {},
      history: [],
      snippets: [],
      savedTabs: {},
      settings: { theme: "system", fetchSize: 500, fontSize: 13, confirmDml: true, formatStyle: "toad", formatHeader: true, scriptOnError: "stop", editorScheme: "toad", highlightObjects: true },

      addConnection: (c) =>
        set((s) => {
          // A second connection of an already-open profile starts fresh.
          const open = s.connections.some((x) => x.profile.id === c.profile.id);
          const saved = open ? [] : (s.savedTabs[c.profile.id] ?? []);
          const restored: EditorTab[] = (saved.length ? saved : [{ title: "SQL 1", sql: "" }]).map((t) => ({ ...t, id: uid(), connKey: c.key, kind: "sql" }));
          return {
            connections: [...s.connections, c],
            activeConn: c.key,
            tabs: [...s.tabs, ...restored],
            activeTab: { ...s.activeTab, [c.key]: restored[0].id },
            loginOpen: false,
          };
        }),
      closeConnection: (key) =>
        set((s) => {
          const connections = s.connections.filter((c) => c.key !== key);
          const closing = s.connections.find((c) => c.key === key);
          const savedTabs = closing ? { ...s.savedTabs, [closing.profile.id]: savedSqlTabs(s, key) } : s.savedTabs;
          const { [key]: _o, ...objects } = s.objects;
          const { [key]: _c, ...columns } = s.columns;
          return {
            connections,
            tabs: s.tabs.filter((t) => t.connKey !== key),
            activeConn: s.activeConn === key ? (connections[connections.length - 1]?.key ?? null) : s.activeConn,
            objects,
            columns,
            savedTabs,
            loginOpen: connections.length === 0 ? true : s.loginOpen,
          };
        }),
      setActiveConn: (key) => set({ activeConn: key }),
      setConnServerOutput: (key, on) =>
        set((s) => ({ connections: s.connections.map((c) => (c.key === key ? { ...c, serverOutput: on } : c)) })),
      setConnStatus: (key, status, text) =>
        set((s) => ({ connections: s.connections.map((c) => (c.key === key ? { ...c, status, statusText: text } : c)) })),
      setAutocommit: (key, on) =>
        set((s) => ({ connections: s.connections.map((c) => (c.key === key ? { ...c, autocommit: on } : c)) })),
      setCurrentSchema: (key, schema) =>
        set((s) => ({ connections: s.connections.map((c) => (c.key === key ? { ...c, info: { ...c.info, currentSchema: schema } } : c)) })),
      openTab: (tab) =>
        set((s) => {
          const existing =
            tab.kind === "object"
              ? s.tabs.find(
                  (t) =>
                    t.kind === "object" &&
                    t.connKey === tab.connKey &&
                    t.object.schema === tab.object.schema &&
                    t.object.name === tab.object.name,
                )
              : undefined;
          if (existing) {
            const activeTab = { ...s.activeTab, [tab.connKey]: existing.id };
            if (tab.kind !== "object" || !tab.focus) return { activeTab };
            const focus = tab.focus;
            return { activeTab, tabs: s.tabs.map((t) => (t.id === existing.id ? { ...t, focus } : t)) };
          }
          return { tabs: [...s.tabs, tab], activeTab: { ...s.activeTab, [tab.connKey]: tab.id } };
        }),
      closeTab: (id) =>
        set((s) => {
          const tab = s.tabs.find((t) => t.id === id);
          if (!tab) return {};
          const tabs = s.tabs.filter((t) => t.id !== id);
          const siblings = tabs.filter((t) => t.connKey === tab.connKey);
          const activeTab = { ...s.activeTab };
          if (activeTab[tab.connKey] === id) activeTab[tab.connKey] = siblings[siblings.length - 1]?.id ?? "";
          return { tabs, activeTab };
        }),
      setActiveTab: (connKey, id) => set((s) => ({ activeTab: { ...s.activeTab, [connKey]: id } })),
      updateSql: (id, sql) =>
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === id && t.kind === "sql" ? { ...t, sql } : t)) })),
      setTabFile: (id, filePath, savedSql) =>
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === id && t.kind === "sql" ? { ...t, filePath, savedSql, title: filePath.split(/[\\/]/).pop() || t.title } : t,
          ),
        })),
      setLoginOpen: (v) => set({ loginOpen: v }),
      setSettingsOpen: (v) => set({ settingsOpen: v }),
      cacheObjects: (k, schema, list) =>
        set((s) => ({ objects: { ...s.objects, [k]: { ...(s.objects[k] ?? {}), [schema]: list } } })),
      invalidateObjects: (k) =>
        set((s) => ({ objects: { ...s.objects, [k]: {} }, columns: { ...s.columns, [k]: {} } })),
      cacheColumns: (k, table, list) =>
        set((s) => ({ columns: { ...s.columns, [k]: { ...(s.columns[k] ?? {}), [table]: list } } })),
      addHistory: (h) => set((s) => ({ history: [h, ...s.history].slice(0, 500) })),
      clearHistory: () => set({ history: [] }),
      saveSnippet: (sn) => set((s) => ({ snippets: [...s.snippets.filter((x) => x.name !== sn.name), sn] })),
      deleteSnippet: (name) => set((s) => ({ snippets: s.snippets.filter((x) => x.name !== name) })),
      updateSettings: (p) => set((s) => ({ settings: { ...s.settings, ...p } })),
    }),
    {
      // Pre-rename (DbForge Lite) key, kept so history / snippets / settings survive.
      name: "dbforge-lite",
      partialize: (s) => ({ history: s.history, snippets: s.snippets, settings: s.settings, savedTabs: allSavedTabs(s) }),
      // Keep defaults for settings keys added after the user's data was saved.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<State>;
        return { ...current, ...p, settings: { ...current.settings, ...(p.settings ?? {}) } };
      },
    },
  ),
);
