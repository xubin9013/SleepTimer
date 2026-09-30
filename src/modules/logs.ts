import { el, toast, confirmModal, svgIcon } from "../ui";
import { iconEl } from "../icons";
import { api, type LogRow, type RunLogRow, type OpLogRow } from "../api";

let tab: "off" | "op" | "run" = "off";
let page = 1;
let perPage = 10;

export function renderLogs(container: HTMLElement, _rerender: () => void) {
  container.innerHTML = "";
  const head = el(
    "div",
    { class: "page-head", style: "display:flex;align-items:center;justify-content:space-between" },
    el("div", {}, el("h2", { class: "page-title", text: "日志" }), el("p", { class: "page-desc", text: "熄屏记录、用户操作与程序运行日志" })),
    el(
      "div",
      { style: "display:flex;gap:8px" },
      el("button", { class: "btn btn-secondary", id: "refresh-btn", onclick: () => doRefresh(container, _rerender) }, svgIcon("refresh"), "刷新"),
      // 三个标签均支持清空：熄屏/操作/运行日志各按自身类型清空对应文件
      el("button", { class: "btn btn-ghost-danger", onclick: () => doClear(container, _rerender) }, "清空日志")
    )
  );
  container.append(head);

  // 三标签：熄屏日志 / 操作日志 / 运行日志
  const tabs = el("div", { class: "plan-tabs", style: "margin-bottom:var(--space-3)" });
  const defs: { key: "off" | "op" | "run"; label: string }[] = [
    { key: "off", label: "熄屏日志" },
    { key: "op", label: "操作日志" },
    { key: "run", label: "运行日志" },
  ];
  for (const d of defs) {
    const t = el("div", { class: "plan-tab" + (tab === d.key ? " active" : "") }, el("span", { text: d.label }));
    t.addEventListener("click", () => {
      if (tab !== d.key) {
        tab = d.key;
        page = 1;
        renderLogs(container, _rerender);
      }
    });
    tabs.append(t);
  }
  container.append(tabs);

  const content = el("div", { class: "card", id: "logs-card" }, el("div", { class: "card-desc", text: "加载中…" }));
  container.append(content);
  loadAndRender(content);
}

async function loadAndRender(card: HTMLElement) {
  if (tab === "off") {
    let rows: LogRow[] = [];
    try {
      rows = await api.readLogs();
    } catch {
      rows = [];
    }
    renderOffTable(card, rows);
  } else if (tab === "op") {
    let rows: OpLogRow[] = [];
    try {
      rows = await api.readOpLogs();
    } catch {
      rows = [];
    }
    renderOpTable(card, rows);
  } else {
    let rows: RunLogRow[] = [];
    try {
      rows = await api.readRunLogs();
    } catch {
      rows = [];
    }
    renderRunTable(card, rows);
  }
}

/* ---------- 熄屏日志 ---------- */

function renderOffTable(card: HTMLElement, rows: LogRow[]) {
  if (rows.length === 0) {
    card.innerHTML = "";
    card.append(
      el("div", { class: "empty" }, el("div", { html: iconEl("file-text").outerHTML }), el("div", { class: "empty-title", text: "暂无熄屏记录" }))
    );
    return;
  }
  const total = rows.length;
  const totalPages = perPage === 0 ? 1 : Math.max(1, Math.ceil(total / perPage));
  if (page > totalPages) page = totalPages;
  const startIdx = perPage === 0 ? 0 : (page - 1) * perPage;
  const endIdx = perPage === 0 ? total : startIdx + perPage;
  const pageRows = rows.slice(startIdx, endIdx);

  card.innerHTML = "";
  const table = el("table", { class: "table" });
  table.append(
    el(
      "thead",
      {},
      el("tr", {}, el("th", { text: "序号" }), el("th", { text: "时间" }), el("th", { text: "熄屏原因" }))
    )
  );
  const tbody = el("tbody", {});
  for (const r of pageRows) {
    // off.log 现已记录中文原因（手动/定时/循环），同时兼容旧版英文日志
    const badge =
      r.trigger === "手动" || r.trigger === "manual"
        ? el("span", { class: "badge badge-manual", text: "手动触发" })
        : r.trigger === "循环" || r.trigger === "loop"
        ? el("span", { class: "badge badge-timer", text: "循环触发" })
        : r.trigger === "定时" || r.trigger === "timer"
        ? el("span", { class: "badge badge-timer", text: "定时触发" })
        : el("span", { class: "badge badge-timer", text: r.trigger || "未知" });
    tbody.append(
      el(
        "tr",
        {},
        el("td", { text: String(r.id) }),
        el("td", { class: "mono", text: r.time }),
        el("td", {}, badge)
      )
    );
  }
  table.append(tbody);
  card.append(table);
  card.append(buildFoot(total, totalPages));
}

/* ---------- 操作日志（用户审计） ---------- */

function renderOpTable(card: HTMLElement, rows: OpLogRow[]) {
  if (rows.length === 0) {
    card.innerHTML = "";
    card.append(
      el("div", { class: "empty" }, el("div", { html: iconEl("file-text").outerHTML }), el("div", { class: "empty-title", text: "暂无操作记录" }))
    );
    return;
  }
  const total = rows.length;
  const totalPages = perPage === 0 ? 1 : Math.max(1, Math.ceil(total / perPage));
  if (page > totalPages) page = totalPages;
  const startIdx = perPage === 0 ? 0 : (page - 1) * perPage;
  const endIdx = perPage === 0 ? total : startIdx + perPage;
  const pageRows = rows.slice(startIdx, endIdx);

  card.innerHTML = "";
  const table = el("table", { class: "table" });
  table.append(
    el(
      "thead",
      {},
      el("tr", {}, el("th", { text: "序号" }), el("th", { text: "时间" }), el("th", { text: "操作" }), el("th", { text: "详情" }))
    )
  );
  const tbody = el("tbody", {});
  for (const r of pageRows) {
    tbody.append(
      el(
        "tr",
        {},
        el("td", { text: String(r.id) }),
        el("td", { class: "mono", text: r.time }),
        el("td", {}, el("span", { class: "badge badge-timer", text: r.action || "-" })),
        el("td", { class: "log-msg", text: r.detail || "" })
      )
    );
  }
  table.append(tbody);
  card.append(table);
  card.append(buildFoot(total, totalPages));
}

