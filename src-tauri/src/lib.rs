mod logger;
mod models;
mod platform;
mod scheduler;

use logger::{AppLogger, fmt_log, fmt_log_simple};
use models::*;
use std::path::PathBuf;
use std::collections::HashSet;
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};
use tokio::io::AsyncWriteExt;
use futures_util::StreamExt;

pub struct AppState {
    pub config: Mutex<AppConfig>,
    // 日志改为 mpsc 通道 + 后台线程写盘：日志失败/阻塞绝不会影响熄屏主流程
    pub off_log: mpsc::Sender<String>,
    pub debug_log: mpsc::Sender<String>,
    // 用户操作审计日志（operation.log，行业规范：审计与诊断分离，审计记录长期保留）
    pub op_log: mpsc::Sender<String>,
    // 当前待执行/进行中的倒计时参数（弹窗池窗口的运行时状态）。
    // 用于事件可能错过时的兜底拉取，避免"弹窗不显示倒计时"。
    pub pending_countdown: Mutex<Option<serde_json::Value>>,
    // 倒计时序号（单调递增）：每次新建倒计时自增，使旧的计时线程在醒来时能识别
    // "已非当前倒计时"而放弃触发熄屏，避免取消/重设后旧定时器误触发。
    pub countdown_seq: Mutex<u64>,
    // 通知浮窗待执行状态（供事件可能错过时兜底拉取，避免"通知不显示"）。
    pub pending_notify: Mutex<Option<serde_json::Value>>,
    // 通知序号（单调递增）：每次新建通知自增，供弹窗页幂等/覆盖判断。
    pub notify_seq: Mutex<u64>,
    // 后端定时调度去重集合（按「方案#时间」），跨天清空。
    pub scheduler_fired: Mutex<HashSet<String>>,
    // 后端调度去重集合所对应的日期（用于跨天重置）。
    pub scheduler_day: Mutex<String>,
}

/// 启动一个后台线程专责写日志（行业规范格式：日期文件名 + 级别 + 组件标签）。
/// 日志写入全部在后台线程进行，命令调用方仅做一次无阻塞的 send。
fn spawn_logger(dir: PathBuf, base: &str) -> mpsc::Sender<String> {
    let (tx, rx) = mpsc::channel::<String>();
    let base = base.to_string();
    thread::spawn(move || {
        let mut logger = AppLogger::new(dir, &base);
        for line in rx {
            logger.write_line(&line);
        }
    });
    tx
}

#[tauri::command]
fn get_config(state: tauri::State<AppState>) -> AppConfig {
    state.config.lock().unwrap().clone()
}

/// 返回程序版本与构建日期。
/// 版本号在运行时按当前日期生成（V1.0.YYYYMMDD），与 app.json 中的 version 完全一致。
#[tauri::command]
fn get_app_info() -> serde_json::Value {
    let today = chrono::Local::now().format("%Y%m%d").to_string();
    serde_json::json!({
        "version": models::build_version(),
        "build_date": today,
    })
}

#[tauri::command]
fn save_config(app: tauri::AppHandle, state: tauri::State<AppState>, cfg: AppConfig) -> Result<(), String> {
    // ★ 主题变化时广播 theme:changed：倒计时/通知弹窗池常驻复用，切主题后需实时跟随。
    //   后端权威广播，覆盖「弹窗正显示时切主题」等前端 emit 可能漏达的场景。
    let theme_changed = {
        let prev = state.config.lock().unwrap().settings.theme.clone();
        prev != cfg.settings.theme
    };
    models::save_config(&cfg)?;
    *state.config.lock().unwrap() = cfg;
    if theme_changed {
        let theme = {
            let t = state.config.lock().unwrap().settings.theme.clone();
            if t == "light" { "light" } else { "dark" }
        };
        let _ = app.emit("theme:changed", serde_json::json!({ "theme": theme }));
    }
    Ok(())
}

#[tauri::command]
fn set_config_path(state: tauri::State<AppState>, path: String) -> Result<(), String> {
    let mut cfg = state.config.lock().unwrap().clone();
    cfg.settings.config_path = path;
    models::save_config(&cfg)?;
    *state.config.lock().unwrap() = cfg;
    Ok(())
}

#[tauri::command]
fn log(state: tauri::State<AppState>, level: String, message: String) {
    let _ = state.debug_log.send(fmt_log_simple(&level, &message));
}

/// 记录一条用户操作审计日志（operation.log，行业规范：action + detail 结构化）。
/// 操作日志与运行日志分离——运行日志 5MB 自动滚动丢弃，操作日志长期保留用于审计。
#[tauri::command]
fn log_operation(state: tauri::State<AppState>, action: String, detail: String) -> Result<(), String> {
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let line = serde_json::json!({ "time": ts, "action": action, "detail": detail }).to_string();
    let _ = state.op_log.send(line);
    // 同时在运行日志留一条 INFO 便于串联诊断（非必须，但利于排查）
    let _ = state
        .debug_log
        .send(fmt_log("INFO", "op", &format!("{} | {}", action, detail)));
    Ok(())
}

