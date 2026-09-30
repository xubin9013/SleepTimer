// 后端定时调度器（治本修复：不再依赖前端隐藏 WebView 的 setInterval，
// 因此不受 WebView2/Chromium 后台定时器节流影响）。
//
// 设计要点：
// - 在 Rust 原生线程里每秒（对齐到整秒）读取配置、计算当前执行方案的最近目标时刻；
// - 当剩余时间进入「提前量 lead」窗口时，直接调用 start_countdown（或倒计时关闭时直接 screen_off），
//   与前端手动「一键熄屏」走同一套权威熄屏逻辑；
// - 用 scheduler_fired 集合按「方案#时间」去重，避免一天内重复触发；跨天自动清空。

use crate::logger::fmt_log;
use crate::models::*;
use crate::AppState;
use crate::start_countdown;
use std::thread;
use std::time::Duration;
use chrono::{Datelike, Local, TimeZone, Timelike};
use tauri::Manager;

/// 计算当前时间到目标 "HH:MM:SS" 的剩余秒数（跨日顺延至次日），无效返回 -1。
/// 与前端历史 secondsToTarget 保持语义一致。
fn seconds_to_target(t: &str, now: chrono::DateTime<Local>) -> i64 {
    let parts: Vec<i64> = t.split(':').filter_map(|p| p.parse::<i64>().ok()).collect();
    if parts.len() != 3 {
        return -1;
    }
    let (h, m, s) = (parts[0], parts[1], parts[2]);
    let target = now
        .with_hour(h as u32)
        .and_then(|d| d.with_minute(m as u32))
        .and_then(|d| d.with_second(s as u32))
        .and_then(|d| d.with_nanosecond(0));
    let target = match target {
        Some(t) => t,
        None => return -1,
    };
    let diff = (target - now).num_seconds();
    if diff < 0 {
        diff + 86400
    } else {
        diff
    }
}

/// 复刻前端 computeLoopCurrent + getEffectivePlanName：返回当前应执行的方案名。
fn effective_plan_name(cfg: &AppConfig) -> Option<String> {
    let lc = &cfg.loop_cfg;
    if lc.enabled && !lc.order.is_empty() {
        return Some(compute_loop_current(cfg));
    }
    cfg.fixed_plan.clone()
}

fn compute_loop_current(cfg: &AppConfig) -> String {
    let lc = &cfg.loop_cfg;
    if !lc.enabled || lc.order.is_empty() {
        return cfg.fixed_plan.clone().unwrap_or_default();
    }
    let now = Local::now();
    let start_y = lc
        .start
        .get(0..4)
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or_else(|| now.year());
    let elapsed_intervals: i64 = if lc.granularity == "month" {
        let start_m = lc
            .start
            .get(5..7)
            .and_then(|s| s.parse::<i32>().ok())
            .map(|m| m - 1)
            .unwrap_or(0);
        let total_start = (start_y - 1) * 12 + start_m;
        let total_now = (now.year() - 1) * 12 + now.month0() as i32;
        (total_now - total_start) as i64 / (lc.interval as i64).max(1)
    } else {
        let (sy, sm, sd) = if lc.start.contains('-') {
            let p: Vec<&str> = lc.start.split('-').collect();
            let y = p.first().and_then(|x| x.parse::<i32>().ok()).unwrap_or(start_y);
            let m = p.get(1)
                .and_then(|x| x.parse::<i32>().ok())
                .map(|m| m - 1)
                .unwrap_or(0);
            let d = p.get(2).and_then(|x| x.parse::<i32>().ok()).unwrap_or(1);
            (y, m, d)
        } else {
            (start_y, 0, 1)
        };
        let start_date = chrono::Local
            .with_ymd_and_hms(sy, (sm + 1) as u32, sd as u32, 0, 0, 0)
            .single();
        match start_date {
            Some(sd) => (now - sd).num_days() / (lc.interval as i64).max(1),
            None => 0,
        }
    };
    let order_len = lc.order.len() as i64;
    if order_len == 0 {
        return cfg.fixed_plan.clone().unwrap_or_default();
    }
    let idx = ((elapsed_intervals % order_len) + order_len) % order_len;
    lc.order
        .get(idx as usize)
        .cloned()
        .unwrap_or_else(|| cfg.fixed_plan.clone().unwrap_or_default())
}

