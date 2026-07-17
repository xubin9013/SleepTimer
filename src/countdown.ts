import { currentMonitor } from "@tauri-apps/api/window";
import { api } from "./api";

let active: { cancel: () => void } | null = null;

export interface CountdownOptions {
  lock?: boolean;
  trigger?: string;
  onFinished?: () => void | Promise<void>;
}

/**
 * 显示倒计时弹窗（复用预创建的隐藏 WebviewWindow "countdown-pool"）。
 *
 * 调用链路：
 *   1. 本函数计算位置、调用 Rust create_countdown_window 命令
 *   2. Rust 定位已有弹窗池窗口 → emit cd:show 事件（传运行时参数含当前主题）→ show + focus
 *   3. countdown-page.ts 收到事件 → 设置 data-theme、重置定时器、开始倒计时
 *   4. 归零时 invoke trigger_screenoff 并隐藏窗口；取消时直接隐藏
 */
export async function showCountdown(
  seconds: number,
  opts: CountdownOptions = {}
): Promise<{ cancel: () => void }> {
  api
    .logDebug(
      `[countdown] showCountdown 入参: seconds=${seconds} lock=${!!opts.lock} trigger=${opts.trigger || "manual"} onFinished=${!!opts.onFinished}`
    )
    .catch(() => {});

  // 取消上一个
  if (active) {
    api.logDebug("[countdown] 取消上一个倒计时实例").catch(() => {});
    active.cancel();
    active = null;
  }

  try {
    const pos = await getCountdownPosition();
    api
      .logDebug(
        `[countdown] 调用 Rust create_countdown_window: seconds=${seconds} lock=${!!opts.lock} trigger=${opts.trigger || "manual"} pos=(${pos.x},${pos.y})`
      )
      .catch(() => {});

    // ★ 核心调用：Rust 复用弹窗池窗口，通过事件传递运行时参数
    await api.createCountdownWindow(seconds, !!opts.lock, opts.trigger || "manual", pos.x, pos.y);

    api.logDebug("[countdown] create_countdown_window 返回成功").catch(() => {});

  // 保存取消回调（用于外部取消 / Esc 键）
  const cancel = () => {
    api.logInfo("[countdown] cancel() 被调用 — 隐藏倒计时弹窗").catch(() => {});
    // ★ 隐藏弹窗池（不关闭，便于复用），并清除 Rust 端待执行状态
    api.cancelCountdown().catch(() => {});
    active = null;
  };
    active = { cancel };
    return active;
  } catch (e) {
    const msg = String((e as any)?.message || e);
    api
      .logError(`[countdown] 异常: ${msg}\n${(e as any)?.stack || ""}`)
      .catch(() => {});
    // 兜底：直接执行熄屏
    try {
      await opts.onFinished?.();
    } catch {}
    return { cancel: () => {} };
  }
}

/** 计算倒计时弹窗位置（桌面右下角，避开任务栏）。 */
async function getCountdownPosition(): Promise<{ x: number; y: number }> {
  try {
    const mon = await currentMonitor();
    if (mon && mon.workArea) {
      const sf = mon.scaleFactor || 1;
      const wa = mon.workArea;
      return {
        x: Math.round(wa.position.x / sf + wa.size.width / sf - 300 - 8),
        y: Math.round(wa.position.y / sf + wa.size.height / sf - 96 - 8),
      };
    }
  } catch (e) {
    api.logWarn(`[countdown] 获取显示器信息失败: ${String(e)}，使用兜底坐标`).catch(() => {});
  }
  return { x: 1612, y: 932 };
}

export async function cancelCountdown() {
  if (active) {
    active.cancel();
    active = null;
  }
}

export function isCountdownActive(): boolean {
  return active != null;
}
