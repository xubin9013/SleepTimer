/// 行业标准日志系统
///
/// 文件命名：sleeptimer-YYYY-MM-DD.log（每日一个活跃日志，超出 5MB 自动轮转）
/// 轮转归档：sleeptimer-YYYY-MM-DD.{created_ts}-{rotated_ts}.log
/// 自动清理：启动时删除超过 30 天的旧日志
/// 格式：2026-07-17 09:23:08.123 [INFO ] [component] message
///
/// 级别（从低到高）：TRACE < DEBUG < INFO < WARN < ERROR < FATAL

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const MAX_BYTES: u64 = 5 * 1024 * 1024; // 5 MB per file
const RETAIN_DAYS: i64 = 30;             // 保留最近 30 天

pub struct AppLogger {
    dir: PathBuf,
    base: String,
    file: Option<File>,
    size: u64,
    date_str: String,
}

impl AppLogger {
    /// 创建应用日志器。base 通常为 "sleeptimer"。
    pub fn new(dir: PathBuf, base: &str) -> Self {
        let mut logger = AppLogger {
            dir,
            base: base.to_string(),
            file: None,
            size: 0,
            date_str: String::new(),
        };
        // 启动时清理过期日志
        Self::cleanup_old(&logger.dir, &logger.base);
        logger.ensure();
        logger
    }

    fn today() -> String {
        chrono::Local::now().format("%Y-%m-%d").to_string()
    }

    fn now_compact() -> String {
        chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
    }

    /// 删除超过 RETAIN_DAYS 天的旧日志文件
    fn cleanup_old(dir: &Path, base: &str) {
        if !dir.is_dir() { return; }
        let cutoff = chrono::Local::now() - chrono::Duration::days(RETAIN_DAYS);
        let cutoff_str = cutoff.format("%Y-%m-%d").to_string();

        if let Ok(read) = fs::read_dir(dir) {
            for entry in read.filter_map(|e| e.ok()) {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                // 匹配 sleeptimer-YYYY-MM-DD.log 或 sleeptimer-YYYY-MM-DD.*.log
                if !name_str.starts_with(&format!("{}-", base)) || !name_str.ends_with(".log") {
                    continue;
                }
                // 从文件名提取日期部分
                let date_part = name_str
                    .strip_prefix(&format!("{}-", base))
                    .and_then(|rest| rest.split('.').next())
                    .unwrap_or("");
                // 只删除日期早于截止日的文件（保留当日和近期的）
                if !date_part.is_empty() && date_part < cutoff_str.as_str() {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }

    fn ensure(&mut self) {
        let today = Self::today();
        // 日期变更时切换到新文件
        if self.date_str != today || self.file.is_none() {
            self.date_str = today.clone();
            if let Some(f) = self.file.take() {
                drop(f); // 关闭旧文件句柄
            }
        }
        if self.file.is_none() {
            let _ = fs::create_dir_all(&self.dir);
            let path = self.dir.join(format!("{}-{}.log", self.base, self.date_str));
            match OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
            {
                Ok(f) => {
                    self.size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    self.file = Some(f);
                }
                Err(_) => {}
            }
        }
    }

    fn rotate(&mut self) {
        if let Some(f) = self.file.take() {
            drop(f);
        }
        let path = self.dir.join(format!(
            "{}-{}.log",
            self.base, self.date_str
        ));
        let archive = self.dir.join(format!(
            "{}-{}.{}-{}.log",
            self.base,
            self.date_str,
            Self::now_compact(),
            Self::now_compact()
        ));
        let _ = fs::rename(&path, &archive);
        self.ensure(); // 打开新文件
    }

    /// 写入一行格式化日志。外部应通过 fmt_log() 统一格式化后传入。
    pub fn write_line(&mut self, line: &str) {
        self.ensure();
        let bytes = line.as_bytes();
        if self.size > 0 && self.size + bytes.len() as u64 > MAX_BYTES {
            self.rotate();
        }
        if let Some(f) = self.file.as_mut() {
            let _ = writeln!(f, "{}", line);
            let _ = f.flush();
            self.size += bytes.len() as u64 + 1; // +1 for newline
        }
    }
}

// ─── 辅助格式化函数 ──────────────────────────────────────────────

/// 级别名称右对齐（5 字符宽度），与行业标准对齐
fn level_pad(level: &str) -> String {
    format!("{:>5}", level.to_uppercase())
}

/// 格式化日志行：[时间戳] [级别] [组件] 消息
pub fn fmt_log(level: &str, component: &str, message: &str) -> String {
    let ts = chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string();
    format!("[{}] [{}] [{}] {}", ts, level_pad(level), component, message)
}

/// 快捷格式化（仅级别+消息，用于兼容旧调用）
pub fn fmt_log_simple(level: &str, message: &str) -> String {
    fmt_log(level, "app", message)
}
