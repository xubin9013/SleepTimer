# SleepTimer — Windows 定时熄屏客户端

一个轻量、原生的 Windows 定时熄屏工具。用户可创建多个「熄屏方案」（每个方案含若干 `HH:MM:SS` 时间点），到点自动关闭显示器（可选锁屏），并在熄屏前弹出可取消的倒计时提示。支持循环方案、明/暗主题、系统托盘、开机自启与运行日志。

> 安装包构建说明见同目录 [`构建说明.md`](./构建说明.md)。

---

## 一、技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| 后端 | **Tauri 2.x + Rust** | 复用系统 WebView2，不打包 Chromium；体积小（安装包 < 2MB） |
| 前端 | **TypeScript + Vite 5** | 原生 DOM 渲染（无框架），`@tauri-apps/api` 调用后端命令 |
| 系统能力 | `windows-sys` / `winreg` | 熄屏（`WM_SYSCOMMAND`）、注册表自启、全局键盘钩子 |
| 打包 | **NSIS**（`installer.nsi` + 本地 `nsis-tools`） | 生成 `SleepTimer-Setup.exe` |

---

## 二、目录结构与各源码文件作用

```
SleepTimer/
├── index.html              # 主窗口入口 HTML（被 Vite 编译为 dist/main）
├── countdown.html          # 倒计时弹窗独立轻量页面（不加载主程序包，首帧即显示）
├── package.json            # 前端依赖与脚本（dev/build/preview）
├── vite.config.ts          # Vite 多页构建配置（main + countdown 两个入口）
├── tsconfig.json           # TypeScript 编译选项
├── installer.nsi           # NSIS 安装脚本（运行检测/杀进程/安装/卸载）
├── 构建说明.md             # 安装包交付物与构建命令说明
├── src/
│   ├── main.ts             # 主程序前端入口：构建外壳、模块路由、调度器、一键熄屏
│   ├── store.ts            # 全局配置状态（cfg）+ 配置读写 + 循环当前方案计算
│   ├── api.ts              # Tauri 命令调用封装（invoke 的 TS 类型化接口）
│   ├── countdown.ts        # 倒计时编排：计算弹窗位置、调用 Rust 创建弹窗窗口
│   ├── countdown-page.ts   # 倒计时弹窗页面逻辑：事件/轮询启动、渲染、取消/归零
│   ├── ui.ts               # DOM 工具（el）、模态框、Toast、confirmModal
│   ├── icons.ts            # 内联 SVG 图标库（PATHS 字典 + iconEl）
│   ├── pickers.ts          # 时间/日期/月份选择器（无限滚轮 + 日历）
│   ├── diag.ts             # 前端诊断：捕获未处理异常，弹可复制报错横幅并写日志
│   ├── style.css           # 全部样式（设计令牌、明/暗主题、胶囊/弹窗/拖拽动画）
│   └── modules/
│       ├── plans.ts        # 方案管理页：新建/重命名/删除方案、时间点增删改
│       ├── settings.ts     # 设置页：执行方案、循环配置、长按时序拖拽排序、开关项
│       └── logs.ts         # 熄屏日志页：分页表格、刷新、清空
└── src-tauri/
    ├── Cargo.toml          # Rust 依赖（tauri、serde、windows-sys、winreg、chrono…）
    ├── build.rs            # 构建脚本（注入编译期信息）
    ├── tauri.conf.json     # Tauri 应用配置（窗口 main / 安全 CSP / 打包）
    ├── capabilities/default.json  # 运行时权限声明（窗口/事件/对话框…）
    └── src/
        ├── main.rs         # 程序入口，调用 sleeptimer_lib::run()
        ├── lib.rs          # 核心：AppState、所有 #[tauri::command]、托盘、弹窗池、全局 ESC 钩子
        ├── models.rs       # 数据模型（AppConfig/Plan/LoopConfig/Settings）+ 配置/日志读写
        ├── platform.rs     # Windows 系统调用：熄屏、注册表自启、文件夹选择
        └── logger.rs       # 行业标准日志系统（按日轮转、30 天清理）
```

### Rust 后端文件职责

- **`main.rs`** — 极简入口，转发到 `sleeptimer_lib::run()`。
- **`lib.rs`** — 程序核心。
  - 定义 `AppState`（配置、日志通道、待执行倒计时参数）；
  - 注册全部 Tauri 命令：`get_config` / `save_config` / `trigger_screenoff` / `set_autostart` / `pick_folder` / `read_logs` / `clear_logs` / `reset_all` / `create_countdown_window` / `cancel_countdown` / `get_countdown_state` / `close_countdown_windows` 等；
  - 构建**系统托盘**（左键显示、右键退出菜单）、**预创建隐藏倒计时弹窗池**、在 `setup` 中安装**全局 ESC 低级键盘钩子**；
  - `run()` 内同步注册表自启状态，并在主窗口关闭时按 `minimize_to_tray` 配置决定最小化到托盘还是退出。
