// 倒计时弹窗独立页面脚本（由预创建的隐藏 WebviewWindow "countdown-pool" 加载）
// 通过 Tauri 事件（cd:show）接收运行时参数（含当前主题），实现弹出即显示、主题同步。
// 取消/归零时隐藏窗口（不关闭）以便下次复用——彻底消除 WebView2 启动延迟。
//
// 关键健壮性设计（修复"弹窗不显示倒计时 / 无法取消 / 第二次起不显示"）：
//   - 使用官方 @tauri-apps/api（与主窗口一致），不再依赖易失效的 window.__TAURI__ 全局对象。
//   - 以 Rust 端 pending 的递增序号 id 为"幂等键"：无论 cd:show 事件是否送达，
//     只要弹窗可见且 pending.id 与当前已显示的序号不同，就（重新）启动倒计时。
//     ★ 不再用 ended 标记门控兜底轮询——这正是"第一次有、第二次起没有"的根因。
//   - 取消/归零均调用 Rust cancel_countdown 命令隐藏窗口（而非关闭），保证弹窗池可复用。
//   - 熄屏由 Rust 端计时线程权威触发（见 create_countdown_window），本页绝不自行熄屏。

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

interface CdParams {
  seconds: number;
  lock: boolean;
  trigger: string;
  theme: string;
  id?: number; // Rust 端递增序号，用作幂等键
}

// DOM 引用
const rootEl = document.getElementById("cd-root");
const titleEl = document.getElementById("cd-title");
const numEl = document.getElementById("cd-num");
const barEl = document.getElementById("cd-bar") as HTMLElement | null;
// ★ 可见的进度填充是 #cd-bar 内部的 <i>，必须设置它的宽度才能真正动起来
const barFillEl = (barEl ? barEl.querySelector("i") : null) as HTMLElement | null;

// 状态
let left = 0;
let total = 0;
let lock = false;
let trigger = "";
let timerId = 0; // setInterval 返回值
let running = false; // 是否已启动，避免重复触发
let shownSeq = -1; // 当前已显示/正在运行的 pending 序号（幂等键）；-1 表示空闲

function render() {
  if (numEl) numEl.textContent = String(Math.max(0, left));
  const pct = total > 0 ? (Math.max(0, left) / total) * 100 : 0;
  if (barFillEl) barFillEl.style.width = pct + "%";
}

/** 应用主题：同步主程序当前主题 */
function applyTheme(theme: string) {
  const t = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", t);
}

/** 隐藏当前窗口（供取消/归零时调用，不关闭以便复用） */
async function hideSelf() {
  try {
    await getCurrentWindow().hide();
  } catch {
    // 兜底：通过 Rust 命令隐藏（兼容性兜底）
    invoke("cancel_countdown").catch(() => {});
  }
  // 清空调度显示，避免下次弹出时先闪现上一次残留的半截数字
  if (numEl) numEl.textContent = "";
  if (barFillEl) barFillEl.style.width = "0%";
}

/** 本地倒计时归零：仅收起 UI，不触发熄屏。
 *  ★ 熄屏由 Rust 端计时线程权威触发（见 create_countdown_window）。
 *    此处绝不可调用 cancel_countdown 清空 pending，否则会在 Rust 归零前抢清状态，
 *    导致 Rust 计时线程校验失败而跳过熄屏。真正的熄屏与 pending 清理由 Rust 归零时统一完成。 */
async function finish() {
  if (!running) return;
  running = false;
  shownSeq = -1; // ★ 释放幂等键，允许下一次倒计时经轮询重新启动
  clearInterval(timerId);
  timerId = 0;
  await hideSelf();
}

/** 用户取消（点击/ESC） */
async function cancel() {
  if (!running && left === 0 && shownSeq < 0) {
    // 已经结束，仅确保收起
    await hideSelf();
    return;
  }
  running = false;
  shownSeq = -1;
  clearInterval(timerId);
  timerId = 0;
  await hideSelf();
  // 清空 Rust 端 pending；Rust 计时线程醒来时会因 pending 为 None 而放弃熄屏
  invoke("cancel_countdown").catch(() => {});
}

