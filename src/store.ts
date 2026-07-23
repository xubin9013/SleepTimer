import { api, type AppConfig, type Plan } from "./api";

const defaults: AppConfig = {
  version: "V1.0.20260723",
  plans: [],
  fixed_plan: null,
  view_plan: null,
  loop_cfg: { enabled: false, granularity: "day", interval: 1, start: "", order: [] },
  settings: {
    theme: "light",
    autostart: true,
    minimize_to_tray: true,
    lock_on_off: false,
    countdown_enabled: true,
    countdown_seconds: 5,
    config_path: "",
    sidebar_collapsed: false,
  },
};

let cfg: AppConfig = JSON.parse(JSON.stringify(defaults));
type Module = "plans" | "settings" | "logs";
let currentModule: Module = "plans";

export const store = {
  get cfg() {
    return cfg;
  },
  set cfg(c: AppConfig) {
    cfg = c;
  },
  get currentModule() {
    return currentModule;
  },
  set currentModule(m: Module) {
    currentModule = m;
  },
};

export function applyTheme() {
  document.documentElement.setAttribute(
    "data-theme",
    cfg.settings.theme === "dark" ? "dark" : "light"
  );
}

export async function loadConfig() {
  cfg = await api.getConfig();
  applyTheme();
}

export async function saveConfig() {
  await api.saveConfig(cfg);
  await api.logInfo("[config] 配置已保存");
}

export function getPlan(name: string): Plan | undefined {
  return cfg.plans.find((p) => p.name === name);
}

export function getFixedPlan(): Plan | undefined {
  if (cfg.fixed_plan == null) return undefined;
  return cfg.plans.find((p) => p.name === cfg.fixed_plan);
}

export function sortTimes(times: string[]): string[] {
  return [...times].sort();
}

/** Recompute which plan is "current" given loop order + start date. */
export function computeLoopCurrent(): string | null {
  const lc = cfg.loop_cfg;
  if (!lc.enabled || lc.order.length === 0) return cfg.fixed_plan;
  // Calculate which plan is currently active based on elapsed intervals from start date
  const now = new Date();
  const startY = lc.start ? parseInt(lc.start.split("-")[0], 10) : now.getFullYear();
  if (isNaN(startY)) return lc.order[0] ?? cfg.fixed_plan;

  let elapsedIntervals: number;
  if (lc.granularity === "month") {
    // Month granularity: count total months from start to now
    const startM = lc.start && lc.start.split("-")[1] ? parseInt(lc.start.split("-")[1], 10) - 1 : 0;
    const totalStartMonths = (startY - 1) * 12 + startM;
    const totalNowMonths = (now.getFullYear() - 1) * 12 + now.getMonth();
    elapsedIntervals = Math.floor((totalNowMonths - totalStartMonths) / Math.max(lc.interval, 1));
  } else {
    // Day granularity: count days from start to now
    let sd = 1, sm = 0, sy = startY;
    if (lc.start && lc.start.includes("-")) {
      const parts = lc.start.split("-");
      sy = parseInt(parts[0], 10);
      sm = parseInt(parts[1], 10) - 1;
      sd = parseInt(parts[2], 10);
    }
    const startDate = new Date(sy, sm, sd);
    const diffMs = now.getTime() - startDate.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    elapsedIntervals = Math.floor(diffDays / Math.max(lc.interval, 1));
  }

  // Handle negative (start date in future) — treat as index 0
  const idx = ((elapsedIntervals % lc.order.length) + lc.order.length) % lc.order.length;
  return lc.order[idx] ?? cfg.fixed_plan;
}

/** Get the currently effective plan name for display / execution */
export function getEffectivePlanName(): string | null {
  const lc = cfg.loop_cfg;
  if (lc.enabled) return computeLoopCurrent();
  return cfg.fixed_plan;
}
