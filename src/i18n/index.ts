// 轻量 i18n：以中文原文为 key（gettext 风格），避免另造一套键名与译文脱节。
// 只有 zh-CN 直接用原文；其余语种查表，缺词时回落英文，再回落原文。
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import en from "./locales/en";
import zhTW from "./locales/zh-TW";
import ja from "./locales/ja";
import es from "./locales/es";

export type Locale = "zh-CN" | "zh-TW" | "en" | "ja" | "es";
export type LocaleMode = "system" | Locale;
export type Vars = Record<string, string | number>;

export const LOCALES: { id: Locale; label: string; native: string }[] = [
  { id: "zh-CN", label: "简体中文", native: "简体中文" },
  { id: "zh-TW", label: "繁體中文", native: "繁體中文" },
  { id: "en", label: "English", native: "English" },
  { id: "ja", label: "日本語", native: "日本語" },
  { id: "es", label: "Español", native: "Español" },
];

const STORAGE_KEY = "shellora.locale";
const dicts: Record<Exclude<Locale, "zh-CN">, Record<string, string>> = {
  "zh-TW": zhTW,
  en,
  ja,
  es,
};

/** 把系统语言标签归一化；不支持时返回 null，由调用方回落英语。 */
export function normalizeLocale(tag: string | undefined | null): Locale | null {
  if (!tag) return null;
  const t = tag.toLowerCase().replace("_", "-");
  if (t.startsWith("zh")) return /hant|tw|hk|mo/.test(t) ? "zh-TW" : "zh-CN";
  if (t.startsWith("ja")) return "ja";
  if (t.startsWith("es")) return "es";
  if (t.startsWith("en")) return "en";
  return null;
}

export function systemLocale(): Locale {
  // 没有 navigator 说明不在浏览器里（单测 / Node 侧导入），按原文语言处理，保证确定性。
  if (typeof navigator === "undefined") return "zh-CN";
  const tags = navigator.languages ?? [navigator.language];
  for (const tag of tags) {
    const hit = normalizeLocale(tag);
    if (hit) return hit;
  }
  return "en";
}

function readMode(): LocaleMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "system") return "system";
    return normalizeLocale(saved) ?? "system";
  } catch {
    return "system";
  }
}

let mode: LocaleMode = readMode();
let locale: Locale = mode === "system" ? systemLocale() : mode;
const listeners = new Set<() => void>();

function applyDocumentLang() {
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}

export function getLocale(): Locale {
  return locale;
}

export function getLocaleMode(): LocaleMode {
  return mode;
}

function emit() {
  // 快照带上 mode：只改「跟随系统 ↔ 固定语种」而解析结果没变时，选择框也要刷新
  state = { locale, mode };
  for (const fn of listeners) fn();
}

/** 订阅快照：locale 变了要重渲染，mode 变了（哪怕 locale 相同）也要。 */
let state: { locale: Locale; mode: LocaleMode } = { locale, mode };

function syncRust() {
  // 原生托盘菜单/提示也要跟着切；Rust 侧失败不影响前端文案。
  // 非 Tauri 环境（单测、纯浏览器预览）没有 IPC，直接跳过。
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  void invoke("set_locale", { locale }).catch(() => undefined);
}

export function setLocaleMode(next: LocaleMode) {
  mode = next;
  locale = next === "system" ? systemLocale() : next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* 隐私模式写入失败时仅本次生效 */
  }
  applyDocumentLang();
  emit();
  syncRust();
}

/** 系统语言变化（例如用户改了 Windows 显示语言）时跟随。 */
export function refreshSystemLocale() {
  if (mode !== "system") return;
  const next = systemLocale();
  if (next === locale) return;
  locale = next;
  applyDocumentLang();
  emit();
  syncRust();
}

function interpolate(template: string, vars?: Vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (all, name) => (name in vars ? String(vars[name]) : all));
}

export function tr(key: string, vars?: Vars): string {
  if (locale === "zh-CN") return interpolate(key, vars);
  const hit = dicts[locale][key] ?? en[key];
  return interpolate(hit ?? key, vars);
}

export function useI18n() {
  const snapshot = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
  return { locale: snapshot.locale, mode: snapshot.mode, tr, setLocaleMode };
}

applyDocumentLang();
// 启动时把最终语种同步给 Rust，保证托盘菜单与界面一致（含「跟随系统」的检测结果）。
syncRust();

