mod logger;
mod models;
mod platform;

use logger::{AppLogger, fmt_log, fmt_log_simple};
use models::*;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};

pub struct AppState {
    pub config: Mutex<AppConfig>,
    // 日志改为 mpsc 通道 + 后台线程写盘：日志失败/阻塞绝不会影响熄屏主流程
    pub off_log: mpsc::Sender<String>,
    pub debug_log: mpsc::Sender<String>,
    // 当前待执行/进行中的倒计时参数（弹窗池窗口的运行时状态）。
    // 用于事件可能错过时的兜底拉取，避免"弹窗不显示倒计时"。
    pub pending_countdown: Mutex<Option<serde_json::Value>>,
    // 倒计时序号（单调递增）：每次新建倒计时自增，使旧的计时线程在醒来时能识别
    // "已非当前倒计时"而放弃触发熄屏，避免取消/重设后旧定时器误触发。
    pub countdown_seq: Mutex<u64>,
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
fn save_config(state: tauri::State<AppState>, cfg: AppConfig) -> Result<(), String> {
    models::save_config(&cfg)?;
    *state.config.lock().unwrap() = cfg;
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

/// 将熄屏触发类型映射为中文，用于 screenoff 日志记录
fn reason_cn(trigger: &str) -> &str {
    match trigger {
        "manual" => "手动",
        "timer" => "定时",
        "loop" => "循环",
        other => other,
    }
}

#[tauri::command]
fn trigger_screenoff(state: tauri::State<AppState>, lock: bool, trigger: String) -> Result<(), String> {
    // 先执行熄屏（已用 SendMessageTimeoutW 防止广播被挂起窗口阻塞）；
    // 日志改为异步发送，绝不因写盘失败而阻塞或 panic 主流程。
    platform::screen_off(lock)?;
    let ts = chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    // off.log 记录中文原因
    let _ = state.off_log.send(serde_json::json!({"time":ts,"trigger":trigger.clone(),"reason":reason_cn(&trigger),"lock":lock}).to_string());
    let _ = state
        .debug_log
        .send(fmt_log("INFO", "screenoff", &format!("screen off triggered by {}", trigger)));
    Ok(())
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

#[tauri::command]
fn clear_logs() -> Result<(), String> {
    models::clear_logs()
}

#[tauri::command]
fn reset_all(state: tauri::State<AppState>) -> Result<(), String> {
    let cfg = AppConfig::new();
    models::save_config(&cfg)?;
    *state.config.lock().unwrap() = cfg;
    models::clear_logs()
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
            // 左键点击：直接弹出程序界面；右键由菜单处理
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                ..
            } = event
            {
                if let Some(w) = tray.app_handle().get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}

/// 预创建（或获取已有的）隐藏倒计时弹窗池窗口。
/// 窗口加载 countdown.html，默认隐藏。show 时通过事件接收运行时参数。
fn ensure_countdown_pool(app: &tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window("countdown-pool").is_some() {
        return Ok(()); // 已存在
    }
    let _ = tauri::webview::WebviewWindowBuilder::new(
        app,
        "countdown-pool",
        tauri::WebviewUrl::App("countdown.html".into()),
    )
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

    // 获取或创建弹窗池
    ensure_countdown_pool(&app)?;

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
#[tauri::command]
fn get_countdown_state(state: tauri::State<AppState>) -> Option<serde_json::Value> {
    state.pending_countdown.lock().unwrap().clone()
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
        // 404 表示仓库暂无“最新发布”（可能只有草稿/标签，未正式发布）
        return Err(format!(
            "GitHub 返回 {}，可能仓库尚未发布 Release",
            resp.status()
        ));
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
    // 日志通道（行业规范命名：sleeptimer = 主日志, screenoff = 熄屏事件日志）
    let off_tx = spawn_logger(log_dir.clone(), "screenoff");
    let debug_tx = spawn_logger(log_dir.clone(), "sleeptimer");
    let state = AppState {
        config: Mutex::new(config),
        off_log: off_tx,
        debug_log: debug_tx,
        pending_countdown: Mutex::new(None),
        countdown_seq: Mutex::new(0),
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
            trigger_screenoff,
            set_autostart,
            pick_folder,
            read_logs,
            clear_logs,
            reset_all,
            create_countdown_window,
            cancel_countdown,
            get_countdown_state,
            close_countdown_windows,
            check_update,
            open_url
        ])
        .setup(|app| {
            // startup record（异步发送，绝不阻塞启动）
            {
                let _ = app
                    .state::<AppState>()
                    .debug_log
                    .send(fmt_log("INFO", "app", &format!("application started, version={}", models::build_version())));
            }
            build_tray(app)?;
            // ★ 预创建倒计时弹窗池（隐藏窗口），消除每次新建窗口的 WebView2 启动延迟（~1s空白）。
            //   窗口加载轻量 countdown.html，首次显示时通过 Tauri 事件接收运行时参数（含当前主题），
            //   实现"弹出即显示完整内容、主题与主程序同步"。
            if let Err(e) = ensure_countdown_pool(&app.app_handle()) {
                let _ = app.state::<AppState>().debug_log.send(fmt_log(
                    "WARN",
                    "countdown",
                    &format!("倒计时弹窗池预创建失败（将按需降级新建）: {}", e),
                ));
            }
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
                    api.prevent_close();
                    if let Some(w) = app_handle.get_webview_window("main") {
                        let _ = w.hide();
                    }
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
