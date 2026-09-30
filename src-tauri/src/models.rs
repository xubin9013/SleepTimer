use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Plan {
    pub name: String,
    pub times: Vec<String>, // "HH:MM:SS" sorted ascending
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct LoopConfig {
    pub enabled: bool,
    #[serde(default = "default_granularity")]
    pub granularity: String, // "day" | "month"
    #[serde(default = "default_interval")]
    pub interval: u32,
    #[serde(default)]
    pub start: String, // "YYYY-MM-DD" or "YYYY-MM"
    #[serde(default)]
    pub order: Vec<String>, // plan names in execution order
}

fn default_granularity() -> String {
    "day".to_string()
}
fn default_interval() -> u32 {
    1
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Settings {
    #[serde(default = "default_light")]
    pub theme: String, // "light" | "dark"
    #[serde(default = "default_true")]
    pub autostart: bool,
    #[serde(default = "default_true")]
    pub minimize_to_tray: bool,
    #[serde(default)]
    pub lock_on_off: bool,
    #[serde(default = "default_true")]
    pub countdown_enabled: bool,
    #[serde(default = "default_five")]
    pub countdown_seconds: u32,
    #[serde(default)]
    pub config_path: String, // optional override for config dir
    #[serde(default)]
    pub sidebar_collapsed: bool,
}

fn default_light() -> String {
    "light".to_string()
}
fn default_true() -> bool {
    true
}
fn default_five() -> u32 {
    5
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AppConfig {
    #[serde(default = "default_version")]
    pub version: String,
    #[serde(default)]
    pub plans: Vec<Plan>,
    #[serde(default)]
    pub fixed_plan: Option<String>,
    /// 方案管理页「当前查看的方案」：与 fixed_plan（当前执行方案）解耦，
    /// 仅用于记住用户在方案管理页上次停留在哪个方案标签（胶囊），退出重开后可恢复。
    #[serde(default)]
    pub view_plan: Option<String>,
    #[serde(default)]
    pub loop_cfg: LoopConfig,
    #[serde(default)]
    pub settings: Settings,
}

fn default_version() -> String {
    build_version()
}

// 程序版本号：完整形态为「主版本.次版本.构建日期.当天构建次数」（如 V1.0.20260723.2）。
// 版本号由 build.rs 在编译期生成到 OUT_DIR/generated_version.rs（含构建日期 + 当天构建次数），
// 通过 include!(OUT_DIR) 引入。生成文件放在 OUT_DIR（target 内），避免落在 src 目录里
// 触发 rerun-if-changed 自循环。
// 升版规则（用户要求）：build.rs 会对「真正影响产物的源码」计算内容指纹；只有指纹变化
// （即源码确有修改）时才把当天构建次数 +1。同一份源码多次构建，指纹不变 → 版本号锁定，不升版。
// 不再按运行时日期生成——否则同一天发布新版本后，新 exe 仍按当天日期报版本，
// 永远小于已发布的 tag，导致「更新后依旧提示有新版本」。
// 更新比对时只取「日期级」部分（见 src/main.ts 的 norm 字符串比较，后缀 .N 不影响同天判定）。
// 发布新版本时：递增构建日期（Cargo.toml / tauri.conf.json 的 version 同步保持日期级 tag 一致）。
include!(concat!(env!("OUT_DIR"), "/generated_version.rs"));

pub fn build_version() -> String {
    format!("V{}", APP_BUILD_VERSION)
}

impl AppConfig {
    pub fn new() -> Self {
        AppConfig {
            version: build_version(),
            plans: vec![],
            fixed_plan: None,
            view_plan: None,
            loop_cfg: LoopConfig {
                enabled: false,
                granularity: "day".to_string(),
                interval: 1,
                start: String::new(),
                order: vec![],
            },
            settings: Settings {
                theme: "light".to_string(),
                autostart: true,
                minimize_to_tray: true,
                lock_on_off: false,
                countdown_enabled: true,
                countdown_seconds: 5,
                config_path: String::new(),
                sidebar_collapsed: false,
            },
        }
    }
}

/// Directory of the running executable.
pub fn base_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|x| x.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Config directory: honors the user override, otherwise <exe>/config.
pub fn config_dir(cfg: &AppConfig) -> PathBuf {
    if !cfg.settings.config_path.is_empty() {
        PathBuf::from(&cfg.settings.config_path)
    } else {
        base_dir().join("config")
    }
}

/// Preferred log directory is <exe>/log per spec.
pub fn log_dir() -> PathBuf {
    base_dir().join("log")
}

/// Fallback under LOCALAPPDATA when the install dir is not writable.
fn fallback_dir(sub: &str) -> PathBuf {
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let d = local.join("SleepTimer").join(sub);
    let _ = fs::create_dir_all(&d);
    d
}

/// Resolve the actual config directory: prefer the configured path, fall back
/// to LOCALAPPDATA when it cannot be created (e.g. running as standard user
/// under Program Files).
pub fn effective_config_dir(cfg: &AppConfig) -> PathBuf {
    let pref = config_dir(cfg);
    if fs::create_dir_all(&pref).is_ok() {
        return pref;
    }
    fallback_dir("config")
}

/// Resolve the actual log directory (prefer <exe>/log, fall back to LOCALAPPDATA).
pub fn effective_log_dir() -> PathBuf {
    let pref = log_dir();
    if fs::create_dir_all(&pref).is_ok() {
        return pref;
    }
    fallback_dir("log")
}

/// 候选日志目录：优先 <exe>/log，其次 LOCALAPPDATA 兜底（与 effective_log_dir 一致）。
/// read_logs/clear_logs 需同时扫描两者，否则当日志实际写入兜底目录时界面会读不到。
fn candidate_log_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![log_dir()];
    let fb = fallback_dir("log");
    if fb != log_dir() {
        dirs.push(fb);
    }
    dirs
}

pub fn load_config() -> AppConfig {
    let path = base_dir().join("config").join("app.json");
    if let Ok(s) = fs::read_to_string(&path) {
        if let Ok(c) = serde_json::from_str::<AppConfig>(&s) {
            return c;
        }
    }
    let fb = fallback_dir("config").join("app.json");
    if let Ok(s) = fs::read_to_string(&fb) {
        if let Ok(c) = serde_json::from_str::<AppConfig>(&s) {
            return c;
        }
    }
    AppConfig::new()
}

pub fn save_config(cfg: &AppConfig) -> Result<(), String> {
    let dir = effective_config_dir(cfg);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("app.json");
    let s = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, s).map_err(|e| e.to_string())?;
    Ok(())
}

/// Read all screen-off log entries (active + rotated + legacy files), oldest first.
/// 文件命名：screenoff.log（活跃）/ screenoff.N.log（按大小滚动归档）/ screenoff-YYYY-MM-DD.log（旧日期格式，兼容历史）；每行一条 JSON（JSON Lines）。
pub fn read_logs() -> Vec<serde_json::Value> {
    let dirs = candidate_log_dirs();
    let mut files: Vec<PathBuf> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for dir in &dirs {
        if let Ok(read) = fs::read_dir(dir) {
            for e in read.filter_map(|e| e.ok()) {
                let p = e.path();
                if let Some(name) = p.file_name().map(|n| n.to_string_lossy().to_string()) {
                    // 按文件名去重（同一类日志只可能存在于一个目录）
                    // 匹配：screenoff.log（活跃）/ screenoff.N.log（滚动归档）/ screenoff-YYYY-MM-DD.log（旧日期格式，兼容历史）
                    if name.starts_with("screenoff") && name.ends_with(".log") && seen.insert(name) {
                        files.push(p);
                    }
                }
            }
        }
    }
    files.sort();
    let mut entries = Vec::new();
    for f in files {
        if let Ok(content) = fs::read_to_string(&f) {
            for line in content.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                // JSON Lines：每行是一个 JSON 对象 {"time":"...","trigger":"...","reason":"...","lock":bool}
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
                    entries.push(val);
                }
            }
        }
    }
    finalize_desc(entries)
}

