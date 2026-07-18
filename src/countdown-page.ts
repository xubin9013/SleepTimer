// 倒计时弹窗独立页面脚本（由预创建的隐藏 WebviewWindow "countdown-pool" 加载）
// 通过 Tauri 事件（cd:show）接收运行时参数（含当前主题），实现弹出即显示、主题同步。
// 取消/归零时隐藏窗口（不关闭）以便下次复用——彻底消除 WebView2 启动延迟。
//
// 关键健壮性设计（修复"弹窗不显示倒计时 / 无法取消"）：
//   - 使用官方 @tauri-apps/api（与主窗口一致），不再依赖易失效的 window.__TAURI__ 全局对象。
//   - 页面加载后除了监听 cd:show 事件，还会主动 invoke get_countdown_state 拉取当前待执行参数。
//     即使 cd:show 事件因"隐藏窗口首次显示时脚本尚未就绪"而错过，也能通过状态拉取兜底启动倒计时。
//   - 取消/归零均调用 Rust cancel_countdown 命令隐藏窗口（而非关闭），保证弹窗池可复用。

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

interface CdParams {
  seconds: number;
  lock: boolean;
  trigger: string;
  theme: string;
}

// DOM 引用
const rootEl = document.getElementById("cd-root");
const titleEl = document.getElementById("cd-title");
const numEl = document.getElementById("cd-num");
const barEl = document.getElementById("cd-bar") as HTMLElement | null;

// 状态
let left = 0;
let total = 0;
let lock = false;
let trigger = "";
let timerId = 0; // setInterval 返回值
let running = false; // 是否已启动，避免重复触发
let ended = false;   // 是否已取消/结束（用于拦截兜底轮询重复启动显示）

function render() {
  if (numEl) numEl.textContent = String(Math.max(0, left));
  if (barEl) {
    barEl.style.width = total > 0 ? (Math.max(0, left) / total) * 100 + "%" : "0%";
  }
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
  if (barEl) barEl.style.width = "0%";
}

/** 本地倒计时归零：仅收起 UI，不触发熄屏。
 *  ★ 熄屏由 Rust 端计时线程权威触发（见 create_countdown_window）。
 *    此处绝不可调用 cancel_countdown 清空 pending，否则会在 Rust 归零前抢清状态，
 *    导致 Rust 计时线程校验失败而跳过熄屏。真正的熄屏与 pending 清理由 Rust 归零时统一完成。 */
async function finish() {
  if (!running) return;
  running = false;
  ended = true;
  clearInterval(timerId);
  timerId = 0;
  await hideSelf();
}

/** 用户取消（点击/ESC） */
async function cancel() {
  if (!running && left === 0 && ended) {
    // 已经结束，仅确保收起
    await hideSelf();
    return;
  }
  running = false;
  ended = true;
  clearInterval(timerId);
  timerId = 0;
  await hideSelf();
  // 清空 Rust 端 pending；Rust 计时线程醒来时会因 pending 为 None 而放弃熄屏
  invoke("cancel_countdown").catch(() => {});
}

/** 启动一次倒计时（由 cd:show 事件或状态拉取兜底调用） */
function start(p: CdParams) {
  const seconds = Math.max(1, p.seconds || 5);
  lock = !!p.lock;
  trigger = p.trigger || "manual";
  left = seconds;
  total = seconds;

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
  ended = false;
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

// ★ 核心：监听 Rust 端 cd:show 事件，接收运行时参数并启动倒计时（复用路径）
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
listen("cd:finished", () => {
  cancel();
}).catch(() => {});

// ★ 兜底轮询：弹窗可见时每 150ms 主动拉取待执行倒计时。
// 持久池窗口只加载一次，cd:show 理论上总能收到；但即便某次事件被错过，
// 轮询也能保证倒计时一定会启动（仅在可见时轮询，隐藏时不空耗 IPC）。
window.setInterval(async () => {
  if (running || ended) return;
  let visible = true;
  try {
    visible = await getCurrentWindow().isVisible();
  } catch {
    visible = true;
  }
  if (!visible) return;
  invoke("get_countdown_state")
    .then((state: any) => {
      if (state && typeof state.seconds === "number") {
        start(state as CdParams);
      }
    })
    .catch(() => {});
}, 150);
