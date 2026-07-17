import { el, openModal } from "./ui";
import { iconEl } from "./icons";

const pad = (n: number) => String(n).padStart(2, "0");

function makeWheel(
  max: number,
  initial: number,
  onChange: (v: number) => void
): { col: HTMLElement; getVal: () => number; setVal: (v: number) => void; initScroll: () => void } {
  const col = el("div", { class: "picker-col" });
  const reps = 7;
  const mid = Math.floor(reps / 2);
  const items: number[] = [];
  for (let r = 0; r < reps; r++) for (let i = 0; i < max; i++) items.push(i);

  // 上方填充：保证初始位置上方有数据可见
  const topPad = el("div", { style: "height:76px" });
  col.append(topPad);

  const itemEls: HTMLElement[] = [];
  for (const v of items) {
    const it = el("div", { class: "item", text: pad(v) });
    // ★ 点击条目直接定位选中该值（精确选择，避免滚轮跳格）
    it.addEventListener("click", () => setVal(v));
    itemEls.push(it);
    col.append(it);
  }

  // 下方填充
  col.append(el("div", { style: "height:76px" }));

  const itemH = 38;
  let selected = initial;

  const highlight = (val: number) => {
    itemEls.forEach((it, idx) => it.classList.toggle("selected", items[idx] === val));
  };
  const setScroll = (val: number, smooth: boolean) => {
    if (!smooth) {
      // 非平滑（初始化 / 程序定位）：直接落到中段基准位，保证上下都有可循环数据
      col.scrollTop = (mid * max + val) * itemH;
      return;
    }
    // 平滑滚动：取「离当前位置最近的、值为 val 的格子」，走圆环最短路径。
    // 否则 00↔59 / 0↔23 这类跨零点会滚过整列（转一整圈），而实际上相邻 rep 里 00 上方就是 59，只差一格。
    const cur = col.scrollTop / itemH;
    const anchor = mid * max + val;
    const steps = Math.round((anchor - cur) / max);
    let target = anchor - steps * max;
    // 兜底：确保落入渲染区间 [0, reps*max-1]
    if (target < 0) target += max;
    if (target > reps * max - 1) target -= max;
    col.scrollTo({ top: target * itemH, behavior: "smooth" });
  };
  highlight(selected);
  // 初始滚动必须在元素挂载到 DOM 之后执行，否则 scrollTop 不生效（脱离文档的元素 scrollTo 无效）
  const initScroll = () => {
    setScroll(selected, false);
    highlight(selected);
  };

  const setVal = (v: number) => {
    selected = v;
    setScroll(v, true);
    highlight(v);
  };

  let t: number;
  col.addEventListener("scroll", () => {
    window.clearTimeout(t);
    t = window.setTimeout(() => {
      const raw = Math.round(col.scrollTop / itemH);
      const val = ((raw % max) + max) % max;
      highlight(val);
      selected = val;
      const target = mid * max + val;
      if (raw < max || raw > (reps - 1) * max) col.scrollTop = target * itemH;
      onChange(val);
    }, 70);
  });

  // ★ 滚轮单步增减：拦截原生滚动，每次仅移动 1 格，便于精确定位
  col.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      e.preventDefault();
      const dir = e.deltaY > 0 ? 1 : -1;
      setVal(((selected + dir) % max + max) % max);
    },
    { passive: false }
  );

  return {
    col,
    getVal: () => selected,
    setVal,
    initScroll,
  };
}

export function openTimePicker(initial: string | null): Promise<string | null> {
  return new Promise((resolve) => {
    const now = new Date();
    // 添加时间默认从 00:00:00 开始；修改时间沿用已有值
    const init = initial ? initial.split(":").map(Number) : [0, 0, 0];
    const h = makeWheel(24, init[0], () => {});
    const m = makeWheel(60, init[1], () => {});
    const s = makeWheel(60, init[2], () => {});

    const cols = el("div", { class: "picker-cols" }, h.col, m.col, s.col);
    const head = el(
      "div",
      { class: "picker-head" },
      el("span", { text: "时" }),
      el("span", { text: "分" }),
      el("span", { text: "秒" })
    );

    // 此刻按钮 + 确定按钮放在 body 内（不再通过 openModal actions 重复生成）
    const confirm = () => {
      confirmed = true;
      const val = `${pad(h.getVal())}:${pad(m.getVal())}:${pad(s.getVal())}`;
      ctrl.close();
      resolve(val);
    };

    const foot = el(
      "div",
      { class: "picker-foot" },
      el("button", {
        class: "btn btn-secondary",
        text: "此刻",
        onclick: () => {
          const d = new Date();
          h.setVal(d.getHours());
          m.setVal(d.getMinutes());
          s.setVal(d.getSeconds());
        },
      }),
      el("button", { class: "btn btn-primary", text: "确定", onclick: confirm })
    );

    const body = el("div", { class: "modal-body" }, head, cols, foot);

    let confirmed = false;
    const ctrl = openModal({
      title: initial ? "修改时间" : "添加时间",
      desc: initial ? "修改该熄屏时间点" : "为方案添加一个熄屏时间点",
      body,
      // 不再提供 actions，避免出现第二个确定按钮
      actions: [],
      onClose: () => {
        if (!confirmed) resolve(null);
      },
    });
    // 弹窗已挂载到 DOM，初始化三列滚动位置：
    // 确保 00 上下均有可循环数据，且选中值与界面显示完全一致（修复「看到 00 却返回当前时间」）
    requestAnimationFrame(() => {
      h.initScroll();
      m.initScroll();
      s.initScroll();
    });
  });
}

