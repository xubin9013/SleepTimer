import { el, openModal, closeModal, toast, confirmModal, svgIcon } from "../ui";
import { store, saveConfig, loadConfig } from "../store";
import { openDatePicker, openMonthPicker } from "../pickers";
import { api } from "../api";

const pad = (n: number) => String(n).padStart(2, "0");

function makeToggle(checked: boolean, onToggle: (v: boolean) => boolean | void, disabled = false): HTMLElement {
  const input = el("input", { type: "checkbox" }) as HTMLInputElement;
  input.checked = checked;
  if (disabled) input.disabled = true;
  let prev = checked;
  input.addEventListener("change", () => {
    const accepted = onToggle(input.checked);
    if (accepted === false) {
      // 拒绝切换：回退视觉状态，不转变
      input.checked = prev;
    } else {
      prev = input.checked;
    }
  });
  return el("label", { class: "toggle" + (disabled ? " disabled" : "") }, input, el("span", { class: "track" }), el("span", { class: "thumb" }));
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function thisMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
function fmtDate(s: string) {
  if (!s) return "";
  // 始终显示具体日期，不显示"今天"
  const [y, m, d] = s.split("-").map(Number);
  return `${y}年${m}月${d}日`;
}
function fmtMonth(s: string) {
  if (!s) return "";
  // 始终显示具体月份，不显示"本月"
  const [y, m] = s.split("-").map(Number);
  return `${y}年${m}月`;
}

/** 按文本内容精确测量并设置输入框宽度，避免右侧多余空白 */
function fitToContent(input: HTMLInputElement) {
  const cs = getComputedStyle(input);
  const span = document.createElement("span");
  span.style.cssText = "position:absolute;visibility:hidden;white-space:pre;";
  span.style.fontSize = cs.fontSize;
  span.style.fontFamily = cs.fontFamily;
  span.style.fontWeight = cs.fontWeight;
  span.style.letterSpacing = cs.letterSpacing;
  span.textContent = input.value || " ";
  document.body.appendChild(span);
  const w = Math.ceil(span.getBoundingClientRect().width);
  document.body.removeChild(span);
  input.style.width = w + 24 + "px"; // 文本宽度 + 左右内边距
}

/** 行内错误提示：显示后 3 秒自动消失 */
function showInlineError(elErr: HTMLElement, msg: string) {
  elErr.textContent = msg;
  elErr.style.display = "inline";
  const prev = (elErr as any)._timer as number | undefined;
  if (prev) clearTimeout(prev);
  (elErr as any)._timer = window.setTimeout(() => {
    elErr.style.display = "none";
  }, 3000);
}

export function renderSettings(container: HTMLElement, rerender: () => void) {
  container.innerHTML = "";
  const cfg = store.cfg;
  container.append(
    el(
      "div",
      { class: "page-head" },
      el("h2", { class: "page-title", text: "设置" }),
      el("p", { class: "page-desc", text: "配置循环、启动行为与熄屏动作" })
    )
  );

  // ---- Card 1 ----
  const c1 = el("div", { class: "card" });

  // ★ 启用循环 row（放在最前面）
  const loopRow = el("div", { class: "field-row" });
  const enableLoopErr = el("span", { class: "inline-error" });
  loopRow.append(
    el("div", {}, el("div", { class: "field-label" }, "启用循环", enableLoopErr), el("div", { class: "field-sub", text: "多方案按序列循环执行" })),
    makeToggle(cfg.loop_cfg.enabled, (v) => {
      // 方案少于 2 个时不允许开启：弹出提示且不转变状态
      if (v && cfg.plans.length < 2) {
        showInlineError(enableLoopErr, "方案少于 2 个，无法循环");
        return false;
      }
      cfg.loop_cfg.enabled = v;
      if (v) {
        if (cfg.loop_cfg.order.length < 2) {
          cfg.loop_cfg.order = cfg.plans.slice(0, 2).map((p) => p.name);
        }
        if (!cfg.loop_cfg.start) cfg.loop_cfg.start = cfg.loop_cfg.granularity === "month" ? thisMonthStr() : todayStr();
      }
      saveConfig();
      rerender();
      return true;
    })
  );
  c1.append(loopRow);

  // 间隔线
  c1.append(el("div", { class: "divider" }));

  // ★ 执行方案 row（放在循环后面；当启用循环时隐藏）
  if (!cfg.loop_cfg.enabled) {
    const execRow = el("div", { class: "field-row" });
    const execLeft = el("div", {}, el("div", { class: "field-label", text: "执行方案" }), el("div", { class: "field-sub", text: "选择当前执行的熄屏方案" }));
    const planChips = el("div", { class: "plan-chips" });
    if (cfg.plans.length === 0) {
      planChips.append(el("span", { class: "card-desc", text: "暂无方案，请先在方案管理中创建" }));
    } else {
      for (const p of cfg.plans) {
        const active = p.name === cfg.current_plan;
        const b = el("button", {
          class: "plan-chip" + (active ? " active" : ""),
          text: p.name,
          title: p.name,
          onclick: () => { cfg.current_plan = p.name; saveConfig(); rerender(); },
        });
        planChips.append(b);
      }
    }
    execRow.append(execLeft, planChips);
    c1.append(execRow);
  }

  if (cfg.loop_cfg.enabled) {
    c1.append(renderLoopConfig(rerender));
  }
  container.append(c1);

  // ---- Card 2 ----
  const c2 = el("div", { class: "card" });
  c2.append(
    fieldRow("随系统启动", "开机自动运行 SleepTimer", cfg.settings.autostart, (v) => {
      cfg.settings.autostart = v;
      saveConfig();
      api.setAutostart(v).catch(() => toast("设置自启动失败", "error"));
    })
  );
  c2.append(
    fieldRow("关闭窗口最小化到系统托盘", "点击关闭按钮隐藏到托盘而非退出", cfg.settings.minimize_to_tray, (v) => {
      cfg.settings.minimize_to_tray = v;
      saveConfig();
    })
  );
  container.append(c2);

  // ---- Card 3 ----
  const c3 = el("div", { class: "card" });
  c3.append(
    fieldRow("熄屏并锁定系统", "到达时间后同时锁定屏幕", cfg.settings.lock_on_off, (v) => {
      cfg.settings.lock_on_off = v;
      saveConfig();
    })
  );
  c3.append(
    fieldRow("熄屏前提示倒计时", "到达前弹出可取消的倒计时通知", cfg.settings.countdown_enabled, (v) => {
      cfg.settings.countdown_enabled = v;
      saveConfig();
      rerender();
    })
  );
  if (cfg.settings.countdown_enabled) {
    const numRow = el("div", { class: "field-row" });
    const num = el("input", { class: "input input-num", type: "number", value: String(cfg.settings.countdown_seconds) }) as HTMLInputElement;
    num.min = "1"; num.max = "300";
    num.addEventListener("change", () => {
      let v = parseInt(num.value, 10);
      if (isNaN(v)) v = 5;
      v = Math.max(1, Math.min(300, v));
      num.value = String(v);
      cfg.settings.countdown_seconds = v;
      saveConfig();
    });
    numRow.append(el("div", {}, el("div", { class: "field-label", text: "提前提示时间" }), el("div", { class: "field-sub", text: "范围 1 ~ 300 秒" })), el("div", { class: "field-unit" }, num, el("span", { class: "unit-text", text: "秒" })));
    c3.append(numRow);
  }
  container.append(c3);

  // ---- Card 4: 重置（按钮放右侧，同开关样式）----
  const c4 = el("div", { class: "card" });
  const resetRow = el("div", { class: "field-row" });
  const resetBtn = el("button", { class: "btn btn-ghost-danger", onclick: () => {
    confirmModal({
      title: "重置确认",
      desc: "重置将清除全部方案、日志和设置，恢复到初始状态，是否继续？",
      confirmLabel: "重置",
      onConfirm: async () => {
        await api.resetAll();
        await loadConfig();
        rerender();
        toast("已重置为初始状态", "success");
      },
    });
  } }, "重置");
  resetRow.append(
    el("div", {}, el("div", { class: "field-label", text: "重置" }), el("div", { class: "field-sub", text: "恢复所有方案、日志和设置为初始状态" })),
    resetBtn
  );
  c4.append(resetRow);
  container.append(c4);
}

function fieldRow(label: string, sub: string, checked: boolean, onToggle: (v: boolean) => void) {
  const row = el("div", { class: "field-row" });
  row.append(el("div", {}, el("div", { class: "field-label", text: label }), el("div", { class: "field-sub", text: sub })), makeToggle(checked, onToggle));
  return row;
}

function renderLoopConfig(rerender: () => void): HTMLElement {
  const cfg = store.cfg;
  const lc = cfg.loop_cfg;
  const wrap = el("div", { style: "margin-top:8px" });

  // ★ 合并为一行：循环粒度 | 间隔 | 开始日期/月份（带标签）
  const mergedRow = el("div", { class: "field-row loop-config-row" });
  mergedRow.append(el("div", { class: "field-label", text: "循环设置" }));

  // 粒度按钮（前加"间隔单位"标签）
  const gDay = el("button", { class: "btn btn-sm " + (lc.granularity === "day" ? "btn-primary" : "btn-secondary"), text: "天" });
  const gMonth = el("button", { class: "btn btn-sm " + (lc.granularity === "month" ? "btn-primary" : "btn-secondary"), text: "月" });
  gDay.addEventListener("click", () => {
    lc.granularity = "day";
    // 切换到天时，如果当前start是月份格式(只有2段)，重置为今天
    if (!lc.start || lc.start.split("-").length < 3) lc.start = todayStr();
    saveConfig(); rerender();
  });
  gMonth.addEventListener("click", () => {
    lc.granularity = "month";
    // 切换到月时，如果当前start是日期格式(有3段)，重置为本月
    if (!lc.start || lc.start.split("-").length >= 3) lc.start = thisMonthStr();
    saveConfig(); rerender();
  });

  // 间隔（前加"间隔时间"标签）
  const num = el("input", { class: "input input-num input-num-sm", type: "number", value: String(lc.interval) }) as HTMLInputElement;
  num.min = "1"; num.max = "99";
  num.addEventListener("change", () => {
    let v = parseInt(num.value, 10);
    if (isNaN(v)) v = 1;
    v = Math.max(1, Math.min(99, v));
    num.value = String(v);
    lc.interval = v;
    saveConfig();
    rerender();
  });

  // 开始日期/月份（前加动态标签"开始日期"/"开始月份"，宽度严格自适应内容）
  const sInput = el("input", { class: "input input-sm", readonly: "true", style: "padding-left:8px;padding-right:8px", value: lc.granularity === "month" ? fmtMonth(lc.start) : fmtDate(lc.start) }) as HTMLInputElement;
  fitToContent(sInput);
  sInput.addEventListener("click", () => {
    const picker = lc.granularity === "month" ? openMonthPicker(lc.start) : openDatePicker(lc.start);
    picker.then((v) => {
      if (v == null) return;
      lc.start = v;
      saveConfig();
      rerender();
    });
  });

  const controls = el("div", { class: "loop-controls" },
    // 间隔单位
    el("span", { class: "loop-label", text: "间隔单位" }), gDay, gMonth,
    // 间隔时间
    el("span", { class: "loop-label loop-label-gap", text: "间隔时间" }), num, el("span", { class: "unit-text unit-text-sm", text: lc.granularity === "month" ? "月" : "天" }),
    // 开始日期/月份
    el("span", { class: "loop-label loop-label-gap", text: lc.granularity === "month" ? "开始月份" : "开始日期" }), sInput
  );
  mergedRow.append(controls);
  wrap.append(mergedRow);

  // order —— 胶囊图标点击切换（Task 29）
  renderOrderSection(wrap, cfg, lc, rerender);

  // preview timeline
  wrap.append(el("div", { class: "field-label", style: "margin-top:10px", text: "循环执行预览" }));
  wrap.append(renderTimeline());
  return wrap;
}

function renderOrderSection(wrap: HTMLElement, cfg: any, lc: any, rerender: () => void) {
  // ★ 循环方案顺序：胶囊点击切换加入/退出序列；已激活胶囊支持左键长按拖拽排序（安卓式位移+吸附）
  const orderErr = el("span", { class: "inline-error" });
  wrap.append(el("div", { class: "field-label", style: "margin-top:8px" }, "循环方案顺序（点击胶囊切换，至少两个；已激活胶囊可长按拖拽排序）", orderErr));
  const orderList = el("div", { class: "order-pill-list" });

  // 已加入序列的：高亮胶囊（带序号），点击移出；长按拖拽排序
  lc.order.forEach((name: string, idx: number) => {
    const pill = el("button", {
      class: "order-pill in-sequence",
      title: `点击移出循环序列；长按可拖拽调整顺序`,
    });
    pill.append(el("span", { text: `${idx + 1}. ${name}` }));
    pill.dataset.index = String(idx);
    pill.dataset.name = name;
    pill.addEventListener("click", () => {
      if (suppressOrderClick) { suppressOrderClick = false; return; }
      if (lc.order.length <= 2) { showInlineError(orderErr, "循环至少需要 2 个方案"); return; }
      lc.order = lc.order.filter((n: string) => n !== name);
      saveConfig();
      rerender();
    });
    orderList.append(pill);
  });

  // 未加入序列的：普通胶囊，点击加入
  for (const p of cfg.plans) {
    if (!lc.order.includes(p.name)) {
      const pill = el("button", {
        class: "order-pill",
        text: p.name,
        title: `点击将「${p.name}」加入循环序列`,
      });
      pill.addEventListener("click", () => { lc.order.push(p.name); saveConfig(); rerender(); });
      orderList.append(pill);
    }
  }
  wrap.append(orderList);

  // 仅在已有 ≥2 个方案（可排序）时启用拖拽
  if (lc.order.length >= 2) enableReorder(orderList, lc.order, rerender);
}

// 模块级标志：拖拽结束后抑制紧随的 click（避免误触发"移除"）
let suppressOrderClick = false;

/**
 * 已激活循环方案胶囊：左键**长按**进入排序模式，之后拖动调整顺序。
 * 安卓式交互：长按进入 → 拖动时胶囊实时跟随指针、其他胶囊自动滑开让位（无回弹）→ 松手直接落位提交。
 * 整个移动限制在 .order-pill-list 区域内；未达长按即松开视为点击（移除），长按后松开则提交顺序。
 *
 * ★ 本版要点：
 *   1. 恢复 300ms 长按门槛进入排序（长按期间移动不取消计时）。
 *   2. 顺序方向与指针一致：鼠标向左拖→项目左移，向右拖→项目右移（上一版方向相反已修正）。
 *   3. computeTarget 改为 2D 阅读序（行优先）：支持顺序区自动换行后的正确插入。
 *   4. document 级安全网 pointerup：WebView2 指针捕获丢失时仍能落位。
 */
function enableReorder(listEl: HTMLElement, orderArr: string[], rerender: () => void) {
  const getPills = () => Array.from(listEl.querySelectorAll(".order-pill.in-sequence")) as HTMLElement[];
  let dragEl: HTMLElement | null = null;
  let pointerId = -1;
  let startX = 0, startY = 0;
  let lastX = 0, lastY = 0;
  let longTimer = 0;
  const LONGPRESS = 100;
  let active = false;            // 是否已进入排序（长按触发）
  let curIndex = -1;
  let grabDX = 0, grabDY = 0;    // 指针相对胶囊左上角的抓取偏移
  let restLeft = 0, restTop = 0; // 胶囊在文档流中的静止左上角
  let dragW = 0, dragH = 0;      // 胶囊尺寸缓存（拖拽期间不变）
  let listRect: DOMRect | null = null; // 容器 rect 缓存（窗口不变则不变）
  const SLIDE = "transform 300ms ease-out";

  /** 测量胶囊静止（无 transform）时的左上角，供跟随计算 */
  function measureRest() {
    if (!dragEl) return;
    const prev = dragEl.style.transform;
    dragEl.style.transform = "none";
    const r = dragEl.getBoundingClientRect();
    restLeft = r.left; restTop = r.top;
    dragEl.style.transform = prev;
  }

  /** 依据最新指针位置把胶囊定位到鼠标处（并钳制在容器内，且整体可见） */
  function applyTransform() {
    if (!dragEl) return;
    if (!listRect) listRect = listEl.getBoundingClientRect();
    let left = lastX - grabDX;
    let top = lastY - grabDY;
    left = Math.max(listRect.left, Math.min(listRect.right - dragW, left));
    top = Math.max(listRect.top, Math.min(listRect.bottom - dragH, top));
    dragEl.style.transform = `translate(${left - restLeft}px, ${top - restTop}px) scale(1.05)`;
  }

  /** 依据指针位置计算应插入的索引（行优先阅读序：上方行整体在前、同行按 X、下方行整体在后） */
  function computeTarget(): number {
    const pills = getPills();
    const tol = 6; // 同行判定容差（像素）
    let target = 0;
    for (const p of pills) {
      if (p === dragEl) continue;
      const r = p.getBoundingClientRect();
      const pcx = r.left + r.width / 2;
      const pcy = r.top + r.height / 2;
      // 顺序方向与指针一致：光标在胶囊中心左侧 → 该胶囊应在其后（before=false）
      const before = pcy < lastY - tol ? true     // 上方行：在前
                   : pcy > lastY + tol ? false     // 下方行：在后
                   : pcx < lastX;                  // 同行：按 X 比较
      if (before) target++;
    }
    return target;
  }

  /** 其他胶囊平滑滑开/合拢（FLIP 动画，无回弹） */
  function slideTo(target: number) {
    const inSeq = getPills();
    if (target === curIndex) return;
    if (target > curIndex) {
      listEl.insertBefore(dragEl!, inSeq[target].nextSibling);
    } else {
      listEl.insertBefore(dragEl!, inSeq[target]);
    }
    const others = getPills().filter((p) => p !== dragEl);
    const first = new Map<HTMLElement, DOMRect>();
    others.forEach((p) => first.set(p, p.getBoundingClientRect()));
    measureRest(); // dragEl 静止位已变，重测基准
    others.forEach((p) => {
      const last = p.getBoundingClientRect();
      const f = first.get(p)!;
      const dx = f.left - last.left;
      const dy = f.top - last.top;
      if (dx || dy) {
        p.style.transition = "none";
        p.style.transform = `translate(${dx}px, ${dy}px)`;
        requestAnimationFrame(() => {
          p.style.transition = SLIDE;
          p.style.transform = "";
        });
      }
    });
    curIndex = target;
    applyTransform(); // 用最新指针位置重设 transform，避免重排后跳变
  }

  let cleaned = false;
  function doCleanup() {
    if (cleaned) return;
    cleaned = true;
    window.clearTimeout(longTimer);
    try { dragEl?.releasePointerCapture(pointerId); } catch {}
    // ★ 关键：从 document 解绑 move/up/cancel，确保彻底移除监听（指针移出胶囊也不丢事件）
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    document.removeEventListener("pointerup", onUpDoc);
    document.body.style.userSelect = "";

    if (active) {
      active = false;
      const el = dragEl!;
      el.classList.remove("dragging");
      el.style.transition = "transform 150ms ease-out";
      el.style.transform = "translate(0,0) scale(1)";
      // 等 CSS 过渡完成后清除 inline style 并提交
      window.setTimeout(() => {
        el.style.transition = "";
        el.style.transform = "";
        commit();
      }, 160);
    } else if (dragEl) {
      // 纯点击未拖动：恢复胶囊原状，不提交、不抑制 click（由 click 处理移除）
      dragEl.classList.remove("dragging");
      dragEl.style.transition = "";
      dragEl.style.transform = "";
    }
    dragEl = null;
    listRect = null;
    // 延迟重置 cleaned 标志，允许下一次拖拽
    window.setTimeout(() => { cleaned = false; }, 200);
  }

  function commit() {
    const names = getPills().map((p) => p.dataset.name!);
    orderArr.length = 0;
    orderArr.push(...names);
    saveConfig();
    suppressOrderClick = true;
    window.setTimeout(() => { suppressOrderClick = false; }, 300);
    rerender();
  }

  function onMove(e: PointerEvent) {
    if (!dragEl) return;
    lastX = e.clientX; lastY = e.clientY;
    // 长按未触发前仅记录指针位置；进入排序后由 enterReorderMode 接管
    if (!active) return;
    e.preventDefault();
    measureRest();
    applyTransform();
    const target = computeTarget();
    if (target !== curIndex) slideTo(target);
  }

  function onUp() { window.clearTimeout(longTimer); doCleanup(); }
  function onUpDoc() { window.clearTimeout(longTimer); doCleanup(); }

  /** 长按触发：进入排序模式，记录抓取偏移与尺寸（用最近一次指针位置） */
  function enterReorderMode() {
    if (!dragEl) return;
    active = true;
    dragEl.classList.add("dragging");
    document.body.style.userSelect = "none";
    const r = dragEl.getBoundingClientRect();
    grabDX = lastX - r.left;
    grabDY = lastY - r.top;
    restLeft = r.left; restTop = r.top;
    dragW = dragEl.offsetWidth; dragH = dragEl.offsetHeight;
    listRect = listEl.getBoundingClientRect();
    curIndex = getPills().indexOf(dragEl);
    applyTransform(); // 立即吸附到指针位置（即使此刻暂停不移动）
  }

  getPills().forEach((pill, idx) => {
    pill.dataset.index = String(idx);
    pill.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      // 上次未清理干净时，强制清理后再开始新的拖拽
      if (active || dragEl) doCleanup();
      cleaned = false;
      dragEl = pill;
      startX = e.clientX; startY = e.clientY;
      lastX = e.clientX; lastY = e.clientY;
      pointerId = e.pointerId;
      // ★ 修复核心：监听挂在 document 上（而非胶囊本身），指针移出胶囊区域仍能稳定跟随。
      //    不再依赖 setPointerCapture（其在 insertBefore 重排时可能被隐式释放，导致胶囊不跟随）。
      document.addEventListener("pointermove", onMove, { passive: false });
      document.addEventListener("pointerup", onUp, { passive: false });
      document.addEventListener("pointercancel", onUp, { passive: false });
      document.addEventListener("pointerup", onUpDoc, { passive: false }); // 兜底落位
      // 300ms 长按进入排序（长按期间移动不取消计时）
      longTimer = window.setTimeout(enterReorderMode, LONGPRESS);
    });
  });
}