/// 将熄屏触发类型映射为中文，用于 screenoff 日志记录
pub(crate) fn reason_cn(trigger: &str) -> &str {
    match trigger {
        "manual" => "手动",
        "timer" => "定时",
        "loop" => "循环",
        other => other,
    }
}

#[tauri::command]
fn trigger_screenoff(state: tauri::State<AppState>, lock: bool, trigger: String) -> Result<(), String> {
    fire_screen_off(state, lock, &trigger);
    Ok(())
}

/// 执行熄屏（与 trigger_screenoff 命令同逻辑）：先 screen_off，再异步写 off.log / debug.log。
/// 供命令与后端定时调度器复用。
pub(crate) fn fire_screen_off(state: tauri::State<AppState>, lock: bool, trigger: &str) {
    // 先执行熄屏（已用 SendMessageTimeoutW 防止广播被挂起窗口阻塞）；
    // 日志改为异步发送，绝不因写盘失败而阻塞或 panic 主流程。
    let _ = platform::screen_off(lock);
    let ts = chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    // off.log 记录中文原因
    let _ = state.off_log.send(serde_json::json!({"time":ts,"trigger":trigger,"reason":reason_cn(trigger),"lock":lock}).to_string());
    let _ = state
        .debug_log
        .send(fmt_log("INFO", "screenoff", &format!("screen off triggered by {}", trigger)));
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), String> {
    platform::set_autostart(enabled)
}

#[tauri::command]
fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    platform::pick_folder(&app)
}

#[tauri::command]
fn read_logs() -> Vec<serde_json::Value> {
    models::read_logs()
}

/// 运行日志（sleeptimer.log，含级别/组件/消息），时间倒序。
#[tauri::command]
fn read_run_logs() -> Vec<serde_json::Value> {
    models::read_run_logs()
}

/// 用户操作审计日志（operation.log），时间倒序。
#[tauri::command]
fn read_op_logs() -> Vec<serde_json::Value> {
    models::read_op_logs()
}

#[tauri::command]
fn clear_logs(kind: String) -> Result<(), String> {
    models::clear_logs(&kind)
}

#[tauri::command]
fn reset_all(state: tauri::State<AppState>) -> Result<(), String> {
    let cfg = AppConfig::new();
    models::save_config(&cfg)?;
    *state.config.lock().unwrap() = cfg;
    // 重置时清空全部三类日志
    let _ = models::clear_logs("screenoff");
    let _ = models::clear_logs("operation");
    models::clear_logs("sleeptimer")
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quit])?;
    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(false) // 菜单仅右键显示
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击/双击（不限按下/抬起状态）：弹出并聚焦主窗口。
            // 兼容不同 Windows 版本下事件派发差异（Click 仅 Down / Down+Up / DoubleClick），
            // 重复 show 无副作用；每次点击写入运行日志，便于用户反馈时排查。
            let show_main = |app: &tauri::AppHandle| {
                if let Some(w) = app.get_webview_window("main") {
                    // 关键：主窗口被 hide() 后，部分 WebView2 环境 show() 偶发不生效。
                    // 用「临时置顶 + 恢复」强制把窗口拉到最前，确保点击图标一定弹出可见窗口。
                    let _ = w.set_always_on_top(true);
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                    // 短暂延迟后取消置顶，避免影响用户后续操作
                    let app2 = app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(300));
                        if let Some(w2) = app2.get_webview_window("main") {
                            let _ = w2.set_always_on_top(false);
                        }
                    });
                    let _ = app
                        .state::<AppState>()
                        .debug_log
                        .send(fmt_log("INFO", "tray", "托盘/任务栏图标点击 → 显示主窗口"));
                } else {
                    // 主窗口已被销毁（minimize_to_tray=false 时关闭会真销毁）→ 无法恢复
                    let _ = app
                        .state::<AppState>()
                        .debug_log
                        .send(fmt_log("WARN", "tray", "主窗口不存在（已被销毁），无法弹出"));
                }
            };
            match event {
                // ★ 只响应"抬起"：Windows 托盘单击会派发 Down + Up 两次 Click 事件，
                //   不区分状态会重复记录日志/重复 show（2026-09-30 运行日志实测）。
                tauri::tray::TrayIconEvent::Click {
                    button: tauri::tray::MouseButton::Left,
                    button_state: tauri::tray::MouseButtonState::Up,
                    ..
                }
                | tauri::tray::TrayIconEvent::DoubleClick {
                    button: tauri::tray::MouseButton::Left,
                    ..
                } => show_main(tray.app_handle()),
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}

