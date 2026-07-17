import { iconEl } from "./icons";

type Child = Node | string | null | undefined | false;

export function el(
  tag: string,
  props: Record<string, any> = {},
  ...children: Child[]
): HTMLElement {
  const e = document.createElement(tag);
  for (const k in props) {
    const v = props[k];
    if (v == null) continue;
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k === "text") e.textContent = v;
    else if (k === "dataset") Object.assign(e.dataset, v);
    else if (k.startsWith("on") && typeof v === "function")
      e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    e.append(c);
  }
  return e;
}

export function svgIcon(name: string): SVGElement {
  return iconEl(name);
}

let activeModal: HTMLElement | null = null;

export interface ModalOptions {
  title?: string;
  desc?: string;
  body?: HTMLElement;
  actions?: {
    label: string;
    cls?: string;
    onClick?: () => void;
  }[];
  type?: "default" | "alert";
  dangerName?: string;
  wide?: boolean;
  sm?: boolean;
  closeOnOverlay?: boolean;
  onClose?: () => void;
}

export function openModal(opts: ModalOptions): { close: () => void; root: HTMLElement } {
  if (activeModal) activeModal.remove();
  const overlay = el("div", { class: "overlay" });
  const modal = el("div", {
    class: "modal" + (opts.wide ? " wide" : opts.sm ? " sm" : ""),
    role: "dialog",
    "aria-modal": "true",
  });

  if (opts.type === "alert") {
    modal.append(el("div", { class: "alert-icon", html: iconEl("alert-triangle").outerHTML }));
    if (opts.title) modal.append(el("div", { class: "modal-title", text: opts.title }));
    if (opts.dangerName) modal.append(el("div", { class: "danger-name", text: opts.dangerName }));
    if (opts.desc) modal.append(el("div", { class: "modal-desc", html: opts.desc }));
  } else {
    if (opts.title) modal.append(el("div", { class: "modal-title", text: opts.title }));
    if (opts.desc) modal.append(el("div", { class: "modal-desc", html: opts.desc }));
  }
  if (opts.body) modal.append(opts.body);
  const actions = el("div", { class: "modal-actions" + ((opts.actions?.length ?? 0) === 1 ? " modal-actions-center" : "") });
  for (const a of opts.actions ?? []) {
    const b = el("button", { class: "btn " + (a.cls ?? "btn-secondary"), text: a.label });
    b.addEventListener("click", () => a.onClick?.());
    actions.append(b);
  }
  if (actions.children.length) modal.append(actions);
  overlay.append(modal);
  document.body.append(overlay);
  activeModal = overlay;

  const close = () => {
    if (!overlay.isConnected) return;
    overlay.remove();
    if (activeModal === overlay) activeModal = null;
    opts.onClose?.();
  };
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay && (opts.closeOnOverlay ?? true)) close();
  });
  const focusable = modal.querySelector(
    "input, button, [tabindex]"
  ) as HTMLElement | null;
  setTimeout(() => focusable?.focus(), 30);
  (modal as any)._close = close;
  return { close, root: modal };
}

export function closeModal() {
  if (activeModal) {
    const m = activeModal.querySelector(".modal") as any;
    m?._close?.();
  }
}

export function modalOpen(): boolean {
  return activeModal != null;
}

export function toast(msg: string, type: "success" | "error" | "info" = "info") {
  let wrap = document.querySelector(".toast-wrap") as HTMLElement | null;
  if (!wrap) {
    wrap = el("div", { class: "toast-wrap" });
    document.body.append(wrap);
  }
  const t = el("div", { class: "toast " + type, text: msg });
  wrap.append(t);
  setTimeout(() => {
    t.style.opacity = "0";
    setTimeout(() => t.remove(), 220);
  }, 3000);
}

export function confirmModal(opts: {
  title: string;
  desc: string;
  dangerName?: string;
  confirmLabel?: string;
  onConfirm: () => void;
}) {
  // 将 dangerName 内嵌到 desc 中，避免独占一行
  const fullDesc = opts.dangerName
    ? `<span style="color:var(--danger-500);font-weight:500">${opts.dangerName}</span><br>${opts.desc}`
    : opts.desc;
  openModal({
    type: "alert",
    title: opts.title,
    desc: fullDesc,
    actions: [
      {
        label: opts.confirmLabel ?? "确认",
        cls: "btn-danger",
        onClick: () => {
          closeModal();
          opts.onConfirm();
        },
      },
    ],
    closeOnOverlay: true,
  });
}
