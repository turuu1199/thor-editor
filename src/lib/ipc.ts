import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Engine =
  | "postgres"
  | "mysql"
  | "mariadb"
  | "sqlite"
  | "mssql"
  | "oracle"
  | "clickhouse"
  | "redis"
  | "mongodb"
  | "neo4j"
  | "janusgraph"
  | "elasticsearch";
export type Dialect = "postgres" | "mysql" | "sqlite" | "mssql" | "oracle" | "clickhouse" | "redis" | "mongodb" | "neo4j" | "janusgraph" | "elasticsearch";
export type SqlDialect = "postgres" | "mysql" | "sqlite" | "mssql" | "oracle" | "clickhouse";

export const isSql = (d: Dialect): d is SqlDialect => !["redis", "mongodb", "neo4j", "janusgraph", "elasticsearch"].includes(d);

export interface SshOptions {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  keyPath: string;
}

export interface OracleOptions {
  method: "direct" | "tns" | "ldap";
  serviceType: "service" | "sid";
  service: string;
  tnsAlias: string;
  ldapAlias: string;
  connectAs: string;
  clientLibDir: string;
  configDir: string;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  engine: Engine;
  host: string;
  port: number;
  database: string;
  username: string;
  savePassword: boolean;
  color: string;
  favorite: boolean;
  folder: string;
  sslMode: string;
  auth: string;
  autocommit: boolean | null;
  oracle: OracleOptions;
  ssh: SshOptions;
  params: Record<string, string>;
  lastUsed?: string | null;
}

export interface ProfileView extends ConnectionProfile {
  hasPassword: boolean;
}

export type CellValue = string | number | boolean | null;

export interface ColumnMeta {
  name: string;
  typeName: string;
  numeric: boolean;
}

export interface QueryResult {
  resultId: string;
  columns: ColumnMeta[];
  rows: CellValue[][];
  truncated: boolean;
  affected: number | null;
  elapsedMs: number;
  notice?: string | null;
  /** DBMS_OUTPUT lines produced by the statement. */
  output?: string[];
}

export interface ConnectInfo {
  sessionId: string;
  version: string;
  dialect: Dialect;
  autocommit: boolean;
  currentSchema: string;
}

export interface DbObject {
  schema: string;
  name: string;
  kind: string;
}

