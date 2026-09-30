// 通知浮窗独立页面脚本（由预创建的隐藏 WebviewWindow "notify-pool" 加载）
// 通过 Tauri 事件（notify:show）接收运行时参数（标题/多行内容/类型/主题/时长），
// 渲染为火绒风格桌面通知浮卡；关闭即隐藏窗口（不关闭）以便复用。
// 仅依赖官方 @tauri-apps/api，不加载主程序包，首帧即显示。

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

interface NotifyParams {
  title: string;
  lines: string[];
  kind: string;
  theme: string;
  duration: number;
  id?: number;
}

// 各类型内联 SVG 图标（currentColor 跟随 .nt-icon 颜色）
const ICONS: Record<string, string> = {
  info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none"/></svg>`,
  success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>`,
  update: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/></svg>`,
  warn: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 16H3z"/><line x1="12" y1="9" x2="12" y2="14"/><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/></svg>`,
};

const iconEl = document.getElementById("nt-icon") as HTMLElement;
const titleEl = document.getElementById("nt-title") as HTMLElement;
const linesEl = document.getElementById("nt-lines") as HTMLElement;
const closeEl = document.getElementById("nt-close") as HTMLElement;

let shownSeq = -1; // 当前已显示的通知序号（幂等键）
let autoTimer = 0; // 自动消失定时器

function applyTheme(theme: string) {
  const t = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", t);
}

/** 隐藏当前窗口（供关闭/自动消失时调用，不关闭以便复用） */
function hideSelf() {
  invoke("cancel_notify").catch(() => {});
}

function render(p: NotifyParams) {
  // ★ 弹出时应用主题：notify:show / 轮询兜底返回的 theme 已由 Rust 端保证为「当前实时主题」
  //   （get_notify_state 返回前用 state.config 的实时值覆盖），不会再覆盖用户刚切换的主题。
  applyTheme(p.theme || "dark");
  const kind = p.kind || "info";
  iconEl.className = "nt-icon " + kind;
  iconEl.innerHTML = ICONS[kind] || ICONS.info;
  titleEl.textContent = p.title || "SleepTimer";
  linesEl.innerHTML = "";
  (p.lines || []).forEach((ln) => {
    const d = document.createElement("div");
    d.className = "nt-line";
    d.textContent = ln;
    linesEl.append(d);
  });

  // 自动消失（duration=0 表示常驻，需手动关闭）
  clearTimeout(autoTimer);
  const dur = p.duration || 0;
  if (dur > 0) {
    autoTimer = window.setTimeout(() => hideSelf(), dur);
  }
}

// 关闭按钮：立即隐藏
closeEl.addEventListener("click", () => hideSelf());

// ★ 主题实时同步：主程序切换主题时广播 theme:changed，通知浮窗立即跟随（消除切换滞后）。
listen("theme:changed", (event: any) => {
  const t = event?.payload?.theme;
  if (t) applyTheme(t);
}).catch(() => {});

// ★ 启动时主动拉取一次当前主题：通知池窗口预创建并隐藏，避免亮色主题下首次弹出闪暗色。
invoke("get_config")
  .then((cfg: any) => {
    if (cfg?.settings?.theme) applyTheme(cfg.settings.theme);
  })
  .catch(() => {});

// ★ 核心：监听 Rust 端 notify:show 事件，接收运行时参数并渲染。
listen("notify:show", (event: any) => {
  const p = (event.payload || {}) as NotifyParams;
  shownSeq = typeof p.id === "number" ? p.id : -1;
  render(p);
}).catch(() => {});

// ★ 兜底轮询（可靠引擎）：窗口可见时每 200ms 主动拉取当前待执行通知。
//   若事件因窗口首次显示脚本未就绪而错过，也能经轮询兜底显示/更新。
//
//   ★ 主题同步：无论 id 是否变化，每次都无条件用返回的实时 theme 调 applyTheme。
//     get_notify_state 在 Rust 端已用 state.config 的实时主题覆盖 pending 里的旧值，
//     轮询持续把最新主题应用到通知浮窗，消除「显示中切主题不跟随」。
window.setInterval(async () => {
  let visible = true;
  try {
    visible = await getCurrentWindow().isVisible();
  } catch {
    visible = true;
  }
  if (!visible) return;
  invoke("get_notify_state")
    .then((state: any) => {
      if (!state || typeof state.id !== "number") return;
      // ★ 无条件同步主题（实时值）
      if (typeof state.theme === "string") applyTheme(state.theme);
      if (state.id !== shownSeq) {
        shownSeq = state.id;
        render(state as NotifyParams);
      }
    })
    .catch(() => {});
}, 200);
