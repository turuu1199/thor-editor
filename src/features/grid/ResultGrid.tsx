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
import { ArrowDown, ArrowUp, ClipboardCopy, Download, PanelRight, Search, Undo2, Save } from "lucide-react";
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
  /** Executes generated DML; resolves when done. */
  onApplySql?: (statements: string[]) => Promise<void>;
  /** Graph engines: loads edges between result nodes for the graph view. */
  fetchEdges?: (ids: string[]) => Promise<Record<string, unknown>[]>;
}

type Sort = { col: number; dir: 1 | -1 } | null;

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

export function ResultGrid({ result, dialect, onExport, onFetchAll, edit, onApplySql, fetchEdges }: Props) {
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
  const [preview, setPreview] = useState<string[] | null>(null);
  const [applyError, setApplyError] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSort(null);
    setEdits(new Map());
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

  const pkCols = useMemo(() => {
    if (!edit) return [];
    const pk = edit.columns.filter((c) => c.primaryKey).map((c) => c.name);
    return pk.map((n) => result.columns.findIndex((c) => c.name.toLowerCase() === n.toLowerCase())).filter((i) => i >= 0);
  }, [edit, result.columns]);
  const editable = !!edit && pkCols.length > 0 && !!onApplySql;

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
      const orig = order[row];
      const e = edits.get(orig);
      if (e?.has(col)) return e.get(col)!;
      return result.rows[orig]?.[col] ?? null;
    },
    [order, edits, result.rows],
  );

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const v = valueAt(row, col);
      const meta = result.columns[col];
      const edited = edits.get(order[row])?.has(col);
      return {
        kind: GridCellKind.Text,
        data: v === null ? "" : String(v),
        displayData: displayValue(v),
        allowOverlay: true,
        readonly: !editable,
        contentAlign: meta?.numeric ? "right" : "left",
        themeOverride: v === null ? { textDark: colors.muted } : edited ? { bgCell: colors.editBg } : undefined,
      };
    },
    [valueAt, result.columns, edits, order, editable, colors],
  );

  const onCellEdited = useCallback(
    ([col, row]: Item, cell: EditableGridCell) => {
      if (cell.kind !== GridCellKind.Text) return;
      const orig = order[row];
      const raw = cell.data;
      const original = result.rows[orig][col];
      const newVal: CellValue = raw === "" && original === null ? null : result.columns[col].numeric && raw !== "" && !isNaN(Number(raw)) ? Number(raw) : raw;
      setEdits((prev) => {
        const next = new Map(prev);
        const m = new Map(next.get(orig) ?? []);
        if (newVal === original) m.delete(col);
        else m.set(col, newVal);
        if (m.size) next.set(orig, m);
        else next.delete(orig);
        return next;
      });
    },
    [order, result.rows, result.columns],
  );

  const buildUpdates = (): string[] => {
    if (!edit) return [];
    const stmts: string[] = [];
    for (const [orig, changes] of edits) {
      const sets = [...changes.entries()].map(([c, v]) => `${quoteIdent(dialect, result.columns[c].name)} = ${literal(dialect, v)}`);
      const where = pkCols
        .map((c) => {
          const v = result.rows[orig][c];
          return v === null ? `${quoteIdent(dialect, result.columns[c].name)} IS NULL` : `${quoteIdent(dialect, result.columns[c].name)} = ${literal(dialect, v)}`;
        })
        .join(" AND ");
      stmts.push(`UPDATE ${edit.table} SET ${sets.join(", ")} WHERE ${where}`);
    }
    return stmts;
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
        {edits.size > 0 && (
          <>
            <div className="mx-1 h-5 w-px bg-line" />
            <span className="text-xs text-warn">{edits.size} modified row(s)</span>
            <Button size="sm" variant="primary" onClick={() => { setApplyError(""); setPreview(buildUpdates()); }}>
              <Save size={13} /> Review &amp; apply
            </Button>
            <Button size="sm" onClick={() => setEdits(new Map())}>
              <Undo2 size={13} /> Discard
            </Button>
          </>
        )}
        {edit && !editable && <span className="ml-1 text-xs text-muted">Read-only (no primary key)</span>}
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
              rows={order.length}
              getCellContent={getCellContent}
              getCellsForSelection={true}
              onCellEdited={editable ? onCellEdited : undefined}
              gridSelection={selection}
              onGridSelectionChange={setSelection}
              onColumnResize={(_c, w, i) => setWidths((p) => ({ ...p, [i]: w }))}
              onHeaderClicked={(col) =>
                setSort((s) => (s?.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null))
              }
              rowMarkers="number"
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
            <div className="border-b border-line px-4 py-2.5 text-sm font-semibold">Apply {preview.length} change(s)</div>
            <pre className="max-h-96 overflow-auto p-4 font-mono text-xs select-text">{preview.join(";\n") + ";"}</pre>
            {applyError && <div className="mx-4 mb-2 rounded bg-danger/10 px-3 py-2 text-xs text-danger select-text">{applyError}</div>}
            <div className="flex justify-end gap-2 border-t border-line px-4 py-2.5">
              <Button onClick={() => navigator.clipboard.writeText(preview.join(";\n") + ";")}>Copy SQL</Button>
              <Button onClick={() => setPreview(null)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={async () => {
                  try {
                    await onApplySql!(preview);
                    setPreview(null);
                    setEdits(new Map());
                  } catch (e) {
                    setApplyError(String(e));
                  }
                }}
              >
                Execute
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