/// 预创建（或获取已有的）隐藏倒计时弹窗池窗口。
/// 窗口加载 countdown.html，默认隐藏。show 时通过事件接收运行时参数。
/// ★ theme：注入 initialization_script，在页面加载最早期设置 <html data-theme>，
///   彻底消除「第一次弹出先闪默认暗色」的时序闪烁（不依赖事件/轮询兜底）。
fn ensure_countdown_pool(app: &tauri::AppHandle, theme: &str) -> Result<(), String> {
    if app.get_webview_window("countdown-pool").is_some() {
        return Ok(()); // 已存在
    }
    let init = format!(
        "document.documentElement.setAttribute('data-theme', '{}');",
        theme
    );
    let _ = tauri::webview::WebviewWindowBuilder::new(
        app,
        "countdown-pool",
        tauri::WebviewUrl::App("countdown.html".into()),
    )
    .initialization_script(&init)
    .title("SleepTimer Countdown")
    .inner_size(300.0, 96.0)
    .decorations(false)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    .visible(false) // ★ 隐藏：首次 show 前不显示
    .build()
    .map_err(|e| format!("{}", e))?;
    Ok(())
}

#[tauri::command]
fn create_countdown_window(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    seconds: u32,
    lock: bool,
    trigger: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    start_countdown(app, state, seconds, lock, trigger, x, y)
}

/// 复用弹窗池窗口启动一次倒计时（权威熄屏逻辑在后台线程）。
/// 供「一键熄屏」命令与后端定时调度器复用。
pub(crate) fn start_countdown(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    seconds: u32,
    lock: bool,
    trigger: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    // 读取主程序当前主题，使倒计时弹窗与主程序主题一致
    let theme = {
        let cfg = state.config.lock().unwrap();
        cfg.settings.theme.clone()
    };
    let theme = if theme == "light" { "light" } else { "dark" };

    let params = serde_json::json!({
        "seconds": seconds,
        "lock": lock,
        "trigger": trigger,
        "theme": theme
    });

    let _ = state.debug_log.send(fmt_log(
        "INFO",
        "countdown",
        &format!(
            "复用弹窗池 seconds={} lock={} trigger={} theme={} pos=({},{})",
            seconds, lock, trigger, theme, x, y
        ),
    ));

    // 保存待执行参数到状态（供弹窗页面就绪后兜底拉取，避免事件错过导致不显示倒计时）
    // ★ 每次新建倒计时递增序号，写入参数，使旧的计时线程醒来时能识别"已非当前倒计时"。
    let seq = {
        let mut s = state.countdown_seq.lock().unwrap();
        *s += 1;
        *s
    };
    let mut params = params;
    params["id"] = serde_json::json!(seq);
    *state.pending_countdown.lock().unwrap() = Some(params.clone());

    // 获取或创建弹窗池（注入当前主题，页面加载最早期即设置 data-theme）
    ensure_countdown_pool(&app, theme)?;

    // ★ show 之前先广播当前主题：弹窗池窗口常驻复用，DOM 上残留上一次的 data-theme。
    //   若先 show 再发事件，会先闪现上一次的旧主题（先旧后新）。这里 show 前同步，
    //   使窗口一显示即正确主题；即便事件先于页面脚本就绪而漏达，弹窗页启动时也会
    //   主动 get_config 拉取当前主题兜底。
    let _ = app.emit("theme:changed", serde_json::json!({ "theme": theme }));

    // 先定位、显示、聚焦弹窗；再 emit 事件。
    // 顺序很关键：隐藏窗口在首次显示前可能尚未执行页面脚本，
    // 先 show 让脚本有机会注册监听，再 emit 可最大化事件被捕获的概率；
    // 即便仍错过，页面就绪后会通过 get_countdown_state 兜底启动。
    if let Some(win) = app.get_webview_window("countdown-pool") {
        let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: x as i32, y: y as i32 }));
        let _ = win.show();
        let _ = win.set_focus();
        let _ = state.debug_log.send(fmt_log("INFO", "countdown", "弹窗池已定位+显示+聚焦"));
    }

    app.emit("cd:show", &params).map_err(|e| format!("emit failed: {}", e))?;

    // ★ 倒计时归零触发熄屏的权威逻辑放在 Rust 端（后台线程），而非前端弹窗定时器。
    //   原因：全局 ESC 钩子在取消时会先隐藏弹窗窗口，导致 cd:cancel 事件可能来不及送达
    //   已隐藏的 WebView，前端定时器的归零回调仍会触发 trigger_screenoff（"弹窗消失但熄屏照常"）。
    //   改为 Rust 计时：归零时先校验 pending_countdown 是否仍为本次倒计时（且 seq 一致），
    //   仅在未被取消时才调用 screen_off；ESC 钩子清掉 pending 后，旧线程醒来直接放弃，绝不会误触发。
    {
        let app2 = app.clone();
        let seconds2 = seconds;
        let lock2 = lock;
        let trigger2 = trigger.clone();
        let seq2 = seq;
        thread::spawn(move || {
            thread::sleep(std::time::Duration::from_secs(seconds2 as u64));
            // 醒来后校验：仍待执行且序号一致，才视为"未被取消/重设"
            let valid = {
                let st = app2.state::<AppState>();
                // 先 clone 出值再判断，避免 MutexGuard 借用 State 跨语句导致生命周期报错
                let p = st.pending_countdown.lock().unwrap().clone();
                match p.as_ref() {
                    Some(v) => v.get("id").and_then(|x| x.as_u64()) == Some(seq2),
                    None => false,
                }
            };
            if !valid {
                return; // 已被取消或已被新倒计时取代 → 不触发熄屏
            }
            // ★ 真正熄屏（与 trigger_screenoff 命令同逻辑），在后台线程直接调用 platform::screen_off
            let off_tx = app2.state::<AppState>().off_log.clone();
            let dbg_tx = app2.state::<AppState>().debug_log.clone();
            let _ = platform::screen_off(lock2);
            let ts = chrono::Local::now()
                .format("%Y-%m-%d %H:%M:%S")
                .to_string();
            let _ = off_tx.send(
                serde_json::json!({"time":ts,"trigger":trigger2.clone(),"reason":reason_cn(&trigger2),"lock":lock2})
                    .to_string(),
            );
            let _ = dbg_tx.send(fmt_log("INFO", "screenoff", &format!("screen off triggered by {}", trigger2)));
            // 清状态 + 隐藏弹窗 + 通知弹窗页收尾
            *app2.state::<AppState>().pending_countdown.lock().unwrap() = None;
            if let Some(win) = app2.get_webview_window("countdown-pool") {
                let _ = win.hide();
            }
            let _ = app2.emit("cd:finished", &serde_json::json!({}));
        });
    }

    Ok(())
}

