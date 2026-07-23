/// 日志系统（按类别分文件 + 按大小滚动，不做自动清理）
///
/// 两类日志：
///   - 熄屏日志：screenoff.log   （base = "screenoff"）
///   - 运行日志：sleeptimer.log  （base = "sleeptimer"）
///
/// 活跃文件固定为 `<base>.log`；每次写入前若累计大小将超 5MB，则滚动：
///   将当前 `<base>.log` 重命名为 `<base>.<N>.log`（N 为递增序号，取现有最大序号 + 1），
///   再新建空的 `<base>.log` 继续写入。
/// 滚动归档文件永不被自动删除，由用户手动清理。
///
/// 行格式：2026-07-17 09:23:08.123 [INFO ] [component] message

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

const MAX_BYTES: u64 = 5 * 1024 * 1024; // 单文件 5 MB 上限

pub struct AppLogger {
    dir: PathBuf,
    base: String,
    file: Option<File>,
    size: u64,
}

impl AppLogger {
    /// 创建应用日志器。base 通常为 "screenoff" 或 "sleeptimer"。
    pub fn new(dir: PathBuf, base: &str) -> Self {
        let mut logger = AppLogger {
            dir,
            base: base.to_string(),
            file: None,
            size: 0,
        };
        logger.ensure();
        logger
    }

    /// 活跃日志文件路径：<dir>/<base>.log
    fn active_path(&self) -> PathBuf {
        self.dir.join(format!("{}.log", self.base))
    }

    /// 计算下一个滚动序号：扫描 <base>.<N>.log，取最大 N + 1（不存在则为 1）。
    fn next_rotate_index(&self) -> u64 {
        let mut max = 0u64;
        if let Ok(read) = fs::read_dir(&self.dir) {
            for entry in read.filter_map(|e| e.ok()) {
                let name = entry.file_name().to_string_lossy().to_string();
                // 仅匹配 <base>.<N>.log 这种滚动归档
                if let Some(rest) = name.strip_prefix(&format!("{}.", self.base)) {
                    if let Some(num) = rest.strip_suffix(".log") {
                        if let Ok(n) = num.parse::<u64>() {
                            if n > max {
                                max = n;
                            }
                        }
                    }
                }
            }
        }
        max + 1
    }

    /// 确保活跃文件已打开（不存在则打开/创建，并同步当前大小）。
    fn ensure(&mut self) {
        if self.file.is_none() {
            let _ = fs::create_dir_all(&self.dir);
            let path = self.active_path();
            match OpenOptions::new().create(true).append(true).open(&path) {
                Ok(f) => {
                    self.size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    self.file = Some(f);
                }
                Err(_) => {}
            }
        }
    }

    /// 滚动：关闭当前活跃文件，重命名为 <base>.<N>.log，再打开新的活跃文件。
    fn rotate(&mut self) {
        if let Some(f) = self.file.take() {
            let _ = f.sync_all();
            drop(f);
        }
        let active = self.active_path();
        let idx = self.next_rotate_index();
        let archive = self.dir.join(format!("{}.{}.log", self.base, idx));
        let _ = fs::rename(&active, &archive);
        self.ensure();
    }

    /// 写入一行格式化日志。外部应经 fmt_log() 统一格式化后传入。
    pub fn write_line(&mut self, line: &str) {
        self.ensure();
        let line_bytes = line.as_bytes().len() as u64;
        // 即将超过上限则先滚动（活跃文件若已超 5MB，首行也会触发滚动）
        if self.size > 0 && self.size + line_bytes + 1 > MAX_BYTES {
            self.rotate();
        }
        if let Some(f) = self.file.as_mut() {
            let _ = writeln!(f, "{}", line);
            let _ = f.flush();
            self.size += line_bytes + 1; // +1 for newline
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