/** 启动一次倒计时（由 cd:show 事件或状态拉取兜底调用）。
 *  以 pending.id 为幂等键：同一序号已运行时直接跳过，避免重复启动。 */
function start(p: CdParams) {
  const id = typeof p.id === "number" ? p.id : -1;
  if (running && id === shownSeq) return; // 已在运行同一序号，跳过

  const seconds = Math.max(1, p.seconds || 5);
  lock = !!p.lock;
  trigger = p.trigger || "manual";
  left = seconds;
  total = seconds;
  shownSeq = id;

  applyTheme(p.theme || "dark");

  const reasons: Record<string, string> = {
    manual: "即将手动熄屏",
    timer: "即将定时熄屏",
    loop: "即将循环熄屏",
  };
  if (titleEl) {
    titleEl.textContent = (reasons[trigger] || "即将熄屏") + " · 点击取消";
  }

  clearInterval(timerId);
  running = true;
  // ★ 进度条从满格开始：先关过渡瞬间铺满，再恢复平滑过渡，避免起点回弹动画
  if (barFillEl) {
    barFillEl.style.transition = "none";
    barFillEl.style.width = "100%";
    // 强制重排后再开启过渡
    void barFillEl.offsetWidth;
    barFillEl.style.transition = "width 1s linear";
  }
  render();
  timerId = window.setInterval(() => {
    left -= 1;
    if (left <= 0) {
      render();
      finish();
    } else {
      render();
    }
  }, 1000);
}

// 点击取消
if (rootEl) rootEl.addEventListener("click", () => { cancel(); });
// ESC 取消
document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") cancel();
});

// ★ 核心：监听 Rust 端 cd:show 事件，接收运行时参数并启动倒计时（复用路径）。
//   cd:show 可能漏达，但 start() 内的幂等键 + 下方轮询保证最终一定会启动。
listen("cd:show", (event: any) => {
  const p = (event.payload || {}) as CdParams;
  start(p);
}).catch(() => {});

// ★ 全局 ESC 兜底取消：Rust 端低级键盘钩子捕获的 ESC 会发此事件，
//   即使弹窗处于非聚焦状态也能取消，解决"失去焦点后 ESC 失效"的问题。
listen("cd:cancel", () => {
  cancel();
}).catch(() => {});

// ★ Rust 端计时线程归零触发熄屏后发出此事件，通知弹窗页收尾隐藏。
//   （弹窗本地定时器归零也会自行收起，此处为 Rust 权威路径的兜底收尾。）
//   仅收尾、释放幂等键；不要再 cancel_countdown（Rust 已清 pending）。
listen("cd:finished", () => {
  running = false;
  shownSeq = -1;
  clearInterval(timerId);
  timerId = 0;
  hideSelf().catch(() => {});
}).catch(() => {});

// ★ 兜底轮询（可靠引擎）：弹窗可见时每 150ms 主动拉取当前 pending。
//   不以 ended 门控——只要 pending.id 与当前 shownSeq 不同，就启动新的倒计时。
//   这是修复"第一次有、第二次起没有"的关键：之前轮询被 ended 门控，
//   第一轮结束后 ended 恒为 true，第二轮再也无法经轮询兜底启动。
window.setInterval(async () => {
  let visible = true;
  try {
    visible = await getCurrentWindow().isVisible();
  } catch {
    visible = true;
  }
  if (!visible) return;
  invoke("get_countdown_state")
    .then((state: any) => {
      if (!state || typeof state.seconds !== "number") return;
      const id = typeof state.id === "number" ? state.id : -1;
      if (id !== shownSeq) {
        start(state as CdParams);
      }
    })
    .catch(() => {});
}, 150);