function renderTimeline(): HTMLElement {
  const cfg = store.cfg;
  const lc = cfg.loop_cfg;
  const tl = el("div", { class: "timeline" });
  if (lc.order.length === 0) return tl;
  const Y = lc.order.length;
  // 防御：确保 start 格式与 granularity 匹配（天需要YYYY-MM-DD，月需要YYYY-MM）
  let start = lc.granularity === "month" ? (lc.start || thisMonthStr()) : (lc.start || todayStr());
  if (lc.granularity === "day" && start.split("-").length < 3) start = todayStr();
  if (lc.granularity === "month" && start.split("-").length > 2) {
    const parts = start.split("-");
    start = parts[0] + "-" + parts[1]; // 截取年-月
  }
  const [sy, sm, sd] = start.split("-").map(Number);
  const today = lc.granularity === "month" ? thisMonthStr() : todayStr();

  // ★ 计算当前处于循环的第几个位置（与 store.computeLoopCurrent 同逻辑）
  let currentIndex = 0;
  {
    const now = new Date();
    if (lc.granularity === "month") {
      const totalStartMonths = (sy - 1) * 12 + (sm - 1);
      const totalNowMonths = (now.getFullYear() - 1) * 12 + now.getMonth();
      const elapsed = Math.floor((totalNowMonths - totalStartMonths) / Math.max(lc.interval, 1));
      currentIndex = ((elapsed % Y) + Y) % Y;
    } else {
      const startDate = new Date(sy, sm - 1, sd);
      const diffMs = now.getTime() - startDate.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      const elapsed = Math.floor(diffDays / Math.max(lc.interval, 1));
      currentIndex = ((elapsed % Y) + Y) % Y;
    }
  }

  // ★ 从当前位置开始渲染：第1张=当前执行方案，后续依次为下一个方案执行日期
  for (let step = 0; step < Y; step++) {
    const planIdx = (currentIndex + step) % Y;
    const planName = lc.order[planIdx];
    let dateLabel: string;
    let isToday = false;

    if (step === 0) {
      // 当前执行方案
      if (lc.granularity === "month") {
        const [cy, cm] = [sy + Math.floor((sm - 1 + currentIndex * lc.interval) / 12), ((sm - 1 + currentIndex * lc.interval) % 12) + 1];
        dateLabel = `${cy}年${cm}月`;
        isToday = `${cy}-${pad(cm)}` === today;
      } else {
        const d = new Date(sy, sm - 1, sd + currentIndex * lc.interval);
        dateLabel = `${d.getMonth() + 1}月${d.getDate()}日`;
        isToday = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` === today;
      }
      tl.append(node(dateLabel, planName, true, isToday)); // 当前：绿色环标记，无"· 当前"文字
    } else {
      // 未来方案
      if (lc.granularity === "month") {
        const absIndex = currentIndex + step;
        const total = (sy - 1) * 12 + (sm - 1) + absIndex * lc.interval;
        const yy = Math.floor(total / 12) + 1;
        const mm = (total % 12) + 1;
        dateLabel = `${yy}年${mm}月`;
        isToday = `${yy}-${pad(mm)}` === today;
        tl.append(node(dateLabel, planName, false, isToday));
      } else {
        const d = new Date(sy, sm - 1, sd + (currentIndex + step) * lc.interval);
        dateLabel = `${d.getMonth() + 1}月${d.getDate()}日`;
        const ds = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        isToday = ds === today;
        tl.append(node(dateLabel, planName, false, isToday));
      }
    }
    // 每个卡片之间（含当前）加右箭头，末尾接循环图标
    if (step < Y - 1) tl.append(el("span", { class: "tl-arrow", html: svgIcon("chevron-right").outerHTML }));
  }
  tl.append(el("span", { class: "tl-loop", html: svgIcon("rotate").outerHTML }));
  return tl;
}

/** 预览卡片：统一尺寸/样式、文字居中；当前方案用绿色环标记（不使用"· 当前"文字） */
function node(dateLabel: string, planName: string, isCurrent: boolean, isToday: boolean): HTMLElement {
  const n = el(
    "div",
    { class: "tl-node" + (isCurrent ? " active-now" : "") },
    el("div", { class: "tl-date", text: dateLabel }),
    el("div", { class: "tl-plan", text: planName })
  );
  if (isToday) n.dataset.today = "1";
  return n;
}
