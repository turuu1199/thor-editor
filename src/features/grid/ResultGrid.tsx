import DataEditor, {
  CompactSelection,
  GridCellKind,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type Theme,
} from "@glideapps/glide-data-grid";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Ban, ClipboardCopy, Download, PanelRight, Plus, Search, Trash2, Undo2, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, IconButton, Input, Select, Tabs } from "../../components/ui";
import { GraphView, hasGraph } from "./GraphView";
import { displayValue, formatRows, prettyValue, type CopyFormat } from "../../lib/format";
import type { CellValue, ColumnInfo, Dialect, QueryResult } from "../../lib/ipc";
import { literal, quoteIdent } from "../../lib/sql";
import { useThemeColors } from "../../lib/theme";

export interface EditTarget {
  table: string; // qualified name
  columns: ColumnInfo[];
}

interface Props {
  result: QueryResult;
  dialect: Dialect;
  onExport?: () => void;
  onFetchAll?: () => void;
  edit?: EditTarget;
  /** Executes generated DML (then commits when `commit`); resolves when done. */
  onApplySql?: (statements: string[], commit: boolean) => Promise<void>;
  /** Session auto-commit state: offers "Execute & Commit" when off. */
  autocommit?: boolean;
  /** Graph engines: loads edges between result nodes for the graph view. */
  fetchEdges?: (ids: string[]) => Promise<Record<string, unknown>[]>;
}

type Sort = { col: number; dir: 1 | -1 } | null;

/** Binary / LONG columns can't round-trip through a text literal. */
const NON_EDITABLE = /^(BLOB|BFILE|RAW|LONG|BYTEA|VARBINARY|BINARY|IMAGE|GEOMETRY|GEOGRAPHY|XMLTYPE|SDO_)/i;

/** SQL for a value written into `dataType`; Oracle needs explicit date/timestamp conversion. */
function valueSql(d: Dialect, dataType: string, v: CellValue): string {
  if (d === "oracle" && typeof v === "string" && v !== "") {
    if (/^DATE\b/i.test(dataType)) return `TO_DATE(${literal(d, v.slice(0, 19))}, '${v.length > 10 ? "YYYY-MM-DD HH24:MI:SS" : "YYYY-MM-DD"}')`;
    if (/^TIMESTAMP\b(?!.*TIME ZONE)/i.test(dataType)) return `TO_TIMESTAMP(${literal(d, v)}, 'YYYY-MM-DD HH24:MI:SS.FF')`;
  }
  return literal(d, v);
}

// WebKitGTK (Tauri on Linux) corrupts glide's scroll blit, which drawImage()s the canvas onto
// itself — glyphs come out torn until the cell is repainted. Redraw directly there instead.
const isWebKitGtk = /Linux/.test(navigator.userAgent) && /AppleWebKit/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);
const gridExperimental = isWebKitGtk ? { renderStrategy: "direct" as const } : undefined;

function compare(a: CellValue, b: CellValue): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const na = Number(a), nb = Number(b);
  if (typeof a !== "boolean" && !isNaN(na) && !isNaN(nb) && String(a).trim() !== "" && String(b).trim() !== "") return na - nb;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

