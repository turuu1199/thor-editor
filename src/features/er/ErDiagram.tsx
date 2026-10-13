import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "../../lib/fs";
import { Download, Maximize2, Plus, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Spinner } from "../../components/ui";
import { api, errorText, type ColumnInfo, type ForeignKey } from "../../lib/ipc";
import { useThemeColors } from "../../lib/theme";
import type { Connection } from "../../store/app";

const BOX_W = 230;
const HEAD_H = 26;
const ROW_H = 18;
const MAX_ROWS = 14;
const MAX_TABLES = 120;

interface Box {
  name: string;
  cols: ColumnInfo[];
  x: number;
  y: number;
}

function boxHeight(b: Box) {
  return HEAD_H + Math.min(b.cols.length, MAX_ROWS + 1) * ROW_H + 6;
}

/** Row y-offset for a column (clamped to the "…more" row when hidden). */
function colY(b: Box, col: string) {
  const i = b.cols.findIndex((c) => c.name === col);
  const row = i < 0 || i >= MAX_ROWS ? Math.min(b.cols.length, MAX_ROWS) : i;
  return b.y + HEAD_H + row * ROW_H + ROW_H / 2 + 2;
}

/** Initial placement: tables sorted by connectivity, laid out in a grid of columns. */
function layout(names: string[], cols: Record<string, ColumnInfo[]>, fks: ForeignKey[]): Box[] {
  const degree: Record<string, number> = {};
  for (const f of fks) {
    degree[f.table] = (degree[f.table] ?? 0) + 1;
    degree[f.refTable] = (degree[f.refTable] ?? 0) + 1;
  }
  const sorted = [...names].sort((a, b) => (degree[b] ?? 0) - (degree[a] ?? 0) || a.localeCompare(b));
  const perRow = Math.max(1, Math.ceil(Math.sqrt(sorted.length * 1.6)));
  const colHeights = new Array(perRow).fill(20);
  return sorted.map((name, i) => {
    const c = i % perRow;
    const b: Box = { name, cols: cols[name] ?? [], x: 20 + c * (BOX_W + 90), y: colHeights[c] };
    colHeights[c] += boxHeight(b) + 40;
    return b;
  });
}

/** Tables linked to `names` by a foreign key (either direction), excluding `names` themselves. */
function neighbours(names: Iterable<string>, fks: ForeignKey[]): string[] {
  const set = new Set(names);
  const out = new Set<string>();
  for (const f of fks) {
    if (set.has(f.table) && !set.has(f.refTable)) out.add(f.refTable);
    if (set.has(f.refTable) && !set.has(f.table)) out.add(f.table);
  }
  return [...out];
}

/**
 * `tables`: start from these tables and their direct relations (ERD for a table);
 * otherwise the whole schema, or its most connected tables when it is large.
 */