/// 读取运行日志（sleeptimer.log / sleeptimer.N.log 滚动归档），按时间倒序（最新在前）。
/// 行格式：[2026-07-17 09:23:08.123] [INFO ] [component] message
pub fn read_run_logs() -> Vec<serde_json::Value> {
    let dirs = candidate_log_dirs();
    let mut files: Vec<PathBuf> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for dir in &dirs {
        if let Ok(read) = fs::read_dir(dir) {
            for e in read.filter_map(|e| e.ok()) {
                let p = e.path();
                if let Some(name) = p.file_name().map(|n| n.to_string_lossy().to_string()) {
                    // 匹配：sleeptimer.log（活跃）/ sleeptimer.N.log（滚动归档）
                    if name.starts_with("sleeptimer") && name.ends_with(".log") && seen.insert(name) {
                        files.push(p);
                    }
                }
            }
        }
    }
    files.sort();
    let mut entries = Vec::new();
    for f in files {
        if let Ok(content) = fs::read_to_string(&f) {
            for line in content.lines() {
                let line = line.trim();
                if line.is_empty() || !line.starts_with('[') {
                    continue;
                }
                if let Some(e) = parse_run_log_line(line) {
                    entries.push(e);
                }
            }
        }
    }
    finalize_desc(entries)
}

