// 界面主题（浅色 / 深色）：只切换 CSS 令牌，不触碰任何业务状态。
// 令牌定义见 styles/base.css；浅色取值来自设计稿 02-dualpane。

export type UiTheme = "light" | "dark";

export const UI_THEME_KEY = "shellora.uiTheme";

export function loadUiTheme(storage?: Pick<Storage, "getItem"> | null): UiTheme {
  try {
    const raw = storage?.getItem(UI_THEME_KEY);
    if (raw === "dark" || raw === "light") return raw;
  } catch {
    /* 隐私模式忽略 */
  }
  return "light";
}

export function applyUiTheme(theme: UiTheme, root: HTMLElement = document.documentElement): void {
  root.setAttribute("data-theme", theme);
  root.style.colorScheme = theme;
}

export function storeUiTheme(theme: UiTheme, storage: Storage = window.localStorage): void {
  try {
    storage.setItem(UI_THEME_KEY, theme);
  } catch {
    /* 配额/隐私模式忽略 */
  }
}

/** 读取当前主题令牌，供 xterm 等无法使用 CSS 变量的渲染层使用。 */
export function readToken(name: string, fallback = ""): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}
