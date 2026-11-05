// 终端主题包：≥6 套，全部显式给出 16 色与默认前景/背景，避免回退到浏览器默认色。

import type { ITheme, Terminal } from "@xterm/xterm";

export interface TerminalTheme {
  id: string;
  name: string;
  dark: boolean;
  theme: ITheme;
}

const DARK_ANSI = {
  black: "#1b1f27",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#dcdfe4",
  brightBlack: "#5c6370",
  brightRed: "#ff7b86",
  brightGreen: "#b5e890",
  brightYellow: "#ffd68a",
  brightBlue: "#7cc4ff",
  brightMagenta: "#e2a6f5",
  brightCyan: "#73d6e0",
  brightWhite: "#ffffff",
};

const LIGHT_ANSI = {
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#586e75",
  brightRed: "#cb4b16",
  brightGreen: "#6c71c4",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

export const TERMINAL_THEMES: TerminalTheme[] = [
  {
    id: "one-dark",
    name: "One Dark",
    dark: true,
    theme: {
      ...DARK_ANSI,
      background: "#0b0f14",
      foreground: "#d7dde5",
      cursor: "#7cc4ff",
      cursorAccent: "#0b0f14",
      selectionBackground: "#264f78",
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    dark: true,
    theme: {
      ...LIGHT_ANSI,
      background: "#002b36",
      foreground: "#839496",
      cursor: "#93a1a1",
      cursorAccent: "#002b36",
      selectionBackground: "#073642",
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    dark: false,
    theme: {
      ...LIGHT_ANSI,
      background: "#fdf6e3",
      foreground: "#657b83",
      cursor: "#586e75",
      cursorAccent: "#fdf6e3",
      selectionBackground: "#eee8d5",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    dark: true,
    theme: {
      ...DARK_ANSI,
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      cursorAccent: "#282a36",
      selectionBackground: "#44475a",
    },
  },
  {
    id: "nord",
    name: "Nord",
    dark: true,
    theme: {
      ...DARK_ANSI,
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#d08770",
      brightGreen: "#b9d3a0",
      brightYellow: "#f0d8a0",
      brightBlue: "#8fbcbb",
      brightMagenta: "#c9a3c4",
      brightCyan: "#9fd8e0",
      brightWhite: "#eceff4",
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#88c0d0",
      cursorAccent: "#2e3440",
      selectionBackground: "#434c5e",
    },
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    dark: true,
    theme: {
      ...DARK_ANSI,
      black: "#282828",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
      brightBlack: "#928374",
      brightRed: "#fb4934",
      brightGreen: "#b8bb26",
      brightYellow: "#fabd2f",
      brightBlue: "#83a598",
      brightMagenta: "#d3869b",
      brightCyan: "#8ec07c",
      brightWhite: "#ebdbb2",
      background: "#1d2021",
      foreground: "#ebdbb2",
      cursor: "#fabd2f",
      cursorAccent: "#1d2021",
      selectionBackground: "#504945",
    },
  },
  {
    id: "high-contrast",
    name: "High Contrast",
    dark: true,
    theme: {
      black: "#000000",
      red: "#ff4d4d",
      green: "#4dff88",
      yellow: "#ffff4d",
      blue: "#4da6ff",
      magenta: "#ff4dff",
      cyan: "#4dffff",
      white: "#ffffff",
      brightBlack: "#808080",
      brightRed: "#ff8080",
      brightGreen: "#80ffb0",
      brightYellow: "#ffff80",
      brightBlue: "#80c8ff",
      brightMagenta: "#ff80ff",
      brightCyan: "#80ffff",
      brightWhite: "#ffffff",
      background: "#000000",
      foreground: "#ffffff",
      cursor: "#ffff00",
      cursorAccent: "#000000",
      selectionBackground: "#0050a0",
    },
  },
];

export const DEFAULT_THEME_ID = "one-dark";
export const THEME_STORAGE_KEY = "shellora.theme";

export function themeById(id: string | null | undefined): TerminalTheme {
  return TERMINAL_THEMES.find((t) => t.id === id) ?? TERMINAL_THEMES[0];
}

export function loadStoredThemeId(storage?: Pick<Storage, "getItem"> | null): string {
  try {
    return themeById(storage?.getItem(THEME_STORAGE_KEY) ?? DEFAULT_THEME_ID).id;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function storeThemeId(id: string, storage?: Pick<Storage, "setItem"> | null): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, themeById(id).id);
  } catch {
    /* 隐私模式/配额失败不影响使用 */
  }
}

export function applyTheme(term: Pick<Terminal, "options">, id: string): TerminalTheme {
  const next = themeById(id);
  term.options.theme = next.theme;
  return next;
}