- **`models.rs`** — 配置与日志的数据结构（`serde` 序列化）、配置文件 `app.json` 的读写（优先 `<exe>/config`，不可写时回退 `%LOCALAPPDATA%`）、熄屏日志 `screenoff-*.log` 的读取与清空、版本号生成。
- **`platform.rs`** — 平台相关 Windows API：`screen_off`（广播 `WM_SYSCOMMAND` + `SC_MONITORPOWER` 关屏，可选 `LockWorkStation` 锁屏）、`set_autostart`/`check_autostart`（注册表 `HKCU\...\Run`）、`pick_folder`（原生文件夹选择）。
- **`logger.rs`** — 后台线程日志器：按日期文件名、超过 5MB 自动轮转、保留 30 天、统一格式 `[时间戳] [级别] [组件] 消息`。

### 前端 TypeScript 文件职责

- **`main.ts`** — 主入口。构建自定义标题栏（图标/版本/当前方案 Pill/主题切换/一键熄屏/最小化/关闭）、可折叠侧边栏；按模块渲染「方案管理/设置/熄屏日志」；`startScheduler()` 每秒检查当前方案时间点并在提前量内触发倒计时；处理 ESC 取消与右键菜单屏蔽。
- **`store.ts`** — 全局单例 `store`（持有 `cfg` 与当前模块），提供配置加载/保存、`computeLoopCurrent()`（按开始日期+间隔计算循环当前方案）、`getEffectivePlanName()`。
- **`api.ts`** — 对 Rust 命令的类型化封装（`invoke`），并定义 `AppConfig`/`Plan`/`Settings`/`LogRow` 等接口。
- **`countdown.ts` / `countdown-page.ts`** — 倒计时协作：`countdown.ts` 计算右下角位置并调用 `createCountdown_window`；`countdown-page.ts` 是弹窗页面，监听 `cd:show` 事件启动倒计时，并以 150ms 轮询 `get_countdown_state` 兜底（防止事件丢失导致不显示），归零调 `trigger_screenoff` 后隐藏窗口、取消则直接隐藏。
- **`ui.ts`** — `el()` 声明式 DOM 构建助手、模态框 `openModal`、Toast、危险确认 `confirmModal`。
- **`icons.ts`** — 所有界面图标的 SVG path 字典与 `iconEl()` 生成器。
- **`pickers.ts`** — 时间三列无限滚轮（`makeWheel`，最短路径滚动避免跨零点转整圈）、日期/月份日历选择器。
- **`diag.ts`** — `installDiagnostics()` 捕获 `error` / `unhandledrejection`，底部弹出可复制诊断横幅并写入调试日志。
- **`modules/plans.ts`** — 方案卡片与时间点管理 UI。
- **`modules/settings.ts`** — 设置页，含**循环方案长按时序拖拽排序**（`enableReorder`）。
- **`modules/logs.ts`** — 日志分页表格与清空。
- **`style.css`** — 全部视觉：CSS 变量设计令牌、明/暗主题、卡片/胶囊/弹窗/拖拽动画。

---

## 三、核心功能如何实现

### 1. 定时熄屏
`platform.rs` 通过 `SendMessageTimeoutW(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, 2)` 关闭显示器；可选 `LockWorkStation()` 锁屏。用 `SendMessageTimeoutW` 而非同步 `SendMessageW`，避免被挂起窗口阻塞主流程。`main.ts` 的 `startScheduler()` 每秒遍历当前方案的所有时间点，当「距目标时间 ≤ 提前量（=倒计时秒数）」且当天未触发过时，弹出倒计时；倒计时归零调用 `trigger_screenoff`。

### 2. 倒计时弹窗池（解决首帧空白 + 复用）
`create_countdown_window` 在 `setup` 阶段**预创建**一个隐藏的 `WebviewWindow`（加载轻量 `countdown.html`）。需要倒计时时：定位 → `show()` + `set_focus()` → `emit("cd:show", 参数)`。窗口**不关闭、只隐藏**，下次复用，彻底消除 WebView2 冷启动的 ~1s 空白。弹窗页面同时用 150ms 轮询 `get_countdown_state` 兜底，确保即使 `cd:show` 事件因窗口首次显示脚本未就绪而错过，倒计时也一定会启动。