/// 取消当前倒计时：清除待执行状态并隐藏（不关闭）弹窗池窗口，便于下次复用。
#[tauri::command]
fn cancel_countdown(app: tauri::AppHandle, state: tauri::State<AppState>) {
    *state.pending_countdown.lock().unwrap() = None;
    if let Some(win) = app.get_webview_window("countdown-pool") {
        let _ = win.hide();
    }
}

/// 返回当前待执行的倒计时参数（供弹窗页面兜底拉取）。无则返回 null。
/// ★ 返回前用「当前实时主题」覆盖 pending 里固化在倒计时启动时的 theme：
///   弹窗页轮询兜底每 150ms 调用本命令，若 theme 仍是旧值，会在显示期间反复
///   用旧主题覆盖用户刚切换的新主题。这里保证轮询拿到的 theme 永远是最新的。
#[tauri::command]
fn get_countdown_state(state: tauri::State<AppState>) -> Option<serde_json::Value> {
    let mut v = state.pending_countdown.lock().unwrap().clone()?;
    let theme = {
        let t = state.config.lock().unwrap().settings.theme.clone();
        if t == "light" { "light" } else { "dark" }
    };
    if let serde_json::Value::Object(ref mut m) = v {
        m.insert("theme".to_string(), serde_json::json!(theme));
    }
    Some(v)
}

/// 关闭所有倒计时子窗口（label 以 "countdown-" 开头），用于取消/退出时清理
#[tauri::command]
fn close_countdown_windows(app: tauri::AppHandle, state: tauri::State<AppState>) {
    let windows = app.webview_windows();
    let mut closed = 0;
    for (label, win) in windows {
        if label.starts_with("countdown-") {
            let _ = win.close();
            closed += 1;
        }
    }
    if closed > 0 {
        let _ = state.debug_log.send(fmt_log("INFO", "countdown", &format!("已关闭 {} 个倒计时窗口", closed)));
    }
}

/// 预创建（或获取已有的）隐藏通知弹窗池窗口。
/// 窗口加载 notify.html，默认隐藏、透明背景（卡片外区域透明，仅浮卡可见）。
/// show 时通过事件接收运行时参数（标题/多行内容/类型/主题/时长）。
/// ★ theme：注入 initialization_script，在页面加载最早期设置 <html data-theme>，
///   消除「第一次弹出先闪默认暗色」的时序闪烁。
fn ensure_notify_pool(app: &tauri::AppHandle, theme: &str) -> Result<(), String> {
    if app.get_webview_window("notify-pool").is_some() {
        return Ok(()); // 已存在
    }
    let init = format!(
        "document.documentElement.setAttribute('data-theme', '{}');",
        theme
    );
    let _ = tauri::webview::WebviewWindowBuilder::new(
        app,
        "notify-pool",
        tauri::WebviewUrl::App("notify.html".into()),
    )
    .initialization_script(&init)
    .title("SleepTimer Notify")
    .inner_size(360.0, 190.0)
    .decorations(false)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    .transparent(true) // ★ 透明：浮卡外区域透明，仅圆角卡片 + 阴影可见
    .visible(false) // ★ 隐藏：首次 show 前不显示
    .build()
    .map_err(|e| format!("{}", e))?;
    Ok(())
}

