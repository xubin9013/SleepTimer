// countdown-toast.js — 独立倒计时弹窗逻辑（经典脚本，依赖 Tauri 全局 API，但显示不依赖它）
// 注意：CSP 为 script-src 'self'，因此必须用外部文件，不能用内联 <script>。
// 关键：先渲染 + 本地倒计时，保证弹窗一定显示；Tauri 仅在可用时用于通知主窗/执行熄屏。
(function () {
  "use strict";

  // withGlobalTauri: true 时，Tauri 会把 API 注入到 window.__TAURI__
  var T = window.__TAURI__ || {};
  var ev = T.event || {};
  var core = T.core || {};
  var hasTauri = !!(ev.listen && ev.emit);
  var hasInvoke = !!(core && typeof core.invoke === "function");

  // ★ Debug 辅助函数：尝试通过 emit 向主窗发送日志（主窗可监听并写入 debug.log）
  function dbg(msg) {
    try {
      if (hasTauri) { ev.emit("countdown-debug", { msg: msg, ts: new Date().toISOString() }); }
    } catch (_) {}
    // 同时打控制台（开发时有用，生产环境可通过 DevTools 查看）
    console.log("[countdown-toast] " + msg);
  }

  function emit(name, payload) {
    if (hasTauri) { try { ev.emit(name, payload); } catch (e) { dbg("emit(" + name + ") 失败: " + String(e)); } }
  }

  dbg("脚本开始执行");
  dbg("__TAURI__ 存在: " + hasTauri + ", core.invoke 可用: " + hasInvoke);

  // ★ 修复：Tauri 2 asset 协议不支持 query string，参数改用 hash fragment 传递
  var params = new URLSearchParams(location.hash.slice(1));
  var total = parseInt(params.get("seconds") || "5", 10);
  if (isNaN(total) || total < 1) total = 5;
  var lock = params.get("lock") === "1";
  var trigger = params.get("trigger") || "manual";
  dbg("参数解析: seconds=" + total + " lock=" + lock + " trigger=" + trigger);

  var msgEl = document.getElementById("msg");
  var fillEl = document.getElementById("fill");
  dbg("DOM 元素: msgEl=" + !!msgEl + " fillEl=" + !!fillEl);

  var remaining = total;

  function render() {
    if (!msgEl) { dbg("render(): msgEl 不存在，跳过"); return; }
    msgEl.textContent = "显示器将在 " + remaining + " 秒后关闭，点击此窗口可取消。";
    var pct = total > 0 ? (remaining / total) * 100 : 0;
    if (fillEl) fillEl.style.width = pct + "%";
  }

  // ★ 立即渲染（不依赖 Tauri，保证弹窗一定显示内容）
  render();
  dbg("首次渲染完成, remaining=" + remaining);

  // 通知主窗：弹窗已就绪
  emit("countdown-ready");
  dbg("已发出 countdown-ready 事件");

  // ★ 本地倒计时：即便 Tauri 不可用也能显示与倒数
  var timer = setInterval(function () {
    remaining--;
    dbg("倒数 tick: remaining=" + remaining);
    if (remaining <= 0) {
      clearInterval(timer);
      render();
      dbg("倒计时归零 → 调用 fireOff()");
      fireOff();
      return;
    }
    render();
  }, 1000);
  dbg("本地 setInterval 已启动，间隔=1000ms");

  // 到点执行熄屏：优先直接 invoke 后端（最稳，不依赖主窗监听）；失败再 emit 通知主窗兜底
  function fireOff() {
    dbg("fireOff() 执行中...");
    dbg("hasInvoke=" + hasInvoke + ", hasTauri=" + hasTauri);
    try {
      if (hasInvoke) {
        dbg("尝试 core.invoke('trigger_screenoff', {lock:" + lock + ", trigger:'" + trigger + "'})...");
        core.invoke("trigger_screenoff", { lock: lock === 1, trigger: trigger }).then(function () {
          dbg("core.invoke trigger_screenoff 成功（Promise resolved）");
        }).catch(function (e) {
          dbg("core.invoke trigger_screenoff 失败(Promise rejected): " + String(e));
          // invoke 失败则 fallback
          dbg("fallback: 发出 countdown-finished 事件通知主窗");
          emit("countdown-finished");
        });
        return;
      } else {
        dbg("core.invoke 不可用，直接走 emit fallback");
      }
    } catch (e) {
      dbg("core.invoke 调用抛出异常: " + String(e));
    }
    dbg("发出 countdown-finished 事件（emit fallback）");
    emit("countdown-finished"); // 主窗监听到后执行熄屏
    // 若 Tauri 不可用，无法通知主窗，则自行关闭（避免一直停在此处）
    if (!hasTauri) { setTimeout(function () { if (window.close) window.close(); }, 400); }
  }

  // 监听主窗可能下发的"取消"
  if (hasTauri && ev.listen) {
    dbg("注册 countdown-cancel 监听...");
    ev.listen("countdown-cancel", function () {
      dbg("收到 countdown-cancel → 清除定时器并关闭窗口");
      clearInterval(timer);
      if (window.close) window.close();
    });
  } else {
    dbg("无法注册 countdown-cancel（Tauri event API 不可用）");
  }

  // 点击整窗取消 → 通知主窗并关闭
  document.body.addEventListener("click", function () {
    dbg("用户点击弹窗 → 取消倒计时并关闭");
    clearInterval(timer);
    emit("countdown-cancel");
    if (window.close) window.close();
  });

  dbg("脚本初始化完毕，等待倒计时...");
})();
