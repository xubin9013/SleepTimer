// 通知浮窗编排器：计算桌面右上角位置，调用 Rust create_notify_window 命令，
// 弹出火绒风格桌面通知（图标 + 标题 + 多行内容 + 关闭按钮 + 自动消失）。
// 通用接口，供启动提示、定时完成提示、更新提示等任意场景调用。

import { currentMonitor } from "@tauri-apps/api/window";
import { api } from "./api";

export interface NotifyOptions {
  title: string;
  lines?: string[];
  /** 类型决定图标与配色：info | success | update | warn */
  kind?: "info" | "success" | "update" | "warn";
  /** 自动消失时长(ms)；0 表示常驻，需手动关闭。默认 5000。 */
  duration?: number;
}

/** 弹出一张桌面通知浮窗。失败仅记日志，不影响主流程。 */
export async function showNotify(opts: NotifyOptions): Promise<void> {
  const title = opts.title || "SleepTimer";
  const lines = opts.lines || [];
  const kind = opts.kind || "info";
  const duration = typeof opts.duration === "number" ? opts.duration : 5000;
  const pos = await getNotifyPosition();
  try {
    await api.createNotifyWindow(title, lines, kind, duration, pos.x, pos.y);
  } catch (e) {
    api.logWarn(`[notify] showNotify 失败: ${String((e as any)?.message || e)}`).catch(() => {});
  }
}

/** 计算右上角位置（避开任务栏），与窗口尺寸 360x190 一致。 */
async function getNotifyPosition(): Promise<{ x: number; y: number }> {
  const W = 360;
  const H = 190;
  try {
    const mon = await currentMonitor();
    if (mon && mon.workArea) {
      const sf = mon.scaleFactor || 1;
      const wa = mon.workArea;
      return {
        x: Math.round(wa.position.x / sf + wa.size.width / sf - W - 12),
        y: Math.round(wa.position.y / sf + 12),
      };
    }
  } catch {
    // 兜底
  }
  return { x: 1600, y: 12 };
}
