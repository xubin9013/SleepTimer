fn main() {
    // Tauri 资源/配置处理（必须调用，否则 generate_context! 找不到资源）
    tauri_build::build();

    // 编译时注入构建日期（YYYYMMDD），供标题栏版本号显示使用
    let build_date = chrono::Local::now().format("%Y%m%d").to_string();
    println!("cargo:rustc-env=APP_BUILD_DATE={}", build_date);
    println!("cargo:rerun-if-changed=build.rs");
}
