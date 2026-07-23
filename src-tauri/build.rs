use std::fs;
use std::path::PathBuf;

fn main() {
    // Tauri 资源/配置处理（必须调用，否则 generate_context! 找不到资源）
    tauri_build::build();

    // 编译时注入构建日期（YYYYMMDD）
    let build_date = chrono::Local::now().format("%Y%m%d").to_string();
    println!("cargo:rustc-env=APP_BUILD_DATE={}", build_date);

    // 当天构建次数：每次构建自动 +1，用于在同一构建日期下区分不同构建产物。
    // 计数器存放在 target/ 下（已被 gitignore），不污染源码仓库；target 被 clean 后从 1 重新计。
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let counter_path = PathBuf::from(&manifest_dir).join("target").join(".build_count");
    let (prev_date, prev_count) = read_counter(&counter_path);
    let count = if prev_date == build_date { prev_count + 1 } else { 1 };
    if let Some(parent) = counter_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&counter_path, format!("{} {}\n", build_date, count));

    // 注入完整版本号：主版本.次版本.构建日期.当天构建次数（如 1.0.20260723.2）
    let full = format!("1.0.{}.{}", build_date, count);
    println!("cargo:rustc-env=APP_BUILD_VERSION={}", full);

    // 当 package.version 变化时重新构建，确保上下文取到最新版本
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=build.rs");
}

/// 读取上一轮的「日期 次数」记录（纯文本，避免引入额外依赖）
fn read_counter(path: &PathBuf) -> (String, u32) {
    if let Ok(s) = fs::read_to_string(path) {
        let mut it = s.split_whitespace();
        let d = it.next().unwrap_or("").to_string();
        let c = it.next().and_then(|x| x.parse::<u32>().ok()).unwrap_or(0);
        (d, c)
    } else {
        ("".to_string(), 0)
    }
}