/// 显示一张火绒风格桌面通知浮窗（复用预创建的隐藏 notify-pool 窗口）。
/// 参数：标题、多行内容、类型(info/success/update/warn)、自动消失时长(ms,0=常驻)、位置。
#[tauri::command]
fn create_notify_window(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    title: String,
    lines: Vec<String>,
    kind: String,
    duration_ms: u64,
    x: f64,
    y: f64,
) -> Result<(), String> {
    // 读取主程序当前主题，使通知浮窗与主程序主题一致
    let theme = {
        let cfg = state.config.lock().unwrap();
        let t = cfg.settings.theme.clone();
        if t == "light" { "light" } else { "dark" }
    };

    // 序号自增，写入参数，供弹窗页面幂等/覆盖判断（事件错过时兜底拉取也能识别最新）
    let seq = {
        let mut s = state.notify_seq.lock().unwrap();
        *s += 1;
        *s
    };
    let params = serde_json::json!({
        "title": title,
        "lines": lines,
        "kind": kind,
        "theme": theme,
        "duration": duration_ms,
        "id": seq
    });
    *state.pending_notify.lock().unwrap() = Some(params.clone());

    let _ = state.debug_log.send(fmt_log(
        "INFO",
        "notify",
        &format!("显示通知 seq={} title={} kind={} duration={} pos=({},{})", seq, title, kind, duration_ms, x, y),
    ));

    ensure_notify_pool(&app, theme)?;

    // ★ show 之前先广播当前主题：通知池窗口常驻复用，避免先闪现上一次旧主题再切换。
    let _ = app.emit("theme:changed", serde_json::json!({ "theme": theme }));

    // 定位并 show（不抢焦点：通知是被动提示，不应打断用户当前操作）
    if let Some(win) = app.get_webview_window("notify-pool") {
        let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: x as i32, y: y as i32 }));
        let _ = win.show();
    }

    app.emit("notify:show", &params).map_err(|e| format!("emit failed: {}", e))?;
    Ok(())
}

/// 取消当前通知：清除待执行状态并隐藏（不关闭）notify-pool 窗口，便于下次复用。
#[tauri::command]
fn cancel_notify(app: tauri::AppHandle, state: tauri::State<AppState>) {
    *state.pending_notify.lock().unwrap() = None;
    if let Some(win) = app.get_webview_window("notify-pool") {
        let _ = win.hide();
    }
}

/// 返回当前待执行的通知参数（供弹窗页面兜底拉取）。无则返回 null。
/// ★ 返回前用「当前实时主题」覆盖 pending 里固化在通知创建时的 theme，
///   保证轮询兜底拿到的 theme 永远最新，不会覆盖用户刚切换的主题。
#[tauri::command]
fn get_notify_state(state: tauri::State<AppState>) -> Option<serde_json::Value> {
    let mut v = state.pending_notify.lock().unwrap().clone()?;
    let theme = {
        let t = state.config.lock().unwrap().settings.theme.clone();
        if t == "light" { "light" } else { "dark" }
    };
    if let serde_json::Value::Object(ref mut m) = v {
        m.insert("theme".to_string(), serde_json::json!(theme));
    }
    Some(v)
}

/// 检测更新：向 GitHub Releases "最新发布" 接口发起只读 GET，返回发布信息。
/// 不下载安装，仅由前端比对版本并引导用户前往发布页。更新源即 GitHub 仓库。
#[tauri::command]
async fn check_update() -> Result<serde_json::Value, String> {
    const API: &str = "https://api.github.com/repos/xubin9013/SleepTimer/releases/latest";
    let client = reqwest::Client::builder()
        .user_agent("SleepTimer")
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| format!("创建请求客户端失败: {}", e))?;
    let resp = client
        .get(API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| {
            // 清理原始错误中的 URL 等冗余信息，避免暴露给用户
            let raw = e.to_string();
            let clean = raw.replace(API, "<GitHub API>").replace("url:", "");
            format!("网络请求失败（请检查网络/代理设置）: {}", clean)
        })?;
    if !resp.status().is_success() {
        // 注意：私有仓库 / 不存在的仓库 / 未发布正式 Release（草稿、预发布）
        // 都会被 GitHub 的 /releases/latest 接口返回 404，而非 401/403。
        // 故 404 不能简单归因为“没发布”，需提示可见性/鉴权问题。
        let hint = if resp.status() == 404 {
            "仓库可能不存在、为私有仓库（需鉴权），或未发布正式 Release（草稿/预发布不会被 /releases/latest 识别）"
        } else {
            "GitHub 返回了异常状态码，可能是限流或服务异常"
        };
        return Err(format!("检查更新失败（HTTP {}）：{}。", resp.status(), hint));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析 GitHub 响应失败: {}", e))?;
    Ok(json)
}