/// 计算倒计时弹窗的右下角位置（主显示器工作区右下，留 8px 边距）。
#[cfg(windows)]
fn bottom_right_position() -> (i32, i32) {
    use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTOPRIMARY};
    unsafe {
        let hmon = MonitorFromWindow(0, MONITOR_DEFAULTTOPRIMARY);
        if hmon != 0 {
            let mut mi: MONITORINFO = std::mem::zeroed();
            mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            if GetMonitorInfoW(hmon, &mut mi) != 0 {
                let wa = mi.rcWork;
                let x = wa.right - 300 - 8;
                let y = wa.bottom - 96 - 8;
                return (x, y);
            }
        }
    }
    (1612, 932)
}

#[cfg(not(windows))]
fn bottom_right_position() -> (i32, i32) {
    (1612, 932)
}

/// 单次调度检查。
fn tick(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let cfg = {
        let guard = state.config.lock().unwrap();
        guard.clone()
    };

    // 跨天重置去重集合
    let today = Local::now().format("%Y-%m-%d").to_string();
    {
        let mut day = state.scheduler_day.lock().unwrap();
        if *day != today {
            *day = today.clone();
            state.scheduler_fired.lock().unwrap().clear();
        }
    }

    let plan_name = match effective_plan_name(&cfg) {
        Some(p) if !p.is_empty() => p,
        _ => return,
    };
    let plan = match cfg.plans.iter().find(|p| p.name == plan_name) {
        Some(p) => p,
        None => return,
    };
    if plan.times.is_empty() {
        return;
    }

    let now = Local::now();
    // 倒计时弹窗策略：提前提示时间 ≥1 才弹窗（上限 10 秒）；
    // 0 秒 → 不弹窗，到达目标时刻直接熄屏（已取消独立 countdown_enabled 开关）。
    let cs = cfg.settings.countdown_seconds as i64;
    let use_popup = cs >= 1;
    let lead = if use_popup { cs.min(10) } else { 0 };

    let (x, y) = bottom_right_position();
    let lock = cfg.settings.lock_on_off;

    for t in &plan.times {
        let remaining = seconds_to_target(t, now);
        if remaining < 0 {
            continue;
        }
        if remaining > lead {
            continue;
        }
        let key = format!("{}#{}", plan_name, t);
        {
            let mut fired = state.scheduler_fired.lock().unwrap();
            if fired.contains(&key) {
                continue;
            }
            fired.insert(key.clone());
        }
        let cd = remaining.max(1) as u32;
        let _ = state.debug_log.send(fmt_log(
            "INFO",
            "scheduler",
            &format!(
                "Rust 调度触发 方案={} 目标={} 提前量={}s 实际倒计时={}s 弹窗={}",
                plan_name,
                t,
                lead,
                cd,
                use_popup
            ),
        ));
        if use_popup {
            let st = app.state::<AppState>();
            if let Err(e) = start_countdown(app.clone(), st, cd, lock, "timer".to_string(), x as f64, y as f64) {
                let _ = state.debug_log.send(fmt_log(
                    "WARN",
                    "scheduler",
                    &format!("start_countdown 失败（兜底直接熄屏）: {}", e),
                ));
                crate::fire_screen_off(app.state::<AppState>(), lock, "timer");
            }
        } else {
            crate::fire_screen_off(app.state::<AppState>(), lock, "timer");
        }
    }
}

/// 启动后端调度线程（在 setup 中调用一次）。
pub fn start_scheduler(app: tauri::AppHandle) {
    let _ = app.state::<AppState>().debug_log.send(fmt_log(
        "INFO",
        "scheduler",
        "后端定时调度线程已启动（不受前端 WebView 节流影响）",
    ));
    thread::spawn(move || loop {
        tick(&app);
        // 对齐到下一整秒，保证触发精度
        let micros = Local::now().timestamp_subsec_micros();
        let delay = Duration::from_micros((1_000_000 - micros as u64) as u64);
        thread::sleep(delay);
    });
}
