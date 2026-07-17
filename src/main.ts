import { getCurrentWindow } from "@tauri-apps/api/window";
import { store, loadConfig, saveConfig, getCurrentPlan, getEffectivePlanName } from "./store";
import { el, svgIcon, closeModal, modalOpen, toast } from "./ui";
import { showCountdown, cancelCountdown, isCountdownActive } from "./countdown";
import { installDiagnostics } from "./diag";
import { renderPlans } from "./modules/plans";
import { renderSettings } from "./modules/settings";
import { renderLogs } from "./modules/logs";
import { api } from "./api";

let current: "plans" | "settings" | "logs" = "plans";
let content!: HTMLElement;
let pill!: HTMLElement;
let themeBtn!: HTMLElement;
let appRoot!: HTMLElement;
let versionEl!: HTMLElement;
let navItems: { mod: string; el: HTMLElement }[] = [];

function buildShell() {
  appRoot = document.getElementById("app")!;
  appRoot.innerHTML = "";

  // title bar
  const appIcon = el("img", {
    class: "app-icon",
    src: "/icon.png",
    alt: "SleepTimer",
    style: "width:24px;height:24px;border-radius:6px;object-fit:contain;display:block",
  });
  const name = el("span", { class: "app-name", text: "SleepTimer" });
  const version = el("span", { class: "app-version", text: store.cfg.version });
  versionEl = version;
  const left = el("div", { class: "drag", style: "display:flex;align-items:center;gap:8px", "data-tauri-drag-region": "" }, appIcon, name, version);
  const spacer = el("div", { class: "drag", "data-tauri-drag-region": "" });

  pill = el("div", { class: "pill" });
  pill.addEventListener("click", () => setModule("settings"));

  themeBtn = el("button", { class: "icon-btn", title: "切换主题", onclick: toggleTheme });
  const offBtn = el("button", { class: "btn-off", onclick: oneClickOff }, svgIcon("power"), "一键熄屏");
  const minBtn = el("button", { class: "icon-btn", title: "最小化", html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>' });
  const closeBtn = el("button", { class: "icon-btn", title: "关闭", html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>' });

  const right = el("div", { style: "display:flex;align-items:center;gap:8px" }, pill, themeBtn, offBtn, minBtn, closeBtn);

  const titlebar = el("div", { class: "titlebar" }, left, spacer, right);

  // sidebar
  const sidebar = el("div", { class: "sidebar" });
  const defs = [
    { mod: "plans", icon: "grid", label: "方案管理" },
    { mod: "settings", icon: "settings", label: "设置" },
    { mod: "logs", icon: "file-text", label: "熄屏日志" },
  ];
  navItems = [];
  for (const d of defs) {
    const item = el(
      "button",
      { class: "nav-item" },
      el("span", { html: svgIcon(d.icon).outerHTML }),
      el("span", { class: "label", text: d.label })
    );
    item.addEventListener("click", () => setModule(d.mod as any));
    navItems.push({ mod: d.mod, el: item });
    sidebar.append(item);
  }
  const collapseBtn = el("button", { class: "icon-btn collapse-btn", html: svgIcon("panel-left").outerHTML, title: "折叠/展开" });
  collapseBtn.addEventListener("click", () => {
    store.cfg.settings.sidebar_collapsed = !store.cfg.settings.sidebar_collapsed;
    saveConfig();
    applyCollapsed();
  });
  sidebar.append(collapseBtn);

  content = el("div", { class: "content" });
  appRoot.append(titlebar, sidebar, content);
  applyCollapsed();

  const win = getCurrentWindow();
  minBtn.addEventListener("click", () => win.minimize());
  closeBtn.addEventListener("click", () => win.close());

  document.addEventListener("keydown", onKey);
}

function applyCollapsed() {
  appRoot.classList.toggle("sidebar-collapsed", store.cfg.settings.sidebar_collapsed);
}

function setModule(m: "plans" | "settings" | "logs") {
  current = m;
  store.currentModule = m;
  render();
}

function render() {
  navItems.forEach((n) => n.el.classList.toggle("active", n.mod === current));
  applyCollapsed();
  content.innerHTML = "";
  if (current === "plans") renderPlans(content, render);
  else if (current === "settings") renderSettings(content, render);
  else renderLogs(content, render);
  updatePill();
  updateThemeBtn();
}

function updatePill() {
  const planName = getEffectivePlanName();
  const plan = planName ? store.cfg.plans.find((p) => p.name === planName) : null;
  if (!plan) {
    pill.className = "pill none";
    pill.innerHTML = '<span class="dot"></span>暂无执行方案';
  } else {
    pill.className = "pill";
    pill.innerHTML = `<span class="dot"></span>当前执行：${plan.name}`;
  }
}

function updateThemeBtn() {
  themeBtn.innerHTML = svgIcon(store.cfg.settings.theme === "dark" ? "sun" : "moon").outerHTML;
}

function toggleTheme() {
  const newTheme = store.cfg.settings.theme === "dark" ? "light" : "dark";
  store.cfg.settings.theme = newTheme;
  saveConfig();
  updateThemeBtn();
  // 即时切换：直接修改 data-theme，所有元素在同一绘制帧内更新颜色，
  // 消除 CSS transition + GPU 合成层异步重绘导致的"部分元素滞后"问题。
  document.documentElement.setAttribute("data-theme", newTheme);
}

async function oneClickOff() {
  const s = store.cfg.settings;
  api.logInfo(`[ui] 一键熄屏触发 lock=${s.lock_on_off} countdown_enabled=${s.countdown_enabled} countdown_seconds=${s.countdown_seconds}`).catch(() => {});
  const doOff = async () => {
    try {
      api.logDebug("[ui] 执行 triggerScreenoff 调用").catch(() => {});
      await api.triggerScreenoff(s.lock_on_off, "manual");
      api.logInfo("[ui] triggerScreenoff 成功返回").catch(() => {});
    } catch (e) {
      const errMsg = String(e);
      api.logError(`[ui] triggerScreenoff 失败: ${errMsg}`).catch(() => {});
      toast("熄屏失败：" + errMsg, "error");
    }
  };
  if (s.countdown_enabled) {
    api.logDebug(`[ui] 倒计时已启用，调用 showCountdown(${s.countdown_seconds})`).catch(() => {});
    showCountdown(s.countdown_seconds, { lock: s.lock_on_off, trigger: "manual", onFinished: doOff });
  } else {
    api.logDebug("[ui] 倒计时未启用，直接执行熄屏").catch(() => {});
    doOff();
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    if (isCountdownActive()) {
      cancelCountdown();
      return;
    }
    if (modalOpen()) {
      closeModal();
      return;
    }
  }
}

/** 计算当前时间到目标 "HH:MM:SS" 的剩余秒数（跨日顺延至次日），无效返回 -1 */
function secondsToTarget(t: string, now: Date): number {
  const parts = t.split(":").map(Number);
  if (parts.length !== 3) return -1;
  const [h, m, s] = parts;
  const target = new Date(now);
  target.setHours(h, m, s, 0);
  let diff = Math.floor((target.getTime() - now.getTime()) / 1000);
  if (diff < 0) diff += 86400; // 目标时间已过当日，顺延至次日
  return diff;
}

function startScheduler() {
  // 记录已触发的 (方案#目标时间)，避免每秒重复触发
  const fired = new Set<string>();
  window.setInterval(() => {
    const now = new Date();
    const planName = getEffectivePlanName();
    const plan = planName ? store.cfg.plans.find((p) => p.name === planName) : undefined;
    if (!plan) return;
    const s = store.cfg.settings;
    // 提前量：倒计时应在“设定时间前 lead 秒”弹出；若用户晚于该时刻才设置方案，
    // 则立即弹出，倒计时秒数 = 剩余到设定时间的秒数，仍精确在设定时间熄屏。
    const lead = s.countdown_enabled ? Math.min(300, Math.max(1, s.countdown_seconds)) : 0;

    for (const t of plan.times) {
      const remaining = secondsToTarget(t, now);
      if (remaining < 0) continue;
      // 仅在“已进入提前窗口（remaining <= lead）”时触发，且只触发一次
      if (remaining > lead) continue;
      const key = `${planName}#${t}`;
      if (fired.has(key)) continue;
      fired.add(key);
      const cd = Math.max(1, remaining); // 实际倒计时秒数（晚设方案时 < lead）
      api
        .logInfo(
          `[scheduler] 触发倒计时 方案=${planName} 目标=${t} 提前量=${lead}s 实际倒计时=${cd}s (剩余=${remaining}s)`
        )
        .catch(() => {});
      const doOff = async () => {
        try {
          api.logInfo("[scheduler] 倒计时结束，执行 triggerScreenoff(timer)").catch(() => {});
          await api.triggerScreenoff(s.lock_on_off, "timer");
          api.logDebug("[scheduler] triggerScreenoff(timer) 成功").catch(() => {});
        } catch (e) {
          api.logError(`[scheduler] triggerScreenoff(timer) 失败: ${String(e)}`).catch(() => {});
        }
      };
      // 在设定时间前 lead 秒（或更早，若方案设置较晚）弹出倒计时，倒计时结束（即设定时间）执行熄屏
      if (s.countdown_enabled) {
        api.logDebug(`[scheduler] 调用 showCountdown(${cd}, {trigger:"timer"})`).catch(() => {});
        showCountdown(cd, { lock: s.lock_on_off, trigger: "timer", onFinished: doOff });
      } else {
        api.logDebug("[scheduler] 倒计时未启用，直接执行熄屏").catch(() => {});
        doOff();
      }
    }
    if (fired.size > 500) fired.clear();
  }, 1000);
}

async function init() {
  // 倒计时弹窗已独立为 countdown.html（轻量页面，不加载主程序包），
  // 主窗口只负责加载主界面。
  api.logDebug("[app] JS bundle 开始执行").catch(() => {});
  await buildMainApp();
}

/** 构建主程序界面（仅主窗口调用）。 */
async function buildMainApp() {
  await loadConfig();
  // 拉取编译时构建日期，动态显示版本号（构建当天，非固定）
  const info = await api.getAppInfo().catch(() => null);
  const verStr = info?.version ?? store.cfg.version;
  (window as any).__APP_VERSION__ = verStr;
  installDiagnostics();
  buildShell();
  if (info) versionEl.textContent = verStr;
  render();
  startScheduler();

  // ★ 隐藏全局右键菜单
  document.addEventListener("contextmenu", (e) => e.preventDefault());

  api.logDebug("[app] 前端已加载，主界面就绪");
}


init();