### 3. 全局 ESC 取消
倒计时弹窗是独立 WebviewWindow，失去焦点后自身的 `keydown` 收不到 ESC。因此在 Rust 端用 `WH_KEYBOARD_LL` 低级键盘钩子（`lib.rs` 的 `global_hotkey` 模块）全局捕获 ESC：当 `pending_countdown` 存在时拦截并 `emit("cd:cancel")`，弹窗页面收到后取消并隐藏。钩子仅依赖项目已有的 `windows-sys`，不引入额外 crate。

### 4. 循环方案 + 长按时序拖拽排序
- 循环顺序在 `modules/settings.ts` 的 `enableReorder` 中实现。
- **元素区分**：紫色填充胶囊（`.order-pill.in-sequence`）= 已激活可拖拽；白色空心胶囊 = 未激活，不可拖拽（仅拖拽绑在 `.in-sequence` 上）。
- **触发**：鼠标左键长按 ≥ **100ms** 进入拖拽模式；短按仅切换方案激活态（点击处理）。
- **跟随**：`pointerdown` 时在 `document` 上挂 `pointermove`/`pointerup`/`pointercancel`（不再依赖 `setPointerCapture`，避免 WebView2 重排时指针捕获被隐式释放导致不跟随），实时把胶囊 transform 到鼠标位置，自由横纵移动。
- **换位吸附**：拖拽途经其他紫色胶囊时，被挤占胶囊执行 **300ms ease-out** FLIP 位移动画；松手后拖拽胶囊平滑吸附到落点空位完成交换，序号 `1、2、3…` 自动顺延。
- **视觉**：拖拽中胶囊提升 `z-index`、放大 **1.05 倍**、半透明（`opacity:0.9`）。
- **边界**：移动被钳制在 `.order-pill-list` 容器内，无法拖出。
- **兼容**：点击切换与拖拽互不冲突（拖拽提交后用 `suppressOrderClick` 抑制紧随的误触 click）。

### 5. 主题切换
`toggleTheme()` 直接修改 `document.documentElement[data-theme]`，所有元素在同一绘制帧更新颜色（无重建、无过渡错位），并持久化到配置。倒计时弹窗在 `create_countdown_window` 时读取主程序主题并随 `cd:show` 下发，保证主题一致。

### 6. 系统托盘 / 单实例 / 开机自启
- 托盘：`build_tray` 创建仅右键菜单（退出）的托盘图标，左键点击显示并聚焦主窗口。
- 单实例：`tauri_plugin_single_instance` 保证重复启动时聚焦已开窗口而非多开。
- 自启：`platform::set_autostart` 写入/删除注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\SleepTimer`；安装时若用户在安装器勾选，注册表状态会在 `setup` 阶段与配置同步。

### 7. 配置与日志持久化
配置存于 `<exe>/config/app.json`（`models.rs`，不可写时回退 `%LOCALAPPDATA%\SleepTimer\config`）。日志分两类：调试日志 `sleeptimer-*.log`（后台线程、按日轮转、30 天清理，`logger.rs`）与熄屏事件日志 `screenoff-*.log`（JSON Lines，中文原因「手动/定时/循环」，`models.rs`）。

### 8. 时间选择器
`pickers.ts` 的 `makeWheel` 用「重复 7 段数据 + 中段基准」实现无限循环滚轮；滚动取**离当前最近的同值格子走圆环最短路径**，避免 00↔59 跨零点转整圈；滚轮事件拦截为单步 ±1，便于精确定位。

### 9. 前端诊断
`diag.ts` 监听 `error` 与 `unhandledrejection`，在界面底部显示可一键复制的诊断报告（含版本/UA/堆栈），同时写入调试日志，便于排查问题。

---

## 四、如何构建与运行

### 开发模式
```bash
cd SleepTimer
npm install
npm run dev          # Vite 开发服务器（http://localhost:1420）
```

### 打包为可执行程序 + 安装包
```bash
# 1) 完整 Tauri 管线（含 npm run build + Rust 编译 + 前端嵌入 exe）
npx tauri build
# 2) 编译 NSIS 安装包（生成 SleepTimer-Setup.exe）
nsis-tools/tools/makensis.exe installer.nsi
```
> ⚠️ 必须用 `npx tauri build`（不要直接 `cargo build --release`），否则前端不会嵌入 exe，运行报 `ERR_CONNECTION_REFUSED`。

### 第三方依赖说明
- `node_modules/`、`src-tauri/target/`、`dist/` 为构建产物，不入库。
- `nsis-tools/`（NSIS 工具链）与 `nsis-tool.nupkg` 为打包工具，不入库；入库的是安装脚本 `installer.nsi`。
- 运行时产生的 `log/`、`config/` 目录不入库。

---

## 五、许可证与说明
本项目为内部 Windows 客户端，源码按上述结构组织，便于阅读、二次开发与持续集成。
