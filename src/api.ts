import { invoke } from "@tauri-apps/api/core";

export interface Plan {
  name: string;
  times: string[]; // "HH:MM:SS"
}
export interface LoopConfig {
  enabled: boolean;
  granularity: string; // "day" | "month"
  interval: number;
  start: string; // "YYYY-MM-DD" | "YYYY-MM"
  order: string[]; // plan names
}
export interface Settings {
  theme: string;
  autostart: boolean;
  minimize_to_tray: boolean;
  lock_on_off: boolean;
  countdown_enabled: boolean;
  countdown_seconds: number;
  config_path: string;
  sidebar_collapsed: boolean;
}
export interface AppConfig {
  version: string;
  plans: Plan[];
  current_plan: string | null;
  /** 方案管理页上次查看的方案（与 current_plan 解耦，仅用于恢复选中标签） */
  view_plan?: string | null;
  loop_cfg: LoopConfig;
  settings: Settings;
}

export const api = {
  getConfig: () => invoke<AppConfig>("get_config"),
  getAppInfo: () => invoke<{ version: string; build_date: string }>("get_app_info"),
  saveConfig: (cfg: AppConfig) => invoke("save_config", { cfg }),
  setConfigPath: (path: string) => invoke("set_config_path", { path }),
  /** 规范化日志：level ∈ DEBUG|INFO|WARN|ERROR；message 可自带 [组件] 标签 */
  log: (level: string, message: string) => invoke("log", { level, message }),
  logDebug: (message: string) => invoke("log", { level: "DEBUG", message }),
  logInfo: (message: string) => invoke("log", { level: "INFO", message }),
  logWarn: (message: string) => invoke("log", { level: "WARN", message }),
  logError: (message: string) => invoke("log", { level: "ERROR", message }),
  triggerScreenoff: (lock: boolean, trigger: string) =>
    invoke("trigger_screenoff", { lock, trigger }),
  setAutostart: (enabled: boolean) => invoke("set_autostart", { enabled }),
  pickFolder: () => invoke<string | null>("pick_folder"),
  readLogs: () => invoke<LogRow[]>("read_logs"),
  clearLogs: () => invoke("clear_logs"),
  resetAll: () => invoke("reset_all"),
  /** Rust侧创建倒计时子窗口（最底层方式，通过 initialization_script 注入参数） */
  createCountdownWindow: (seconds: number, lock: boolean, trigger: string, x: number, y: number) =>
    invoke("create_countdown_window", { seconds, lock, trigger, x, y }),
  /** 关闭所有倒计时子窗口（仅用于退出程序时清理） */
  closeCountdownWindows: () => invoke("close_countdown_windows"),
  /** 取消当前倒计时：隐藏弹窗池窗口并清除待执行状态（不销毁窗口，便于复用） */
  cancelCountdown: () => invoke("cancel_countdown"),
  /** 拉取当前待执行的倒计时参数（弹窗页面兜底启动用） */
  getCountdownState: () => invoke<any | null>("get_countdown_state"),
  /** 检测更新：向 GitHub Releases 最新发布接口请求，返回发布信息 JSON */
  checkUpdate: () => invoke<any>("check_update"),
  /** 自动更新：下载安装包到临时目录并静默覆盖安装（Rust 端完成后会退出并重启程序） */
  downloadAndInstall: (url: string) => invoke("download_and_install", { url }),
  /** 在系统默认浏览器打开外部链接（前往下载等） */
  openUrl: (url: string) => invoke("open_url", { url }),
};

export interface LogRow {
  id: number;
  time: string;
  trigger: string; // "manual" | "timer"
}
