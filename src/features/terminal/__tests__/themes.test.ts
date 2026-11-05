// 主题包验收：≥6 套，每套 16 色 + 前景/背景/光标/选区完整，切换即时生效。

import { describe, expect, it } from "vitest";

import { Terminal } from "@xterm/headless";
import {
  THEME_STORAGE_KEY,
  TERMINAL_THEMES,
  applyTheme,
  loadStoredThemeId,
  storeThemeId,
  themeById,
} from "../themes";

const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

describe("主题包", () => {
  it("至少 6 套，id 唯一", () => {
    expect(TERMINAL_THEMES.length).toBeGreaterThanOrEqual(6);
    const ids = new Set(TERMINAL_THEMES.map((t) => t.id));
    expect(ids.size).toBe(TERMINAL_THEMES.length);
  });

  it("每套都有 16 色与关键颜色", () => {
    for (const t of TERMINAL_THEMES) {
      for (const key of ANSI_KEYS) {
        expect(t.theme[key], `${t.id} 缺少 ${key}`).toMatch(/#[0-9a-fA-F]{6}/);
      }
      expect(t.theme.background).toMatch(/#[0-9a-fA-F]{6}/);
      expect(t.theme.foreground).toMatch(/#[0-9a-fA-F]{6}/);
      expect(t.theme.cursor).toMatch(/#[0-9a-fA-F]{6}/);
      expect(t.theme.selectionBackground).toMatch(/#[0-9a-fA-F]{6}/);
    }
  });

  it("未知 id 回退默认主题；applyTheme 写入 term.options.theme", () => {
    expect(themeById("nope").id).toBe(TERMINAL_THEMES[0].id);
    const term = new Terminal();
    const applied = applyTheme(term, "dracula");
    expect(applied.id).toBe("dracula");
    expect(term.options.theme?.background).toBe("#282a36");
    term.dispose();
  });

  it("主题 id 持久化与读取", () => {
    const store = new Map<string, string>();
    storeThemeId("nord", {
      setItem: (k, v) => void store.set(k, v),
    });
    expect(store.get(THEME_STORAGE_KEY)).toBe("nord");
    expect(
      loadStoredThemeId({ getItem: (k) => store.get(k) ?? null }),
    ).toBe("nord");
  });
});