/// 在系统默认浏览器中打开外部链接（用于“前往下载”等），不依赖额外 Tauri 插件。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if url.is_empty() {
        return Err("链接为空".into());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .spawn()
            .map_err(|e| format!("打开链接失败: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开链接失败: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开链接失败: {}", e))?;
    }
    Ok(())
}

/// 自动更新：下载指定安装包到 <安装目录>/update/ 下，随后静默启动安装程序（/S）
/// 覆盖安装，并退出当前进程释放被占用的 exe；由安装包在安装完成后自动重启程序，
/// 并在成功后删除 <安装目录>/update/ 下的下载包，使更新闭环。
/// 下载进度通过 `update:progress` 事件持续推送至前端（{downloaded, total, pct}）。
#[tauri::command]
async fn download_and_install(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use std::process::Stdio;
    // ★ 下载到安装目录下的 update 文件夹（便于安装程序安装完成后清理）。
    //   安装目录 = 当前 exe 所在目录（生产环境即 $INSTDIR）。
    let exe = std::env::current_exe().map_err(|e| format!("获取程序路径失败: {}", e))?;
    let install_dir = exe
        .parent()
        .ok_or_else(|| "无法定位安装目录（exe 无父目录）".to_string())?
        .to_path_buf();
    let update_dir = install_dir.join("update");
    std::fs::create_dir_all(&update_dir).map_err(|e| format!("创建 update 目录失败: {}", e))?;
    let path = update_dir.join("SleepTimer-Setup.exe");

    let client = reqwest::Client::builder()
        .user_agent("SleepTimer")
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("创建下载客户端失败: {}", e))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| {
            let raw = e.to_string();
            let clean = raw.replace(&url, "<下载地址>");
            format!("下载失败（请检查网络/代理）: {}", clean)
        })?;
    if !resp.status().is_success() {
        return Err(format!("下载失败：GitHub 返回 HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut stream = resp.bytes_stream();
    // ★ 关键修复 os error 32：下载文件写入独立作用域，离开作用域即 drop 关闭文件句柄，
    //   避免随后 spawn 同一文件时因共享锁未释放触发 ERROR_SHARING_VIOLATION。
    {
        let mut file = tokio::fs::File::create(&path)
            .await
            .map_err(|e| format!("创建更新文件失败: {}", e))?;
        let mut downloaded: u64 = 0;
        let mut last_pct: i64 = -1;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("读取下载流失败: {}", e))?;
            file.write_all(&chunk).await.map_err(|e| format!("写入文件失败: {}", e))?;
            downloaded += chunk.len() as u64;
            let pct = if total > 0 {
                (downloaded * 100 / total) as i64
            } else {
                -1
            };
            if pct != last_pct {
                last_pct = pct;
                let _ = app.emit(
                    "update:progress",
                    serde_json::json!({ "downloaded": downloaded, "total": total, "pct": pct }),
                );
            }
        }
        file.flush().await.ok();
        file.sync_all().await.ok();
        // 离开作用域 → File drop → 释放文件共享锁
    }
    // 隐藏主窗口，避免安装时界面占用
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
    // ★ 启动静默安装（/S）：安装程序会替换 $INSTDIR\SleepTimer.exe。
    //   spawn 后立刻 exit(0) 释放当前进程占用的 exe，NSIS 即可直接覆盖；
    //   安装程序完成后自动重启程序（见 installer.nsi 的 ${If} ${Silent} Exec）。
    std::process::Command::new(&path)
        .arg("/S")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动安装程序失败: {}", e))?;
    std::process::exit(0);
}

/// 是否以静默模式启动（开机自启场景）。
/// 带 `--silent` / `-silent` 参数时不显示主窗口，仅驻留系统托盘。
fn is_silent_launch() -> bool {
    std::env::args().any(|a| a == "--silent" || a == "-silent")
}