/// 读取用户操作审计日志（operation.log / operation.N.log），时间倒序。
/// 行格式（JSON Lines）：{"time":"...","action":"...","detail":"..."}
pub fn read_op_logs() -> Vec<serde_json::Value> {
    let dirs = candidate_log_dirs();
    let mut files: Vec<PathBuf> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for dir in &dirs {
        if let Ok(read) = fs::read_dir(dir) {
            for e in read.filter_map(|e| e.ok()) {
                let p = e.path();
                if let Some(name) = p.file_name().map(|n| n.to_string_lossy().to_string()) {
                    if name.starts_with("operation") && name.ends_with(".log") && seen.insert(name) {
                        files.push(p);
                    }
                }
            }
        }
    }
    files.sort();
    let mut entries = Vec::new();
    for f in files {
        if let Ok(content) = fs::read_to_string(&f) {
            for line in content.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
                    entries.push(val);
                }
            }
        }
    }
    finalize_desc(entries)
}

/// 倒序收尾：最新在前（跨文件按文件名升序写入后整体反转），并重排序号 1..N。
fn finalize_desc(mut entries: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    entries.reverse();
    for (i, e) in entries.iter_mut().enumerate() {
        e["id"] = serde_json::json!((i + 1) as u64);
    }
    entries
}

/// 解析一行运行日志：[时间] [级别] [组件] 消息
fn parse_run_log_line(line: &str) -> Option<serde_json::Value> {
    let close1 = line.find(']')?;
    let time = line[1..close1].trim().to_string();
    let rest = line[close1 + 1..].trim_start();
    let rest = rest.strip_prefix('[')?;
    let close2 = rest.find(']')?;
    let level = rest[..close2].trim().to_string();
    let rest2 = rest[close2 + 1..].trim_start();
    let rest2 = rest2.strip_prefix('[')?;
    let close3 = rest2.find(']')?;
    let component = rest2[..close3].trim().to_string();
    let message = rest2[close3 + 1..].trim().to_string();
    Some(serde_json::json!({
        "time": time,
        "level": level,
        "component": component,
        "message": message,
    }))
}

/// 按类型清空日志：kind ∈ "screenoff"（熄屏）/ "operation"（操作）/ "sleeptimer"（运行）。
/// 删除对应前缀的所有日志文件（活跃 + 滚动归档），跨候选目录。
pub fn clear_logs(kind: &str) -> Result<(), String> {
    let prefix = match kind {
        "screenoff" => "screenoff",
        "operation" => "operation",
        "sleeptimer" => "sleeptimer",
        _ => return Err(format!("未知日志类型: {}", kind)),
    };
    for dir in candidate_log_dirs() {
        if let Ok(read) = fs::read_dir(&dir) {
            for e in read.filter_map(|e| e.ok()) {
                let p = e.path();
                if let Some(name) = p.file_name().map(|n| n.to_string_lossy().to_string()) {
                    // 删除对应前缀的所有日志：<prefix>.log / <prefix>.N.log / 旧 <prefix>-*.log
                    if name.starts_with(prefix) && name.ends_with(".log") {
                        fs::remove_file(&p).ok();
                    }
                }
            }
        }
    }
    Ok(())
}

/// Guard used to protect the rotating loggers with a mutex.
pub type Shared<T> = Mutex<T>;
