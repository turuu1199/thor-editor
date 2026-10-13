import { useEffect, useState } from "react";

export interface ThemeColors {
  fg: string;
  muted: string;
  panel: string;
  panel2: string;
  line: string;
  hover: string;
  accent: string;
  accentSoft: string;
  editBg: string;
  insertBg: string;
  deleteBg: string;
  dark: boolean;
}

function read(): ThemeColors {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  const dark = document.documentElement.classList.contains("dark");
  return {
    fg: v("--fg"),
    muted: v("--muted"),
    panel: v("--panel"),
    panel2: v("--panel-2"),
    line: v("--line"),
    hover: v("--hover"),
    accent: v("--accent"),
    accentSoft: v("--accent-soft"),
    editBg: dark ? "#4a3b12" : "#fef3c7",
    insertBg: dark ? "#14402a" : "#dcfce7",
    deleteBg: dark ? "#4c1d1d" : "#fee2e2",
    dark,
  };
}

/** Resolved CSS token values (canvas-based widgets such as the grid need concrete colors). */
export function useThemeColors(): ThemeColors {
  const [c, setC] = useState(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setC(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return c;
}

/** Applies light/dark class to <html> following the setting (and the OS when "system"). */
export function useApplyTheme(theme: "light" | "dark" | "system") {
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && mq.matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
}