export function ResultGrid({ result, dialect, onExport, onFetchAll, edit, onApplySql, autocommit = true, fetchEdges }: Props) {
  const colors = useThemeColors();
  const [sort, setSort] = useState<Sort>(null);
  const [filter, setFilter] = useState("");
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [selection, setSelection] = useState<GridSelection>({
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
  });
  const [viewer, setViewer] = useState(false);
  const graphable = useMemo(() => hasGraph(result), [result]);
  const [mode, setMode] = useState<"table" | "graph">("table");
  useEffect(() => setMode(graphable ? "graph" : "table"), [graphable, result.resultId]);
  const [edits, setEdits] = useState<Map<number, Map<number, CellValue>>>(new Map());
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [added, setAdded] = useState<CellValue[][]>([]);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [applyError, setApplyError] = useState("");
  const [applying, setApplying] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSort(null);
    setEdits(new Map());
    setDeleted(new Set());
    setAdded([]);
    setPreview(null);
    setWidths({});
  }, [result.resultId]);

  // Row index mapping (filter + sort) over the original rows.
  const order = useMemo(() => {
    let idx = result.rows.map((_, i) => i);
    const q = filter.trim().toLowerCase();
    if (q) idx = idx.filter((i) => result.rows[i].some((v) => v !== null && String(v).toLowerCase().includes(q)));
    if (sort) idx.sort((a, b) => compare(result.rows[a][sort.col], result.rows[b][sort.col]) * sort.dir);
    return idx;
  }, [result.rows, filter, sort]);

  // Result column -> table column (undefined: expression / not in the table, read-only).
  const tableCols = useMemo(
    () => result.columns.map((c) => edit?.columns.find((t) => t.name.toLowerCase() === c.name.toLowerCase())),
    [edit, result.columns],
  );
  const writable = useCallback((col: number) => !!tableCols[col] && !NON_EDITABLE.test(tableCols[col]!.dataType), [tableCols]);
  // Row identity: the primary key when the result has all of it, else every comparable column.
  const { keyCols, byPk } = useMemo(() => {
    if (!edit) return { keyCols: [] as number[], byPk: false };
    const pk = edit.columns.filter((c) => c.primaryKey);
    const pkIdx = pk.map((t) => tableCols.indexOf(t));
    if (pk.length && pkIdx.every((i) => i >= 0)) return { keyCols: pkIdx, byPk: true };
    return { keyCols: result.columns.map((_, i) => i).filter((i) => writable(i) && !/LOB|TEXT/i.test(tableCols[i]!.dataType)), byPk: false };
  }, [edit, tableCols, result.columns, writable]);
  const editable = !!edit && keyCols.length > 0 && !!onApplySql;
  const pending = edits.size + deleted.size + added.length;

  const columns: GridColumn[] = useMemo(
    () =>
      result.columns.map((c, i) => {
        const sample = result.rows.slice(0, 50).reduce((m, r) => Math.max(m, displayValue(r[i]).length), 0);
        const w = widths[i] ?? Math.min(360, Math.max(70, Math.max(c.name.length + 3, sample) * 7.5 + 16));
        const arrow = sort?.col === i ? (sort.dir === 1 ? " ▲" : " ▼") : "";
        return { id: String(i), title: c.name + arrow, width: w };
      }),
    [result.columns, result.rows, widths, sort],
  );

  const valueAt = useCallback(
    (row: number, col: number): CellValue => {
      if (row >= order.length) return added[row - order.length]?.[col] ?? null;
      const orig = order[row];
      const e = edits.get(orig);
      if (e?.has(col)) return e.get(col)!;
      return result.rows[orig]?.[col] ?? null;
    },
    [order, edits, added, result.rows],
  );

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const v = valueAt(row, col);
      const meta = result.columns[col];
      const isNew = row >= order.length;
      const isDeleted = !isNew && deleted.has(order[row]);
      const edited = !isNew && edits.get(order[row])?.has(col);
      const bgCell = isDeleted ? colors.deleteBg : isNew ? colors.insertBg : edited ? colors.editBg : undefined;
      return {
        kind: GridCellKind.Text,
        data: v === null ? "" : String(v),
        displayData: displayValue(v),
        allowOverlay: true,
        readonly: !editable || isDeleted || !writable(col),
        contentAlign: meta?.numeric ? "right" : "left",
        themeOverride: bgCell || v === null ? { ...(bgCell && { bgCell }), ...(v === null && { textDark: colors.muted }) } : undefined,
      };
    },
    [valueAt, result.columns, edits, deleted, order, editable, writable, colors],
  );

  const onCellEdited = useCallback(
    ([col, row]: Item, cell: EditableGridCell) => {
      if (cell.kind !== GridCellKind.Text) return;
      const raw = cell.data;
      const typed = (v: string): CellValue =>
        !result.columns[col].numeric ? v : v === "" ? null : !isNaN(Number(v)) ? Number(v) : v;
      if (row >= order.length) {
        const i = row - order.length;
        setAdded((prev) => prev.map((r, k) => (k === i ? r.map((v, c) => (c === col ? (raw === "" ? null : typed(raw)) : v)) : r)));
        return;
      }
      const orig = order[row];
      const original = result.rows[orig][col];
      const newVal: CellValue = raw === "" && original === null ? null : typed(raw);
      setCellValue(orig, col, newVal);
    },
    [order, result.rows, result.columns],
  );

  const setCellValue = (orig: number, col: number, newVal: CellValue) => {
    const original = result.rows[orig][col];
    setEdits((prev) => {
      const next = new Map(prev);
      const m = new Map(next.get(orig) ?? []);
      if (newVal === original) m.delete(col);
      else m.set(col, newVal);
      if (m.size) next.set(orig, m);
      else next.delete(orig);
      return next;
    });
  };

  const colSql = (c: number) => quoteIdent(dialect, tableCols[c]!.name);
  const valSql = (c: number, v: CellValue) => valueSql(dialect, tableCols[c]!.dataType, v);

  const buildStatements = (): string[] => {
    if (!edit) return [];
    const where = (orig: number) =>
      keyCols
        .map((c) => {
          const v = result.rows[orig][c];
          return v === null ? `${colSql(c)} IS NULL` : `${colSql(c)} = ${valSql(c, v)}`;
        })
        .join(" AND ");
    const stmts: string[] = [];
    for (const orig of deleted) stmts.push(`DELETE FROM ${edit.table} WHERE ${where(orig)}`);
    for (const [orig, changes] of edits) {
      if (deleted.has(orig)) continue;
      const sets = [...changes.entries()].map(([c, v]) => `${colSql(c)} = ${valSql(c, v)}`);
      stmts.push(`UPDATE ${edit.table} SET ${sets.join(", ")} WHERE ${where(orig)}`);
    }
    for (const row of added) {
      // Omitted (NULL) columns keep their defaults.
      const cols = row.map((_, c) => c).filter((c) => row[c] !== null && writable(c));
      if (!cols.length) continue;
      stmts.push(`INSERT INTO ${edit.table} (${cols.map(colSql).join(", ")}) VALUES (${cols.map((c) => valSql(c, row[c])).join(", ")})`);
    }
    return stmts;
  };

  const addRow = () => {
    setAdded((prev) => [...prev, result.columns.map(() => null)]);
    setFilter("");
  };

  /** Grid rows targeted by row actions: selected row markers, else the rows of the cell selection. */
  const targetRows = (): number[] => {
    if (selection.rows.length) return selection.rows.toArray();
    const r = selection.current?.range;
    return r ? Array.from({ length: r.height }, (_, k) => r.y + k) : [];
  };

  const toggleDelete = (rows = targetRows()) => {
    const newRows = new Set(rows.filter((r) => r >= order.length).map((r) => r - order.length));
    const existing = rows.filter((r) => r < order.length).map((r) => order[r]);
    if (newRows.size) setAdded((prev) => prev.filter((_, i) => !newRows.has(i)));
    if (existing.length)
      setDeleted((prev) => {
        const next = new Set(prev);
        const restore = existing.every((o) => next.has(o));
        for (const o of existing) restore ? next.delete(o) : next.add(o);
        return next;
      });
    setSelection({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
    setMenu(null);
  };

  const setNull = () => {
    const r = selection.current?.range;
    if (!r) return;
    for (let y = r.y; y < r.y + r.height; y++)
      for (let x = r.x; x < r.x + r.width; x++) {
        if (!writable(x)) continue;
        if (y >= order.length) {
          const i = y - order.length;
          setAdded((prev) => prev.map((row, k) => (k === i ? row.map((v, c) => (c === x ? null : v)) : row)));
        } else if (!deleted.has(order[y])) setCellValue(order[y], x, null);
      }
    setMenu(null);
  };

  const discard = () => {
    setEdits(new Map());
    setDeleted(new Set());
    setAdded([]);
  };

  const selectedRows = (): CellValue[][] => {
    const rows: number[] = [];
    if (selection.rows.length) rows.push(...selection.rows.toArray());
    else if (selection.current) {
      const r = selection.current.range;
      for (let y = r.y; y < r.y + r.height; y++) rows.push(y);
    }
    const list = rows.length ? rows : order.map((_, i) => i);
    const cols =
      selection.current && !selection.rows.length
        ? Array.from({ length: selection.current.range.width }, (_, k) => selection.current!.range.x + k)
        : result.columns.map((_, i) => i);
    return list.map((r) => cols.map((c) => valueAt(r, c)));
  };

  const selectedColumns = () =>
    selection.current && !selection.rows.length
      ? result.columns.slice(selection.current.range.x, selection.current.range.x + selection.current.range.width)
      : result.columns;

  const copyAs = async (fmt: CopyFormat) => {
    const txt = formatRows(fmt, selectedColumns(), selectedRows(), { dialect, table: edit?.table });
    await navigator.clipboard.writeText(txt);
    setMenu(null);
  };

  const current = selection.current?.cell;
  const currentValue = current ? valueAt(current[1], current[0]) : undefined;

  const theme: Partial<Theme> = useMemo(
    () => ({
      accentColor: colors.accent,
      accentLight: colors.accentSoft,
      textDark: colors.fg,
      textMedium: colors.muted,
      textLight: colors.muted,
      textHeader: colors.fg,
      textHeaderSelected: "#ffffff",
      bgCell: colors.panel,
      bgCellMedium: colors.panel2,
      bgHeader: colors.panel2,
      bgHeaderHasFocus: colors.hover,
      bgHeaderHovered: colors.hover,
      bgBubble: colors.panel2,
      bgBubbleSelected: colors.panel,
      bgSearchResult: colors.accentSoft,
      borderColor: colors.line,
      horizontalBorderColor: colors.line,
      drilldownBorder: colors.line,
      linkColor: colors.accent,
      fontFamily: '"Cascadia Code", Consolas, monospace',
      baseFontStyle: "12px",
      headerFontStyle: "600 12px",
      editorFontSize: "12px",
      bgIconHeader: colors.muted,
      fgIconHeader: colors.panel,
    }),
    [colors],
  );

  return (
    <div className="flex h-full min-h-0 flex-col" ref={wrapRef}>
      <div className="flex items-center gap-1 border-b border-line bg-panel px-2 py-1">
        <div className="relative w-56">
          <Search size={13} className="absolute left-2 top-2 text-muted" />
          <Input className="h-7 pl-7 text-xs" placeholder="Filter rows…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <Select
          className="h-7 w-32 text-xs"
          value=""
          onChange={(e) => e.target.value && copyAs(e.target.value as CopyFormat)}
          title="Copy selection (or all rows) as…"
        >
          <option value="">Copy as…</option>
          <option value="tsv">TSV (Excel)</option>
          <option value="csv">CSV</option>
          <option value="json">JSON</option>
          <option value="insert">SQL INSERT</option>
          <option value="markdown">Markdown</option>
          <option value="in-list">IN (…) list</option>
        </Select>
        {onExport && (
          <Button size="sm" onClick={onExport} title="Export to file (CSV, Excel, JSON, SQL…)">
            <Download size={13} /> Export
          </Button>
        )}
        {editable && mode === "table" && (
          <>
            <div className="mx-1 h-5 w-px bg-line" />
            <IconButton title="Add row" onClick={addRow}>
              <Plus size={15} />
            </IconButton>
            <IconButton title="Delete / restore selected rows (Del on selected row numbers)" onClick={() => toggleDelete()}>
              <Trash2 size={14} />
            </IconButton>
          </>
        )}
        {pending > 0 && (
          <>
            <div className="mx-1 h-5 w-px bg-line" />
            <span className="text-xs text-warn">
              {[edits.size && `${edits.size} modified`, added.length && `${added.length} new`, deleted.size && `${deleted.size} deleted`].filter(Boolean).join(", ")}
            </span>
            <Button size="sm" variant="primary" onClick={() => { setApplyError(""); setPreview(buildStatements()); }}>
              <Save size={13} /> Review &amp; apply
            </Button>
            <Button size="sm" onClick={discard}>
              <Undo2 size={13} /> Discard
            </Button>
          </>
        )}
        {edit && !editable && <span className="ml-1 text-xs text-muted">Read-only</span>}
        {editable && !byPk && (
          <span className="ml-1 text-xs text-warn" title="Updates and deletes match rows by every column value; duplicate rows are all affected.">
            No primary key in result
          </span>
        )}
        <div className="flex-1" />
        {graphable && (
          <Tabs
            className="w-40"
            value={mode}
            onChange={setMode}
            items={[
              { value: "table", label: "Table" },
              { value: "graph", label: "Graph" },
            ]}
          />
        )}
        <IconButton title="Value viewer" active={viewer} onClick={() => setViewer((v) => !v)}>
          <PanelRight size={15} />
        </IconButton>
      </div>

      {mode === "graph" && graphable ? (
        <div className="relative min-h-0 flex-1">
          <GraphView result={result} fetchEdges={fetchEdges} />
        </div>
      ) : (
      <div className="flex min-h-0 flex-1">
        <div
          className="relative min-w-0 flex-1"
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY });
          }}
        >
          {result.columns.length > 0 ? (
            <DataEditor
              columns={columns}
              rows={order.length + added.length}
              getCellContent={getCellContent}
              getCellsForSelection={true}
              onCellEdited={editable ? onCellEdited : undefined}
              onDelete={(sel) => {
                // Del on selected row numbers marks rows deleted; on cells it clears them as usual.
                if (!editable || !sel.rows.length) return editable;
                toggleDelete(sel.rows.toArray());
                return false;
              }}
              gridSelection={selection}
              onGridSelectionChange={setSelection}
              onColumnResize={(_c, w, i) => setWidths((p) => ({ ...p, [i]: w }))}
              onHeaderClicked={(col) =>
                setSort((s) => (s?.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null))
              }
              rowMarkers="clickable-number"
              smoothScrollX
              smoothScrollY
              theme={theme}
              width="100%"
              height="100%"
              rowHeight={26}
              headerHeight={28}
              keybindings={{ search: true, copy: true, selectAll: true }}
              experimental={gridExperimental}
            />
          ) : (
            <div className="p-6 text-muted">No columns.</div>
          )}
          {menu && (
            <div className="fixed inset-0 z-40" onMouseDown={() => setMenu(null)}>
              <div
                className="absolute min-w-44 rounded-md border border-line bg-panel py-1 text-[13px] shadow-xl"
                style={{ left: menu.x, top: menu.y }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {(
                  [
                    ["tsv", "Copy"],
                    ["csv", "Copy as CSV"],
                    ["json", "Copy as JSON"],
                    ["insert", "Copy as INSERT"],
                    ["markdown", "Copy as Markdown"],
                    ["in-list", "Copy as IN list"],
                  ] as [CopyFormat, string][]
                ).map(([f, label]) => (
                  <button key={f} className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-hover" onClick={() => copyAs(f)}>
                    <ClipboardCopy size={13} className="text-muted" /> {label}
                  </button>
                ))}
                {editable && (
                  <>
                    <button className="flex w-full items-center gap-2 border-t border-line px-3 py-1 text-left hover:bg-hover" onClick={setNull}>
                      <Ban size={13} className="text-muted" /> Set NULL
                    </button>
                    <button className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-hover" onClick={() => { setMenu(null); addRow(); }}>
                      <Plus size={13} className="text-muted" /> Add row
                    </button>
                    <button className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-hover" onClick={() => toggleDelete()}>
                      <Trash2 size={13} className="text-muted" /> Delete / restore row
                    </button>
                  </>
                )}
                {onExport && (
                  <button className="flex w-full items-center gap-2 border-t border-line px-3 py-1 text-left hover:bg-hover" onClick={() => { setMenu(null); onExport(); }}>
                    <Download size={13} className="text-muted" /> Export…
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
        {viewer && (
          <div className="flex w-80 shrink-0 flex-col border-l border-line bg-panel">
            <div className="border-b border-line px-3 py-1.5 text-xs font-semibold text-muted">
              {current ? `${result.columns[current[0]]?.name} · ${result.columns[current[0]]?.typeName || "value"}` : "Select a cell"}
            </div>
            <textarea
              readOnly
              className={clsx("min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-xs outline-none", currentValue === null && "text-muted")}
              value={currentValue === undefined ? "" : prettyValue(currentValue)}
            />
          </div>
        )}
      </div>
      )}

      <div className="flex items-center gap-3 border-t border-line bg-panel-2 px-3 py-1 text-xs text-muted">
        <span>
          {order.length.toLocaleString()} row{order.length === 1 ? "" : "s"}
          {filter && ` (filtered from ${result.rows.length.toLocaleString()})`}
        </span>
        {result.truncated && (
          <span className="text-warn">
            First {result.rows.length.toLocaleString()} rows fetched.
            {onFetchAll && (
              <button className="ml-1 underline hover:text-fg" onClick={onFetchAll}>
                Fetch all
              </button>
            )}
          </span>
        )}
        {sort && (
          <span className="inline-flex items-center gap-0.5">
            sorted by {result.columns[sort.col]?.name} {sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
          </span>
        )}
        <span className="ml-auto">{result.elapsedMs.toLocaleString()} ms</span>
      </div>

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={() => setPreview(null)}>
          <div className="w-full max-w-3xl rounded-xl border border-line bg-panel shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
            <div className="border-b border-line px-4 py-2.5 text-sm font-semibold">
              Apply {preview.length} change(s)
              {!autocommit && <span className="ml-2 text-xs font-normal text-muted">auto-commit is off: "Execute" leaves them in the open transaction</span>}
            </div>
            <pre className="max-h-96 overflow-auto p-4 font-mono text-xs select-text">{preview.join(";\n") + ";"}</pre>
            {applyError && <div className="mx-4 mb-2 rounded bg-danger/10 px-3 py-2 text-xs text-danger select-text">{applyError}</div>}
            <div className="flex justify-end gap-2 border-t border-line px-4 py-2.5">
              <Button onClick={() => navigator.clipboard.writeText(preview.join(";\n") + ";")}>Copy SQL</Button>
              <Button onClick={() => setPreview(null)}>Cancel</Button>
              {(autocommit ? [false] : [false, true]).map((commit) => (
                <Button
                  key={String(commit)}
                  variant={commit || autocommit ? "primary" : "default"}
                  disabled={applying}
                  onClick={async () => {
                    setApplying(true);
                    try {
                      await onApplySql!(preview, commit);
                      setPreview(null);
                      discard();
                    } catch (e) {
                      setApplyError(e instanceof Error ? e.message : String(e));
                    } finally {
                      setApplying(false);
                    }
                  }}
                >
                  {commit ? "Execute & Commit" : "Execute"}
                </Button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
