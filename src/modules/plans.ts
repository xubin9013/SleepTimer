import { el, openModal, closeModal, toast, confirmModal, svgIcon } from "../ui";
import { store, saveConfig, getPlan, sortTimes } from "../store";
import { openTimePicker } from "../pickers";
import { api } from "../api";

const pad = (n: number) => String(n).padStart(2, "0");

// 「查看的方案」与当前执行方案（cfg.fixed_plan）解耦，持久化到 cfg.view_plan，
// 退出重开后仍记得上次查看的是哪个方案标签（胶囊）。

export function renderPlans(container: HTMLElement, rerender: () => void) {
  container.innerHTML = "";
  const cfg = store.cfg;
  const addBtn = el("button", { class: "btn btn-primary", onclick: () => openNewPlan(rerender) }, svgIcon("plus"), "新建方案");
  const head = el(
    "div",
    { class: "page-head", style: "display:flex;align-items:center;justify-content:space-between" },
    el(
      "div",
      {},
      el("h2", { class: "page-title", text: "方案管理" }),
      el("p", { class: "page-desc", text: "管理你的定时熄屏方案" })
    ),
    addBtn
  );
  container.append(head);

  if (cfg.plans.length === 0) {
    const empty = el(
      "div",
      { class: "empty" },
      el("div", { html: svgIcon("grid").outerHTML }),
      el("div", { class: "empty-title", text: "暂无方案" }),
      el("div", { class: "empty-desc", text: "点击上方的 + 按钮创建第一个熄屏时间方案" })
    );
    container.append(empty);
    return;
  }

  // plan tabs —— 仅切换「查看」的方案，不改变当前执行方案（pill/设置保持同步）
  if (cfg.view_plan == null || !getPlan(cfg.view_plan ?? "")) {
    cfg.view_plan = cfg.fixed_plan ?? cfg.plans[0]?.name ?? null;
  }
  const tabs = el("div", { class: "plan-tabs" });
  for (const p of cfg.plans) {
    const isActive = p.name === cfg.view_plan;
    const tab = el("div", { class: "plan-tab" + (isActive ? " active" : "") }, el("span", { text: p.name }));
    const x = el("button", { class: "tab-x", html: svgIcon("x").outerHTML, title: "删除方案" });
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      openDeletePlan(p.name, rerender);
    });
    tab.append(x);
    tab.addEventListener("click", () => {
      if (cfg.view_plan !== p.name) {
        cfg.view_plan = p.name;
        saveConfig();
        rerender();
      }
    });
    // 双击方案标签弹出重命名弹窗
    tab.addEventListener("dblclick", (e) => { e.stopPropagation(); openRenameDialog(p.name, rerender); });
    tabs.append(tab);
  }
  const addTab = el("button", { class: "plan-tab-add", html: svgIcon("plus").outerHTML, title: "新建方案" });
  addTab.addEventListener("click", () => openNewPlan(rerender));
  tabs.append(addTab);
  container.append(tabs);

  // 当前查看的方案卡片（与执行方案解耦）
  const plan = getPlan(cfg.view_plan ?? "");
  if (!plan) {
    container.append(el("div", { class: "empty" }, el("div", { class: "empty-title", text: "请选择一个方案" })));
    return;
  }
  const card = el("div", { class: "card" });

  // 方案名称行 + 添加时间按钮（同行右侧）
  const nameRow = el("div", { class: "plan-name-row" });
  const nameLabel = el("span", { class: "plan-name", text: plan.name, title: "双击重命名" });
  // 双击方案名称弹出重命名弹窗
  nameLabel.style.cursor = "pointer";
  nameLabel.addEventListener("dblclick", () => openRenameDialog(plan.name, rerender));
  const addTime = el("button", { class: "btn btn-secondary btn-sm", onclick: () => openTimePicker(null).then((v) => {
    if (v == null) return;
    if (plan.times.includes(v)) { toast("该时间点已存在", "error"); return; }
    plan.times.push(v);
    plan.times = sortTimes(plan.times);
    saveConfig();
    rerender();
  }) });
  addTime.append(svgIcon("plus"), document.createTextNode("添加时间"));
  nameRow.append(nameLabel, addTime);
  card.append(nameRow);

  const sub = el("p", { class: "card-desc", text: `共 ${plan.times.length} 个熄屏时间点，单击时间可修改` });
  card.append(sub);

  const pills = el("div", { class: "time-pills" });
  const sorted = sortTimes(plan.times);
  if (sorted.length === 0) {
    pills.append(el("span", { class: "card-desc", text: "尚未添加时间点" }));
  }
  for (const t of sorted) {
    const pill = el("div", { class: "time-pill", text: t });
    const px = el("span", { class: "pill-x", html: svgIcon("x").outerHTML });
    px.addEventListener("click", (e) => {
      e.stopPropagation();
      plan.times = plan.times.filter((x) => x !== t);
      saveConfig();
      rerender();
    });
    pill.append(px);
    pill.addEventListener("click", () => openTimePicker(t).then((v) => {
      if (v == null) return;
      if (v !== t && plan.times.includes(v)) { toast("该时间点已存在", "error"); return; }
      plan.times = plan.times.filter((x) => x !== t);
      plan.times.push(v);
      plan.times = sortTimes(plan.times);
      saveConfig();
      rerender();
    }));
    pills.append(pill);
  }
  card.append(pills);
  container.append(card);
}