/** Statement-relative position: 1-based lines/columns, end column exclusive. */
export interface SqlPos {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/** Syntax-tree facts about one statement (`sql_analyze`). */
export interface SqlAnalysis {
  error: { message: string; line: number; column: number } | null;
  tables: { name: string; alias: string | null; cte: boolean; pos: SqlPos }[];
  derived: { name: string; kind: "cte" | "subquery"; columns: string[]; star: boolean; sources: string[] }[];
  columns: { qualifier: string; name: string; pos: SqlPos }[];
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
  comment?: string | null;
}

export interface OracleHome {
  name: string;
  libDir: string;
  configDir: string | null;
  bundled: boolean;
}

export type ExportFormat = "csv" | "tsv" | "json" | "jsonl" | "xlsx" | "sql" | "markdown" | "html" | "xml";

export interface ExportOptions {
  format: ExportFormat;
  delimiter: string;
  quoteAll: boolean;
  header: boolean;
  nullText: string;
  tableName: string;
  batchSize: number;
  dialect: string;
  pretty: boolean;
  bom: boolean;
  maxRows: number;
}

export interface ForeignKey {
  name: string;
  table: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
}

export interface ImportSource {
  format: string;
  delimiter: string;
  header: boolean;
  sheet: string;
}

export interface ImportPreview {
  columns: string[];
  rows: string[][];
  sheets: string[];
  types: string[];
}

export interface ImportTarget {
  table: string;
  mapping: string[];
  create: boolean;
  types: string[];
  truncate: boolean;
  emptyAsNull: boolean;
  batchSize: number;
}

export interface KnownSource {
  kind: "toad" | "dbeaver" | "datagrip";
  label: string;
  path: string;
}

export interface DiffRow {
  status: "only_a" | "only_b" | "changed";
  a: CellValue[] | null;
  b: CellValue[] | null;
  changed: number[];
}

export interface CompareResult {
  columns: string[];
  keyColumns: string[];
  same: number;
  changed: number;
  onlyA: number;
  onlyB: number;
  duplicateKeys: number;
  rows: DiffRow[];
  truncated: boolean;
}

export interface SourcePart {
  label: string;
  objectType: string;
  text: string;
  created: string;
  lastDdl: string;
  status: string;
}

export interface SourceError {
  objectType: string;
  line: number;
  position: number;
  text: string;
  attribute: string;
}

export interface ObjectSource {
  parts: SourcePart[];
  errors: SourceError[];
}

export interface PlanNode {
  id: number;
  parentId: number | null;
  operation: string;
  options: string;
  object: string;
  cost: number | null;
  bytes: number | null;
  cardinality: number | null;
  time: string | null;
  optimizer: string;
  accessPredicates: string;
  filterPredicates: string;
}

export interface Plan {
  nodes: PlanNode[];
  text: string;
}

export interface SessionTest {
  alive: boolean;
  reconnected: boolean;
  latencyMs: number;
  version: string;
  error: string | null;
}

export interface DbSession {
  id: string;
  sid: string;
  user: string;
  status: string;
  machine: string;
  program: string;
  osUser: string;
  schema: string;
  sqlText: string;
  sqlId: string;
  wait: string;
  seconds: number | null;
  blockedBy: string;
  logonTime: string;
  isSelf: boolean;
}

export interface Grid {
  columns: string[];
  rows: string[][];
}

export interface SessionDetail {
  sqlFull: string;
  locks: Grid;
  longOps: Grid;
}

export const api = {
  listProfiles: () => invoke<ProfileView[]>("list_profiles"),
  saveProfile: (profile: ConnectionProfile, password?: string, sshPassword?: string, copyPasswordFrom?: string) =>
    invoke<ConnectionProfile>("save_profile", {
      profile,
      password: password ?? null,
      sshPassword: sshPassword ?? null,
      copyPasswordFrom: copyPasswordFrom ?? null,
    }),
  deleteProfile: (id: string) => invoke<void>("delete_profile", { id }),
  exportProfiles: (path: string) => invoke<number>("export_profiles", { path }),
  importProfiles: (path: string) => invoke<number>("import_profiles", { path }),
  testConnection: (profile: ConnectionProfile, password?: string, sshPassword?: string) =>
    invoke<string>("test_connection", { profile, password: password ?? null, sshPassword: sshPassword ?? null }),
  connect: (profile: ConnectionProfile, password?: string, sshPassword?: string) =>
    invoke<ConnectInfo>("connect", { profile, password: password ?? null, sshPassword: sshPassword ?? null }),
  disconnect: (sessionId: string) => invoke<void>("disconnect", { sessionId }),
  execute: (sessionId: string, sql: string, maxRows: number) =>
    invoke<QueryResult>("execute", { sessionId, sql, maxRows }),
  cancel: (sessionId: string) => invoke<void>("cancel_query", { sessionId }),
  commit: (sessionId: string) => invoke<void>("commit", { sessionId }),
  rollback: (sessionId: string) => invoke<void>("rollback", { sessionId }),
  setAutocommit: (sessionId: string, on: boolean) => invoke<void>("set_autocommit", { sessionId, on }),
  setCurrentSchema: (sessionId: string, schema: string) => invoke<string>("set_current_schema", { sessionId, schema }),
  releaseResult: (resultId: string) => invoke<void>("release_result", { resultId }),
  listSchemas: (sessionId: string) => invoke<string[]>("list_schemas", { sessionId }),
  listObjects: (sessionId: string, schema: string) => invoke<DbObject[]>("list_objects", { sessionId, schema }),
  tableColumns: (sessionId: string, schema: string, table: string) =>
    invoke<ColumnInfo[]>("table_columns", { sessionId, schema, table }),
  objectDdl: (sessionId: string, schema: string, name: string, kind: string, full = false) =>
    invoke<string>("object_ddl", { sessionId, schema, name, kind, full }),
  exportResult: (resultId: string, options: ExportOptions, path: string) =>
    invoke<number>("export_result", { resultId, options, path }),
  exportToString: (resultId: string, options: ExportOptions) =>
    invoke<string>("export_to_string", { resultId, options }),
  exportQuery: (sessionId: string, sql: string, options: ExportOptions, path: string, jobId: string) =>
    invoke<number>("export_query", { sessionId, sql, options, path, jobId }),
  oracleHomes: () => invoke<OracleHome[]>("oracle_homes"),
  tnsAliases: (configDir: string) => invoke<string[]>("tns_aliases", { configDir }),
  sqlAnalyze: (dialect: Dialect, statements: string[]) => invoke<SqlAnalysis[]>("sql_analyze", { dialect, statements }),
  graphEdges: (sessionId: string, ids: string[]) => invoke<Record<string, unknown>[]>("graph_edges", { sessionId, ids }),
  foreignKeys: (sessionId: string, schema: string) => invoke<ForeignKey[]>("foreign_keys", { sessionId, schema }),
  importPreview: (sessionId: string | null, path: string, options: ImportSource) =>
    invoke<ImportPreview>("import_preview", { sessionId, path, options }),
  importFile: (sessionId: string, path: string, source: ImportSource, target: ImportTarget, jobId: string) =>
    invoke<number>("import_file", { sessionId, path, source, target, jobId }),
  connectionSources: () => invoke<KnownSource[]>("connection_sources"),
  parseConnections: (kind: string, path: string) => invoke<ConnectionProfile[]>("parse_connections", { kind, path }),
  objectSource: (sessionId: string, schema: string, name: string, kind: string) =>
    invoke<ObjectSource>("object_source", { sessionId, schema, name, kind }),
  explainPlan: (sessionId: string, sql: string) => invoke<Plan>("explain_plan", { sessionId, sql }),
  testSession: (sessionId: string) => invoke<SessionTest>("test_session", { sessionId }),
  resolveObject: (sessionId: string, schema: string, name: string) =>
    invoke<DbObject | null>("resolve_object", { sessionId, schema, name }),
  sessionList: (sessionId: string) => invoke<DbSession[]>("session_list", { sessionId }),
  sessionDetail: (sessionId: string, id: string, sqlId: string) => invoke<SessionDetail>("session_detail", { sessionId, id, sqlId }),
  sessionKill: (sessionId: string, id: string, cancelOnly: boolean) => invoke<void>("session_kill", { sessionId, id, cancelOnly }),
  setServerOutput: (sessionId: string, on: boolean) => invoke<boolean>("set_server_output", { sessionId, on }),
  takeServerOutput: (sessionId: string) => invoke<string[]>("take_server_output", { sessionId }),
  compareResults: (a: string, b: string, keys: string[]) => invoke<CompareResult>("compare_results", { a, b, keys }),
};

export function onSessionReconnected(cb: (e: { sessionId: string; ok: boolean; reason: string }) => void): Promise<UnlistenFn> {
  return listen<{ sessionId: string; ok: boolean; reason: string }>("session-reconnected", (e) => cb(e.payload));
}

export function onImportProgress(cb: (p: { jobId: string; rows: number }) => void): Promise<UnlistenFn> {
  return listen<{ jobId: string; rows: number }>("import-progress", (e) => cb(e.payload));
}

export function onExportProgress(cb: (p: { jobId: string; rows: number }) => void): Promise<UnlistenFn> {
  return listen<{ jobId: string; rows: number }>("export-progress", (e) => cb(e.payload));
}

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