export function ErDiagram({ conn, schema, tables }: { conn: Connection; schema: string; tables?: string[] }) {
  const colors = useThemeColors();
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [allTables, setAllTables] = useState<string[]>([]);
  const [allFks, setAllFks] = useState<ForeignKey[]>([]);
  const [adding, setAdding] = useState("");
  const colCache = useRef<Record<string, ColumnInfo[]>>({});
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [filter, setFilter] = useState("");
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ kind: "pan" | "box"; name?: string; sx: number; sy: number; ox: number; oy: number } | null>(null);

  const loadColumns = async (names: string[]) => {
    const missing = names.filter((n) => !(n in colCache.current));
    for (let i = 0; i < missing.length; i++) {
      setLoading(`Loading columns ${i + 1}/${missing.length}…`);
      colCache.current[missing[i]] = await api.tableColumns(conn.info.sessionId, schema, missing[i]).catch(() => []);
    }
    return colCache.current;
  };

  const load = useCallback(async () => {
    setError("");
    setLoading("Loading tables…");
    colCache.current = {};
    try {
      const sid = conn.info.sessionId;
      const names = (await api.listObjects(sid, schema)).filter((o) => o.kind === "table").map((o) => o.name);
      const known = new Set(names);
      setLoading("Loading foreign keys…");
      const fk = (await api.foreignKeys(sid, schema)).filter((f) => known.has(f.table) && known.has(f.refTable));
      let pick: string[];
      if (tables?.length) {
        const seeds = tables.filter((t) => known.has(t));
        pick = [...seeds, ...neighbours(seeds, fk)];
        setNote(pick.length > MAX_TABLES ? `Showing ${MAX_TABLES} of ${pick.length} related tables.` : "");
      } else if (names.length > MAX_TABLES) {
        // Large schema: the most connected tables say the most about its structure.
        const degree: Record<string, number> = {};
        for (const f of fk) for (const t of [f.table, f.refTable]) degree[t] = (degree[t] ?? 0) + 1;
        pick = [...names].sort((a, b) => (degree[b] ?? 0) - (degree[a] ?? 0) || a.localeCompare(b));
        setNote(`Showing the ${MAX_TABLES} most connected of ${names.length} tables. Add tables or double-click one to expand its relations.`);
      } else {
        pick = names;
        setNote("");
      }
      pick = pick.slice(0, MAX_TABLES);
      const cols = await loadColumns(pick);
      setAllTables(names);
      setAllFks(fk);
      setBoxes(layout(pick, cols, fk.filter((f) => pick.includes(f.table) && pick.includes(f.refTable))));
      setView({ x: 0, y: 0, k: 1 });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.info.sessionId, schema, tables?.join(",")]);

  /** Adds tables to the diagram in a new column next to `anchor` (or right of everything). */
  const addTables = async (names: string[], anchor?: Box) => {
    const shown = new Set(boxes.map((b) => b.name));
    const fresh = names.filter((n) => !shown.has(n));
    if (!fresh.length) return;
    try {
      const cols = await loadColumns(fresh);
      setBoxes((bs) => {
        const x = anchor ? anchor.x + BOX_W + 90 : Math.max(-70, ...bs.map((b) => b.x)) + BOX_W + 90;
        let y = anchor ? anchor.y : Math.min(20, ...bs.map((b) => b.y));
        const added = fresh.map((name) => {
          const b: Box = { name, cols: cols[name] ?? [], x, y };
          y += boxHeight(b) + 40;
          return b;
        });
        return [...bs, ...added];
      });
    } finally {
      setLoading("");
    }
  };

  const expand = (b: Box) => addTables(neighbours([b.name], allFks), b);
  const remove = (name: string) => setBoxes((bs) => bs.filter((b) => b.name !== name));

  useEffect(() => {
    load();
  }, [load]);

  const byName = useMemo(() => Object.fromEntries(boxes.map((b) => [b.name, b])), [boxes]);
  const fks = useMemo(() => allFks.filter((f) => f.table in byName && f.refTable in byName), [allFks, byName]);
  const addable = useMemo(() => allTables.filter((t) => !(t in byName)), [allTables, byName]);
  const q = filter.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!q) return new Set(boxes.map((b) => b.name));
    const hit = new Set(boxes.filter((b) => b.name.toLowerCase().includes(q)).map((b) => b.name));
    // include direct neighbours of matches
    for (const f of fks) {
      if (hit.has(f.table)) hit.add(f.refTable);
      if (hit.has(f.refTable)) hit.add(f.table);
    }
    return hit;
  }, [q, boxes, fks]);

  const toWorld = (cx: number, cy: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
  };

  const onMouseDown = (e: React.MouseEvent, name?: string) => {
    e.stopPropagation();
    if (name) {
      const b = byName[name];
      const w = toWorld(e.clientX, e.clientY);
      drag.current = { kind: "box", name, sx: w.x, sy: w.y, ox: b.x, oy: b.y };
    } else {
      drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
    }
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pan") {
      setView((v) => ({ ...v, x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy }));
    } else {
      const w = toWorld(e.clientX, e.clientY);
      setBoxes((bs) => bs.map((b) => (b.name === d.name ? { ...b, x: d.ox + w.x - d.sx, y: d.oy + w.y - d.sy } : b)));
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    setView((v) => {
      const k = Math.min(2.5, Math.max(0.15, v.k * (e.deltaY < 0 ? 1.1 : 0.9)));
      return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
    });
  };

  const fit = () => {
    const shown = boxes.filter((b) => visible.has(b.name));
    if (!shown.length || !svgRef.current) return;
    const minX = Math.min(...shown.map((b) => b.x)), minY = Math.min(...shown.map((b) => b.y));
    const maxX = Math.max(...shown.map((b) => b.x + BOX_W)), maxY = Math.max(...shown.map((b) => b.y + boxHeight(b)));
    const r = svgRef.current.getBoundingClientRect();
    const k = Math.min(1.5, Math.max(0.15, Math.min(r.width / (maxX - minX + 60), r.height / (maxY - minY + 60))));
    setView({ k, x: -minX * k + 30, y: -minY * k + 30 });
  };

  const exportSvg = async () => {
    const svg = svgRef.current;
    if (!svg) return;
    const path = await saveDialog({ defaultPath: `${schema}-er.svg`, filters: [{ name: "SVG", extensions: ["svg"] }] });
    if (!path) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const g = clone.querySelector("g[data-world]");
    g?.setAttribute("transform", "translate(0,0) scale(1)");
    const maxX = Math.max(...boxes.map((b) => b.x + BOX_W)) + 40, maxY = Math.max(...boxes.map((b) => b.y + boxHeight(b))) + 40;
    clone.setAttribute("width", String(maxX));
    clone.setAttribute("height", String(maxY));
    clone.setAttribute("style", `background:${colors.panel};font-family:Segoe UI,system-ui,sans-serif`);
    await writeTextFile(path, new XMLSerializer().serializeToString(clone));
  };

  const edgePath = (f: ForeignKey) => {
    const a = byName[f.table], b = byName[f.refTable];
    if (!a || !b) return "";
    const y1 = colY(a, f.columns[0]), y2 = colY(b, f.refColumns[0]);
    if (a === b) {
      const x = a.x + BOX_W;
      return `M ${x} ${y1} C ${x + 50} ${y1}, ${x + 50} ${y2}, ${x} ${y2}`;
    }
    const aRight = a.x + BOX_W < b.x;
    const bRight = b.x + BOX_W < a.x;
    const x1 = aRight ? a.x + BOX_W : bRight ? a.x : a.x + BOX_W;
    const x2 = aRight ? b.x : bRight ? b.x + BOX_W : b.x + BOX_W;
    const dx = Math.max(40, Math.abs(x2 - x1) / 2);
    const c1 = aRight || !bRight ? x1 + dx : x1 - dx;
    const c2 = aRight ? x2 - dx : bRight ? x2 + dx : x2 + dx;
    return `M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`;
  };

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="font-semibold">ER diagram</span>
        <span className="text-xs text-muted">
          {schema} · {boxes.length} tables · {fks.length} relations
        </span>
        <div className="relative ml-3 w-56">
          <Search size={13} className="absolute left-2 top-2 text-muted" />
          <Input className="h-7 pl-7 text-xs" placeholder="Focus tables…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <form
          className="relative w-56"
          onSubmit={(e) => {
            e.preventDefault();
            const name = allTables.find((t) => t.toLowerCase() === adding.trim().toLowerCase());
            if (name) addTables([name]).then(() => setAdding(""));
          }}
        >
          <Plus size={13} className="absolute left-2 top-2 text-muted" />
          <Input className="h-7 pl-7 text-xs" placeholder="Add table…" list="er-add-tables" value={adding} onChange={(e) => setAdding(e.target.value)} />
          <datalist id="er-add-tables">
            {addable.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </form>
        {note && <span className="truncate text-xs text-warn" title={note}>{note}</span>}
        <div className="flex-1" />
        {loading && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <Spinner size={12} /> {loading}
          </span>
        )}
        <Button size="sm" variant="ghost" onClick={fit}>
          <Maximize2 size={13} /> Fit
        </Button>
        <Button size="sm" variant="ghost" onClick={load}>
          <RefreshCw size={13} /> Reload
        </Button>
        <Button size="sm" variant="ghost" onClick={exportSvg} disabled={!boxes.length}>
          <Download size={13} /> SVG
        </Button>
      </div>
      {error && <div className="m-2 rounded bg-danger/10 p-2 text-xs text-danger select-text">{error}</div>}
      <svg
        ref={svgRef}
        className="min-h-0 flex-1 cursor-grab active:cursor-grabbing"
        onMouseDown={(e) => onMouseDown(e)}
        onMouseMove={onMouseMove}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => (drag.current = null)}
        onWheel={onWheel}
      >
        <defs>
          <marker id="er-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={colors.accent} />
          </marker>
        </defs>
        <g data-world transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {fks.map((f) =>
            visible.has(f.table) && visible.has(f.refTable) ? (
              <path
                key={f.table + f.name}
                d={edgePath(f)}
                fill="none"
                stroke={hover === f.table || hover === f.refTable ? colors.accent : colors.muted}
                strokeWidth={hover === f.table || hover === f.refTable ? 2 : 1.2}
                markerEnd="url(#er-arrow)"
              >
                <title>{`${f.name}: ${f.table}(${f.columns.join(", ")}) → ${f.refTable}(${f.refColumns.join(", ")})`}</title>
              </path>
            ) : null,
          )}
          {boxes.map((b) => {
            if (!visible.has(b.name)) return null;
            const h = boxHeight(b);
            const fkCols = new Set(fks.filter((f) => f.table === b.name).flatMap((f) => f.columns));
            return (
              <g
                key={b.name}
                transform={`translate(${b.x},${b.y})`}
                onMouseDown={(e) => onMouseDown(e, b.name)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  expand(b);
                }}
                onMouseEnter={() => setHover(b.name)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: "move" }}
              >
                <rect width={BOX_W} height={h} rx={6} fill={colors.panel} stroke={hover === b.name ? colors.accent : colors.line} strokeWidth={1.5} />
                <path d={`M0 6 a6 6 0 0 1 6 -6 h${BOX_W - 12} a6 6 0 0 1 6 6 v${HEAD_H - 6} h-${BOX_W} z`} fill={colors.accentSoft} />
                <text x={10} y={17} fontSize={12} fontWeight={600} fill={colors.fg}>
                  {b.name.length > 28 ? b.name.slice(0, 27) + "…" : b.name}
                </text>
                <title>{`${b.name} — double-click to add related tables`}</title>
                {hover === b.name && (
                  <text
                    x={BOX_W - 10}
                    y={17}
                    fontSize={13}
                    textAnchor="end"
                    fill={colors.muted}
                    style={{ cursor: "pointer" }}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => remove(b.name)}
                  >
                    ✕<title>Remove from diagram</title>
                  </text>
                )}
                {b.cols.slice(0, MAX_ROWS).map((c, i) => (
                  <g key={c.name} transform={`translate(0,${HEAD_H + i * ROW_H + 2})`}>
                    <text x={10} y={13} fontSize={11} fill={c.primaryKey ? colors.accent : colors.fg} fontWeight={c.primaryKey ? 600 : 400}>
                      {(c.primaryKey ? "🔑 " : fkCols.has(c.name) ? "↗ " : "") + (c.name.length > 22 ? c.name.slice(0, 21) + "…" : c.name)}
                    </text>
                    <text x={BOX_W - 8} y={13} fontSize={10} textAnchor="end" fill={colors.muted}>
                      {c.dataType.length > 14 ? c.dataType.slice(0, 13) + "…" : c.dataType}
                    </text>
                  </g>
                ))}
                {b.cols.length > MAX_ROWS && (
                  <text x={10} y={HEAD_H + MAX_ROWS * ROW_H + 15} fontSize={10} fill={colors.muted}>
                    … {b.cols.length - MAX_ROWS} more columns
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="border-t border-line bg-panel-2 px-3 py-1 text-[11px] text-muted">
        Drag tables to arrange · double-click a table to add its related tables · drag background to pan · scroll to zoom · 🔑 primary key · ↗ foreign key
      </div>
    </div>
  );
}