/* ---------- 运行日志 ---------- */

function renderRunTable(card: HTMLElement, rows: RunLogRow[]) {
  if (rows.length === 0) {
    card.innerHTML = "";
    card.append(
      el("div", { class: "empty" }, el("div", { html: iconEl("file-text").outerHTML }), el("div", { class: "empty-title", text: "暂无运行日志" }))
    );
    return;
  }
  const total = rows.length;
  const totalPages = perPage === 0 ? 1 : Math.max(1, Math.ceil(total / perPage));
  if (page > totalPages) page = totalPages;
  const startIdx = perPage === 0 ? 0 : (page - 1) * perPage;
  const endIdx = perPage === 0 ? total : startIdx + perPage;
  const pageRows = rows.slice(startIdx, endIdx);

  card.innerHTML = "";
  const table = el("table", { class: "table" });
  table.append(
    el(
      "thead",
      {},
      el("tr", {}, el("th", { text: "序号" }), el("th", { text: "时间" }), el("th", { text: "级别" }), el("th", { text: "内容" }))
    )
  );
  const tbody = el("tbody", {});
  for (const r of pageRows) {
    const lv = (r.level || "").toUpperCase();
    const badgeCls =
      lv === "ERROR" ? "badge badge-error" : lv === "WARN" ? "badge badge-manual" : lv === "INFO" ? "badge badge-timer" : "badge badge-debug";
    tbody.append(
      el(
        "tr",
        {},
        el("td", { text: String(r.id) }),
        el("td", { class: "mono", text: r.time }),
        el("td", {}, el("span", { class: badgeCls, text: lv || "-" })),
        // 内容：组件前缀 + 消息（长消息自动换行）
        el("td", { class: "mono log-msg", text: `[${r.component}] ${r.message}` })
      )
    );
  }
  table.append(tbody);
  card.append(table);
  card.append(buildFoot(total, totalPages));
}

/* ---------- 公共分页/操作 ---------- */

function buildFoot(total: number, totalPages: number): HTMLElement {
  const foot = el("div", { class: "table-foot" });
  const perSelect = el("select", { class: "dropdown-trigger" }) as HTMLSelectElement;
  for (const opt of [
    { v: 10, t: "10 条/页" },
    { v: 20, t: "20 条/页" },
    { v: 50, t: "50 条/页" },
    { v: 0, t: "全部" },
  ]) {
    const o = el("option", { value: String(opt.v), text: opt.t }) as HTMLOptionElement;
    if (opt.v === perPage) o.selected = true;
    perSelect.append(o);
  }
  perSelect.addEventListener("change", () => {
    perPage = parseInt(perSelect.value, 10);
    page = 1;
    const card = document.getElementById("logs-card");
    if (card) loadAndRender(card as HTMLElement);
  });

  foot.append(el("div", { class: "table-meta", text: `共 ${total} 条记录` }));

  const pager = el("div", { class: "pager" });
  const prev = el("button", { class: "btn", text: "上一页", onclick: () => { if (page > 1) { page--; const card = document.getElementById("logs-card"); if (card) loadAndRender(card as HTMLElement); } } }) as HTMLButtonElement;
  prev.disabled = page <= 1;
  pager.append(prev);
  if (perPage !== 0) {
    for (let p = 1; p <= totalPages; p++) {
      const b = el("button", { class: "btn" + (p === page ? " active" : ""), text: String(p), onclick: () => { page = p; const card = document.getElementById("logs-card"); if (card) loadAndRender(card as HTMLElement); } });
      pager.append(b);
    }
  }
  const next = el("button", { class: "btn", text: "下一页", onclick: () => { if (page < totalPages) { page++; const card = document.getElementById("logs-card"); if (card) loadAndRender(card as HTMLElement); } } }) as HTMLButtonElement;
  next.disabled = page >= totalPages;
  pager.append(next);
  foot.append(perSelect, pager);
  return foot;
}

async function doRefresh(container: HTMLElement, rerender: () => void) {
  const btn = document.getElementById("refresh-btn");
  if (btn) {
    const ic = btn.querySelector("svg");
    if (ic) ic.classList.add("spin");
  }
  page = 1;
  renderLogs(container, rerender);
}

function doClear(container: HTMLElement, rerender: () => void) {
  const kind: "screenoff" | "operation" | "sleeptimer" = tab === "off" ? "screenoff" : tab === "op" ? "operation" : "sleeptimer";
  const label = tab === "off" ? "熄屏日志" : tab === "op" ? "操作日志" : "运行日志";
  confirmModal({
    title: "清空日志",
    desc: `确定要清空所有${label}吗？此操作不可恢复。`,
    confirmLabel: "清空",
    onConfirm: async () => {
      await api.clearLogs(kind);
      api.logOperation("清空日志", label).catch(() => {});
      page = 1;
      renderLogs(container, rerender);
      toast(`${label}已清空`, "success");
    },
  });
}
