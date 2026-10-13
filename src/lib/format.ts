import type { CellValue, ColumnMeta, Dialect } from "./ipc";
import { literal, quoteIdent } from "./sql";

export type CopyFormat = "tsv" | "csv" | "json" | "insert" | "markdown" | "in-list";

const text = (v: CellValue, nullText = "") => (v === null ? nullText : String(v));

function csvCell(v: CellValue, delim: string): string {
  const s = text(v);
  return /["\r\n]/.test(s) || s.includes(delim) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function formatRows(
  fmt: CopyFormat,
  cols: ColumnMeta[],
  rows: CellValue[][],
  opts: { dialect: Dialect; table?: string; header?: boolean },
): string {
  const header = opts.header ?? true;
  switch (fmt) {
    case "tsv":
    case "csv": {
      const d = fmt === "tsv" ? "\t" : ",";
      const lines = rows.map((r) => r.map((v) => csvCell(v, d)).join(d));
      if (header) lines.unshift(cols.map((c) => csvCell(c.name, d)).join(d));
      return lines.join("\n");
    }
    case "json":
      return JSON.stringify(
        rows.map((r) => Object.fromEntries(cols.map((c, i) => [c.name, r[i]]))),
        null,
        2,
      );
    case "insert": {
      const t = opts.table || "table_name";
      const names = cols.map((c) => quoteIdent(opts.dialect, c.name)).join(", ");
      return rows.map((r) => `INSERT INTO ${t} (${names}) VALUES (${r.map((v) => literal(opts.dialect, v)).join(", ")});`).join("\n");
    }
    case "markdown": {
      const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
      const head = `| ${cols.map((c) => esc(c.name)).join(" | ")} |\n|${cols.map((c) => (c.numeric ? " ---: " : " --- ")).join("|")}|`;
      return [head, ...rows.map((r) => `| ${r.map((v) => esc(text(v, "NULL"))).join(" | ")} |`)].join("\n");
    }
    case "in-list":
      return `(${rows.map((r) => literal(opts.dialect, r[0])).join(", ")})`;
  }
}

export function displayValue(v: CellValue): string {
  if (v === null) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  const s = String(v).replace(/\r?\n/g, " ↵ ");
  return s.length > 500 ? s.slice(0, 500) + "…" : s;
}

export function prettyValue(v: CellValue): string {
  if (v === null) return "NULL";
  const s = String(v);
  const t = s.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      /* not JSON */
    }
  }
  return s;
}
