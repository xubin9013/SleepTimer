// diag.ts — 全局诊断模块
// 捕获前端运行期错误（包括异步未处理拒绝），在界面底部弹出可复制的报错横幅，
// 同时写入应用调试日志，方便把报错详情发给开发者排查。
//
// 使用方式：在入口 init() 中调用 installDiagnostics()。
// 控制台可访问 window.__diag.getErrors() / window.__diag.lastReport() 获取历史报错。

let errors: string[] = [];

interface DiagInfo {
  message: string;
  stack?: string;
  kind: string;
}

function appVersion(): string {
  const v = (window as any).__APP_VERSION__;
  return typeof v === "string" && v ? v : "unknown";
}

function buildReport(info: DiagInfo): string {
  const ts = new Date().toISOString();
  const ua = navigator.userAgent;
  const lines = [
    "==== SleepTimer 诊断报告 ====",
    `时间: ${ts}`,
    `版本: ${appVersion()}`,
    `类型: ${info.kind}`,
    `信息: ${info.message}`,
  ];
  if (info.stack) lines.push(`堆栈:\n${info.stack}`);
  lines.push(`UA: ${ua}`);
  lines.push("==============================");
  return lines.join("\n");
}

function ensureBanner(): { root: HTMLElement; msg: HTMLElement; btn: HTMLElement } {
  let root = document.getElementById("diag-banner") as HTMLElement | null;
  if (root) {
    return {
      root,
      msg: root.querySelector("#diag-banner-msg") as HTMLElement,
      btn: root.querySelector("#diag-banner-copy") as HTMLElement,
    };
  }
  root = document.createElement("div");
  root.id = "diag-banner";
  Object.assign(root.style, {
    position: "fixed",
    left: "50%",
    bottom: "16px",
    transform: "translateX(-50%)",
    background: "#1F2937",
    color: "#fff",
    padding: "10px 14px",
    borderRadius: "10px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
    zIndex: "9999",
    font: "13px/1.5 system-ui, sans-serif",
    maxWidth: "90vw",
    display: "flex",
    gap: "10px",
    alignItems: "center",
  } as CSSStyleDeclaration);

  const msg = document.createElement("span");
  msg.id = "diag-banner-msg";
  msg.style.flex = "1";
  msg.style.wordBreak = "break-all";

  const btn = document.createElement("button");
  btn.id = "diag-banner-copy";
  btn.textContent = "复制报错";
  Object.assign(btn.style, {
    background: "#6B5DD3",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    padding: "4px 10px",
    cursor: "pointer",
    flexShrink: "0",
  } as CSSStyleDeclaration);

  btn.addEventListener("click", () => {
    const report = (root as any).__report || "";
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(report).then(
        () => {
          btn.textContent = "已复制";
          setTimeout(() => (btn.textContent = "复制报错"), 1500);
        },
        () => {
          btn.textContent = "复制失败";
          setTimeout(() => (btn.textContent = "复制报错"), 1500);
        }
      );
    }
  });

  root.append(msg, btn);
  document.body.appendChild(root);
  return { root, msg, btn };
}

function showBanner(report: string, short: string) {
  const { root, msg } = ensureBanner();
  msg.textContent = "运行出错：" + short;
  (root as any).__report = report;
}

function reportError(kind: string, e: any) {
  const message = e?.message || (typeof e === "string" ? e : kind);
  const stack = e?.error?.stack || e?.stack;
  const report = buildReport({ message: String(message), stack: stack ? String(stack) : undefined, kind });
  errors.push(report);
  if (errors.length > 20) errors.shift();
  // 控制台也打印，便于开发者工具查看
  // eslint-disable-next-line no-console
  console.error("[SleepTimer Diag]\n" + report);
  showBanner(report, String(message).slice(0, 60));
  // 同时写入应用调试日志（异步，不阻塞）
  import("./api")
    .then((m) => m.api.logError("[ui] 前端错误(" + kind + "): " + String(message)).catch(() => {}))
    .catch(() => {});
}

export function installDiagnostics() {
  window.addEventListener("error", (e: any) => reportError("error", e));
  window.addEventListener("unhandledrejection", (e: any) => reportError("unhandledrejection", e));
  (window as any).__diag = {
    getErrors: () => errors.slice(),
    lastReport: () => errors[errors.length - 1] || "",
  };
}