pub fn run() {
    let mut config = models::load_config();
    let log_dir = models::effective_log_dir();
    // 版本对齐：确保 app.json 中的 version 与程序界面显示的版本号一致
    // （界面版本号来自 build.rs 注入的 APP_BUILD_DATE，app.json 旧文件可能留存旧日期）
    let expected_version = models::build_version();
    if config.version != expected_version {
        config.version = expected_version.clone();
        let _ = models::save_config(&config);
    }
    // 日志通道（行业规范命名：sleeptimer = 运行日志, screenoff = 熄屏事件日志, operation = 用户操作审计日志）
    let off_tx = spawn_logger(log_dir.clone(), "screenoff");
    let debug_tx = spawn_logger(log_dir.clone(), "sleeptimer");
    let op_tx = spawn_logger(log_dir.clone(), "operation");
    let state = AppState {
        config: Mutex::new(config),
        off_log: off_tx,
        debug_log: debug_tx,
        op_log: op_tx,
        pending_countdown: Mutex::new(None),
        countdown_seq: Mutex::new(0),
        pending_notify: Mutex::new(None),
        notify_seq: Mutex::new(0),
        scheduler_fired: Mutex::new(std::collections::HashSet::new()),
        scheduler_day: Mutex::new(String::new()),
    };

    let app = tauri::Builder::default()
        .menu(|handle| Ok(Menu::with_items(handle, &[])?)) // ★ 空菜单：隐藏默认菜单栏
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // ★ 仅当新实例非静默（如用户双击启动）时才弹出主窗口；
            //   若新实例也带 --silent（如再次开机自启），则保持隐藏、不抢焦点。
            let silent = argv.iter().any(|a| a == "--silent" || a == "-silent");
            if !silent {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_config,
            get_app_info,
            save_config,
            set_config_path,
            log,
            log_operation,
            trigger_screenoff,
            set_autostart,
            pick_folder,
            read_logs,
            read_run_logs,
            read_op_logs,
            clear_logs,
            reset_all,
            create_countdown_window,
            cancel_countdown,
            get_countdown_state,
            close_countdown_windows,
            create_notify_window,
            cancel_notify,
            get_notify_state,
            check_update,
            open_url,
            download_and_install
        ])
        .setup(|app| {
            // startup record（异步发送，绝不阻塞启动）
            {
                let _ = app
                    .state::<AppState>()
                    .debug_log
                    .send(fmt_log("INFO", "app", &format!("application started, version={}", models::build_version())));
            }
            // ★ 创建全局命名互斥体，供安装器可靠检测程序是否在运行（替代 tasklist|find，消除误报）
            platform::create_app_mutex();
            build_tray(app)?;
            // ★ 预创建倒计时弹窗池（隐藏窗口），消除每次新建窗口的 WebView2 启动延迟（~1s空白）。
            //   窗口加载轻量 countdown.html，首次显示时通过 Tauri 事件接收运行时参数（含当前主题），
            //   实现"弹出即显示完整内容、主题与主程序同步"。
            //   ★ 预创建时注入当前主题到 initialization_script，页面加载即带正确 data-theme。
            let boot_theme = {
                let t = app.state::<AppState>().config.lock().unwrap().settings.theme.clone();
                if t == "light" { "light".to_string() } else { "dark".to_string() }
            };
            if let Err(e) = ensure_countdown_pool(&app.app_handle(), &boot_theme) {
                let _ = app.state::<AppState>().debug_log.send(fmt_log(
                    "WARN",
                    "countdown",
                    &format!("倒计时弹窗池预创建失败（将按需降级新建）: {}", e),
                ));
            }
            // ★ 预创建通知弹窗池（隐藏窗口），实现火绒风格桌面通知浮窗（启动提示/通用提示）。
            if let Err(e) = ensure_notify_pool(&app.app_handle(), &boot_theme) {
                let _ = app.state::<AppState>().debug_log.send(fmt_log(
                    "WARN",
                    "notify",
                    &format!("通知弹窗池预创建失败（将按需降级新建）: {}", e),
                ));
            }
            // ★ 启动后端定时调度线程（治本修复：不再依赖前端隐藏 WebView 的节流定时器）
            scheduler::start_scheduler(app.app_handle().clone());
            // ★ 安装全局 ESC 钩子：倒计时激活期间，无论弹窗是否聚焦，按 ESC 均可取消。
            //   （弹窗是独立 WebviewWindow，失去焦点后窗口自身的 keydown 收不到 ESC，
            //    故需在 Rust 端用低级键盘钩子全局捕获。）
            global_hotkey::APP_HANDLE.set(app.app_handle().clone()).ok();
            global_hotkey::install();
            // Sync autostart: on fresh install, read registry state set by installer
            // so the app's initial autostart setting matches what user chose during installation
            {
                let mut cfg = app.state::<AppState>().config.lock().unwrap().clone();
                let registry_has_autostart = platform::check_autostart();
                // If installer didn't write registry (user unchecked), but default is true → fix
                if !registry_has_autostart && cfg.settings.autostart {
                    cfg.settings.autostart = false;
                    *app.state::<AppState>().config.lock().unwrap() = cfg.clone();
                    let _ = models::save_config(&cfg);
                }
                // If installer wrote registry (user checked), but for some reason config is false → fix
                if registry_has_autostart && !cfg.settings.autostart {
                    cfg.settings.autostart = true;
                    *app.state::<AppState>().config.lock().unwrap() = cfg.clone();
                    let _ = models::save_config(&cfg);
                }
                // Apply autostart to registry (idempotent) — 始终写入带 --silent 的命令行
                let _ = platform::set_autostart(cfg.settings.autostart);
            }
            // ★ 静默启动：仅当未带 --silent 参数时才显示主窗口；
            //   带 --silent（如开机自启）则仅驻留系统托盘，不显示界面。
            if !is_silent_launch() {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building SleepTimer");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } = event
        {
        if label == "main" {
            // ★ 关闭所有倒计时子窗口（防止孤儿窗口阻塞退出）
            for (clabel, cwin) in app_handle.webview_windows() {
                if clabel.starts_with("countdown-") {
                    let _ = cwin.close();
                }
            }
            let minimize = app_handle
                    .state::<AppState>()
                    .config
                    .lock()
                    .unwrap()
                    .settings
                    .minimize_to_tray;
                if minimize {
                    // 关闭 → 隐藏到托盘（窗口仍存在，托盘图标可恢复）
                    api.prevent_close();
                    if let Some(w) = app_handle.get_webview_window("main") {
                        let _ = w.hide();
                    }
                    let _ = app_handle.state::<AppState>().debug_log.send(fmt_log(
                        "INFO", "app", "关闭主窗口 → 最小化到托盘（窗口隐藏，可点托盘图标恢复）",
                    ));
                } else {
                    // 关闭 → 真正退出（窗口销毁，托盘一并退出，避免残留点不开的僵尸图标）
                    let _ = app_handle.state::<AppState>().debug_log.send(fmt_log(
                        "INFO", "app", "关闭主窗口 → 退出程序（minimize_to_tray=false）",
                    ));
                    app_handle.exit(0);
                }
            }
        }
    });
}