function openRenameDialog(oldName: string, rerender: () => void) {
  const input = el("input", { class: "input", value: oldName, maxlength: 10 }) as HTMLInputElement;
  const errEl = el("div", { class: "input-error-text", style: "display:none" });
  const body = el("div", { class: "modal-body" }, input, errEl);
  const showErr = (msg: string) => { input.classList.add("error"); errEl.textContent = msg; errEl.style.display = "block"; };
  const clearErr = () => { input.classList.remove("error"); errEl.textContent = ""; errEl.style.display = "none"; };
  input.focus(); input.select();
  const submit = () => {
    const v = input.value.trim().slice(0, 10);
    if (v === oldName) { closeModal(); return; }
    if (v.length === 0) { showErr("方案名称不能为空"); return; }
    if (store.cfg.plans.some((p) => p.name === v)) { showErr("方案名称已存在"); return; }
    clearErr();
    const plan = getPlan(oldName)!;
    plan.name = v;
    if (store.cfg.fixed_plan === oldName) store.cfg.fixed_plan = v;
    if (store.cfg.view_plan === oldName) store.cfg.view_plan = v;
    const i = store.cfg.loop_cfg.order.indexOf(oldName);
    if (i >= 0) store.cfg.loop_cfg.order[i] = v;
    saveConfig();
    closeModal();
    rerender();
  };
  const ctrl = openModal({
    title: "修改方案名称",
    desc: "修改方案的显示名称",
    body,
    actions: [{ label: "确认修改", cls: "btn-primary", onClick: submit }],
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); else if (e.key === "Escape") closeModal(); });
  input.addEventListener("input", () => { if (input.value.trim().length > 0 && input.classList.contains("error")) clearErr(); });
}

function openNewPlan(rerender: () => void) {
  const input = el("input", { class: "input", placeholder: "输入方案名称（最多10字符）", maxlength: 10 }) as HTMLInputElement;
  const errEl = el("div", { class: "input-error-text", style: "display:none" });
  const body = el("div", { class: "modal-body" }, input, errEl);
  const showErr = (msg: string) => {
    input.classList.add("error");
    errEl.textContent = msg;
    errEl.style.display = "block";
  };
  const clearErr = () => {
    input.classList.remove("error");
    errEl.textContent = "";
    errEl.style.display = "none";
  };
  const submit = () => {
    const v = input.value.trim().slice(0, 10);
    if (v.length === 0) { showErr("方案名称不能为空"); return; }
    if (store.cfg.plans.some((p) => p.name === v)) { showErr("方案名称已存在"); return; }
    clearErr();
    store.cfg.plans.push({ name: v, times: [] });
    store.cfg.fixed_plan = v;
    store.cfg.view_plan = v;
    saveConfig();
    closeModal();
    rerender();
  };
  const ctrl = openModal({
    title: "新建方案",
    desc: "创建一个新的熄屏时间方案，稍后可向方案中添加时间点",
    body,
    actions: [{ label: "创建方案", cls: "btn-primary", onClick: submit }],
  });
  input.addEventListener("input", () => { if (input.value.length > 0) clearErr(); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
}

function openDeletePlan(name: string, rerender: () => void) {
  const cfg = store.cfg;
  const inLoop = cfg.loop_cfg.order.includes(name);
  const isCurrent = cfg.fixed_plan === name;
  let desc = `确定要删除方案「${name}」吗？`;
  if (inLoop) desc = `已添加到循环序列，删除后将从循环中移除。确定要删除吗？`;
  if (isCurrent) desc = `是当前执行方案，删除后将自动切换执行方案。确定要删除吗？`;
  confirmModal({
    title: "删除确认",
    desc,
    dangerName: name,
    confirmLabel: "确认删除",
    onConfirm: () => {
      cfg.plans = cfg.plans.filter((p) => p.name !== name);
      cfg.loop_cfg.order = cfg.loop_cfg.order.filter((p) => p !== name);
      if (cfg.fixed_plan === name) {
        cfg.fixed_plan = cfg.plans[0]?.name ?? null;
      }
      if (store.cfg.view_plan === name) {
        store.cfg.view_plan = cfg.fixed_plan ?? cfg.plans[0]?.name ?? null;
      }
      if (cfg.plans.length < 2) {
        cfg.loop_cfg.enabled = false;
        cfg.loop_cfg.order = [];
      }
      saveConfig();
      rerender();
    },
  });
}