function yearSelect(current: number, onChange: (y: number) => void): HTMLSelectElement {
  const sel = el("select", { class: "year-select" }) as HTMLSelectElement;
  const y0 = 2000;
  const y1 = new Date().getFullYear() + 10;
  for (let y = y0; y <= y1; y++) {
    const o = el("option", { value: String(y), text: String(y) });
    if (y === current) (o as HTMLOptionElement).selected = true;
    sel.append(o);
  }
  sel.addEventListener("change", () => onChange(Number(sel.value)));
  return sel;
}

export function openDatePicker(initial: string | null): Promise<string | null> {
  return new Promise((resolve) => {
    const today = new Date();
    const init = initial ? initial.split("-").map(Number) : [today.getFullYear(), today.getMonth() + 1, today.getDate()];
    let vy = init[0];
    let vm = init[1] - 1;
    let selected = initial ?? `${vy}-${pad(vm + 1)}-${pad(init[2])}`;

    const grid = el("div", { class: "cal-grid" });
    const head = el("div", { class: "cal-head" });
    const body = el("div", { class: "modal-body" });

    const render = () => {
      head.innerHTML = "";
      const ysel = yearSelect(vy, (y) => {
        vy = y;
        render();
      });
      const left = el("button", { class: "cal-nav", html: iconEl("chevron-left").outerHTML, onclick: () => { vm--; if (vm < 0) { vm = 11; vy--; } render(); } });
      const right = el("button", { class: "cal-nav", html: iconEl("chevron-right").outerHTML, onclick: () => { vm++; if (vm > 11) { vm = 0; vy++; } render(); } });
      const isCurrentMonth = vy === today.getFullYear() && vm === today.getMonth();
      const todayBtn = el("button", { class: "cal-nav cal-nav-auto" + (isCurrentMonth ? " cal-nav-disabled" : ""), text: "今天", onclick: () => { vy = today.getFullYear(); vm = today.getMonth(); selected = `${vy}-${pad(vm + 1)}-${pad(today.getDate())}`; render(); } });
      // 布局：<  MM月  >  年份  今天
      head.append(left, el("span", { text: `${pad(vm + 1)}月`, style: "font-size:var(--text-base);font-weight:600;color:var(--gray-900);min-width:48px;text-align:center" }), right, ysel, todayBtn);

      grid.innerHTML = "";
      for (const d of ["一", "二", "三", "四", "五", "六", "日"]) grid.append(el("div", { class: "cal-dow", text: d }));
      const first = new Date(vy, vm, 1);
      const startOffset = (first.getDay() + 6) % 7;
      const daysInMonth = new Date(vy, vm + 1, 0).getDate();
      const prevDays = new Date(vy, vm, 0).getDate();
      for (let i = 0; i < startOffset; i++) {
        grid.append(el("button", { class: "cal-cell muted", text: String(prevDays - startOffset + 1 + i), disabled: "true" }));
      }
      for (let d = 1; d <= daysInMonth; d++) {
        const val = `${vy}-${pad(vm + 1)}-${pad(d)}`;
        const cell = el("button", { class: "cal-cell" + (val === selected ? " selected" : "") }, el("span", { text: String(d) }));
        // ★ 不再标记 today 边框和 badge，仅通过上方"今天"按钮识别
        cell.addEventListener("click", () => {
          selected = val;
          render();
        });
        grid.append(cell);
      }
      const total = startOffset + daysInMonth;
      const tail = (7 - (total % 7)) % 7;
      for (let i = 1; i <= tail; i++) grid.append(el("button", { class: "cal-cell muted", text: String(i), disabled: "true" }));
    };
    render();
    body.append(head, grid);

    let confirmed = false;
    const confirmFn = () => {
      confirmed = true;
      ctrl.close();
      resolve(selected);
    };
    const ctrl = openModal({
      title: "选择开始日期",
      body,
      actions: [{ label: "确定", cls: "btn-primary", onClick: confirmFn }],
      onClose: () => {
        if (!confirmed) resolve(null);
      },
    });
  });
}

export function openMonthPicker(initial: string | null): Promise<string | null> {
  return new Promise((resolve) => {
    const today = new Date();
    const init = initial ? initial.split("-").map(Number) : [today.getFullYear(), today.getMonth() + 1];
    let vy = init[0];
    let selected = initial ?? `${vy}-${pad(init[1])}`;

    const grid = el("div", { class: "month-grid" });
    const head = el("div", { class: "cal-head" });
    const body = el("div", { class: "modal-body" });

    const render = () => {
      head.innerHTML = "";
      const ysel = yearSelect(vy, (y) => {
        vy = y;
        render();
      });
      const isCurrentYear = vy === today.getFullYear();
      const curBtn = el("button", { class: "cal-nav cal-nav-auto" + (isCurrentYear ? " cal-nav-disabled" : ""), text: "本月", onclick: () => { vy = today.getFullYear(); selected = `${vy}-${pad(today.getMonth() + 1)}`; render(); } });
      head.append(ysel, curBtn);

      grid.innerHTML = "";
      for (let mo = 1; mo <= 12; mo++) {
        const val = `${vy}-${pad(mo)}`;
        const cell = el("button", { class: "month-cell" + (val === selected ? " selected" : "") , text: `${mo}月` });
        // ★ 不再标记本月 badge，仅通过上方"本月"按钮识别
        cell.addEventListener("click", () => {
          selected = val;
          render();
        });
        grid.append(cell);
      }
    };
    render();
    body.append(head, grid);

    let confirmed = false;
    const confirmFn = () => {
      confirmed = true;
      ctrl.close();
      resolve(selected);
    };
    const ctrl = openModal({
      title: "选择开始月份",
      body,
      sm: true,
      actions: [{ label: "确定", cls: "btn-primary", onClick: confirmFn }],
      onClose: () => {
        if (!confirmed) resolve(null);
      },
    });
  });
}