/// 全局 ESC 钩子：倒计时进行中（pending_countdown 存在）时，拦截系统级 ESC，
/// 使「弹窗失去焦点后按 ESC 仍可取消失屏倒计时」。
/// 仅依赖项目已有的 windows-sys（WH_KEYBOARD_LL 低级键盘钩子），无需额外 crate。
mod global_hotkey {
    use super::AppState;
    use crate::fmt_log;
    use once_cell::sync::OnceCell;
    use std::sync::Mutex;
    use tauri::{Emitter, Manager};
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, HHOOK, KBDLLHOOKSTRUCT, SetWindowsHookExW, WH_KEYBOARD_LL, WM_KEYDOWN,
        WM_SYSKEYDOWN,
    };

    // 钩子句柄（仅用于持有，避免被回收）
    static KB_HOOK: Mutex<HHOOK> = Mutex::new(0);
    // 安装钩子的线程（Tauri 主线程）上保存 AppHandle，供回调访问状态/发送事件
    pub static APP_HANDLE: OnceCell<tauri::AppHandle> = OnceCell::new();

    const VK_ESCAPE: u32 = 0x1B;

    unsafe extern "system" fn keyboard_proc(
        code: i32,
        w_param: WPARAM,
        l_param: LPARAM,
    ) -> LRESULT {
        if code >= 0 {
            let msg = w_param as u32;
            if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
                let kb = l_param as *const KBDLLHOOKSTRUCT;
                if (*kb).vkCode == VK_ESCAPE {
                    if let Some(app) = APP_HANDLE.get() {
                        let pending = {
                            let state = app.state::<AppState>();
                            let x = state.pending_countdown.lock().unwrap().clone();
                            x
                        };
                        if pending.is_some() {
                            // 倒计时正在进行 → 取消：清状态 + 隐藏弹窗 + 通知弹窗重置 UI
                            {
                                let state = app.state::<AppState>();
                                *state.pending_countdown.lock().unwrap() = None;
                                if let Some(win) = app.get_webview_window("countdown-pool") {
                                    let _ = win.hide();
                                }
                                let _ = state.debug_log.send(fmt_log(
                                    "INFO",
                                    "countdown",
                                    "全局ESC捕获 → 取消倒计时",
                                ));
                            }
                            let _ = app.emit("cd:cancel", &serde_json::json!({}));
                        }
                    }
                }
            }
        }
        CallNextHookEx(0, code, w_param, l_param)
    }

    /// 安装全局键盘钩子（在主线程消息循环上运行，Tauri 主线程满足此条件）。
    pub fn install() {
        unsafe {
            let hook = SetWindowsHookExW(
                WH_KEYBOARD_LL,
                Some(keyboard_proc),
                0,
                0,
            );
            *KB_HOOK.lock().unwrap() = hook;
        }
    }
}
