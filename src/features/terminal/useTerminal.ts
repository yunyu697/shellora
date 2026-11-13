// 终端渲染与 IPC 绑定：xterm + WebGL + addon 全接入（fit/unicode11/web-links/search/clipboard）。
// 数据帧按序写入并回 ack（归还 Rust 侧信用窗口），尺寸变化按 80ms 本地合并。

import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { ClipboardAddon, Base64, BrowserClipboardProvider } from "@xterm/addon-clipboard";
import "@xterm/xterm/css/xterm.css";

import {
  ackTerminal,
  closeTerminal,
  openTerminal,
  resizeTerminal,
  retryTerminal,
  sendInput,
} from "../../lib/ipc/commands";
import type {
  ConnStateDto,
  ConnStateEvent,
  ConnectionInput,
  StreamMsg,
} from "../../lib/ipc/types";
import { installControlHandlers } from "./controlHandlers";
import { detectPlatform, resolveKey } from "./keymap";
import { findLinks } from "./links";
import { normalizeSelection, wrapBracketedPaste } from "./pasteGuard";
import { applyTheme, themeById } from "./themes";
import type { CursorShape } from "./terminalControl";

export interface SearchResultEvent {
  resultIndex: number;
  resultCount: number;
}

export interface TerminalHandlers {
  onState: (state: ConnStateDto) => void;
  onTitle: (title: string) => void;
  onTabId: (tabId: string) => void;
  /** OSC 7 上报的远端 cwd（用于 SFTP 栏联动） */
  onCwd?: (cwd: string) => void;
  /** 剪贴板/快捷键产生的原文，由 UI 决定是否弹确认 */
  onPasteText?: (text: string) => void;
  /** DECSCUSR 光标形状变化 */
  onCursorShape?: (shape: CursorShape) => void;
  /** 搜索结果计数与当前索引 */
  onSearchResults?: (event: SearchResultEvent) => void;
  /** 链接点击（URL 交给浏览器，file:line 交给编辑器） */
  onOpenLink?: (uri: string, kind: "url" | "file") => void;
  /** WebGL 上下文丢失计数（M5 挂机验收观测点） */
  onWebglContextLost?: () => void;
  /** 每帧原始字节（性能自测用；正常路径不需要） */
  onBytes?: (bytes: Uint8Array, seq: number) => void;
}

export interface TerminalOptions {
  /** D4：标签数 > 8 后新开标签降为 5000 */
  scrollback?: number;
  themeId?: string;
  /** T12：选中即复制开关 */
  copyOnSelect?: boolean;
}

export interface TerminalApi {
  retry: () => void;
  focus: () => void;
  fit: () => void;
  send: (text: string) => void;
  size: () => { cols: number; rows: number } | null;
  /** 走粘贴保护后的最终发送（bracketed paste 自动包装） */
  paste: (text: string) => void;
  /** 复制当前选区，返回规范化后的文本 */
  copy: () => Promise<string>;
  getSelection: () => string;
  setTheme: (id: string) => void;
  findNext: (query: string, options?: ISearchOptions) => boolean;
  findPrevious: (query: string, options?: ISearchOptions) => boolean;
  clearSearch: () => void;
}

export function useTerminal(
  containerRef: RefObject<HTMLDivElement>,
  input: ConnectionInput,
  handlers: TerminalHandlers,
  options?: TerminalOptions,
): TerminalApi {
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const tabIdRef = useRef<string | null>(null);
  const inputRef = useRef(input);
  const handlersRef = useRef(handlers);
  const optionsRef = useRef(options);
  handlersRef.current = handlers;
  optionsRef.current = options;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const theme = themeById(optionsRef.current?.themeId);
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: 15,
      lineHeight: 1.35,
      cursorBlink: true,
      allowProposedApi: true,
      macOptionIsMeta: true,
      scrollback: optionsRef.current?.scrollback ?? 10000,
      theme: theme.theme,
    });
    termRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    fitRef.current = fit;
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";

    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;

    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault();
        handlersRef.current.onOpenLink?.(uri, "url");
      }),
    );

    // OSC 52 剪贴板读写；WebView 无 navigator.clipboard 时安静降级。
    try {
      term.loadAddon(new ClipboardAddon(new Base64(), new BrowserClipboardProvider()));
    } catch (err) {
      console.warn("clipboard addon 不可用", err);
    }

    term.open(container);

    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      term.loadAddon(webgl);
      webgl.onContextLoss(() => {
        handlersRef.current.onWebglContextLost?.();
        webgl?.dispose();
        webgl = null;
      });
    } catch (err) {
      console.warn("WebGL 不可用，降级为 DOM 渲染", err);
    }

    let disposed = false;
    let tabId: string | null = null;
    let unlisten: UnlistenFn | undefined;
    let resizeTimer: number | undefined;
    const buffered = new Map<string, ConnStateEvent>();
    const pending: Uint8Array[] = [];

    const ack = (bytes: Uint8Array) => {
      const id = tabId;
      if (!id) return;
      void ackTerminal(id, bytes.byteLength).catch(() => undefined);
    };

    const sendData = (data: string) => {
      const id = tabId;
      if (id) void sendInput(id, data).catch(() => undefined);
    };

    const copySelection = async (): Promise<string> => {
      const text = normalizeSelection(term.getSelection());
      if (!text) return "";
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        /* 无剪贴板权限时仍返回文本，由调用方处理 */
      }
      return text;
    };

    const onMessage = (msg: StreamMsg) => {
      switch (msg.k) {
        case "data": {
          const bytes = new Uint8Array(msg.b);
          handlersRef.current.onBytes?.(bytes, msg.seq);
          if (!tabId) {
            pending.push(bytes);
            return;
          }
          term.write(bytes, () => ack(bytes));
          return;
        }
        case "eof":
          term.write("\r\n\x1b[90m[远端已结束会话]\x1b[0m\r\n");
          return;
        case "title":
          handlersRef.current.onTitle(msg.s);
          return;
        default:
          return;
      }
    };

    const dataSub = term.onData((data) => sendData(data));

    // OSC 0/2 标题、OSC 7 cwd、DECSCUSR。
    const titleSub = term.onTitleChange((title) => handlersRef.current.onTitle(title));
    const control = installControlHandlers(term.parser, {
      onCwd: (cwd) => handlersRef.current.onCwd?.(cwd),
      onCursorShape: (shape) => handlersRef.current.onCursorShape?.(shape),
    });

    // `path/file.rs:42` 文件链接（URL 由 web-links addon 覆盖）。
    const linkProvider = term.registerLinkProvider({
      provideLinks: (lineNumber, callback) => {
        const line = term.buffer.active.getLine(lineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        const text = line.translateToString(true);
        const links = findLinks(text)
          .filter((l) => l.kind === "file")
          .map((l) => ({
            range: {
              start: { x: l.start + 1, y: lineNumber },
              end: { x: l.end + 1, y: lineNumber },
            },
            text: l.text,
            activate: () => handlersRef.current.onOpenLink?.(l.text, "file"),
          }));
        callback(links.length ? links : undefined);
      },
    });

    const selectionSub = term.onSelectionChange(() => {
      if (optionsRef.current?.copyOnSelect) void copySelection();
    });

    const platform = detectPlatform(
      typeof navigator !== "undefined" ? navigator.platform || navigator.userAgent : "",
    );
    term.attachCustomKeyEventHandler((ev) => {
      const action = resolveKey(ev, platform);
      switch (action.kind) {
        case "send":
          sendData(action.data);
          return false;
        case "copy":
          void copySelection();
          return false;
        case "paste":
          void navigator.clipboard
            ?.readText()
            .then((text) => handlersRef.current.onPasteText?.(text))
            .catch(() => undefined);
          return false;
        default:
          return true;
      }
    });

    const onPasteEvent = (ev: ClipboardEvent) => {
      const text = ev.clipboardData?.getData("text");
      if (!text) return;
      ev.preventDefault();
      ev.stopPropagation();
      handlersRef.current.onPasteText?.(text);
    };
    container.addEventListener("paste", onPasteEvent, true);

    const searchResultsSub = search.onDidChangeResults((event) =>
      handlersRef.current.onSearchResults?.(event),
    );

    const ro = new ResizeObserver(() => {
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        try {
          fit.fit();
        } catch {
          return;
        }
        const id = tabId;
        if (id) void resizeTerminal(id, term.cols, term.rows).catch(() => undefined);
      }, 80);
    });
    ro.observe(container);

    void (async () => {
      try {
        unlisten = await listen<ConnStateEvent>("conn_state", (ev) => {
          const p = ev.payload;
          if (!tabId) {
            buffered.set(p.tabId, p);
            return;
          }
          if (p.tabId === tabId) {
            handlersRef.current.onState({ state: p.state, reason: p.reason });
          }
        });
      } catch (err) {
        console.warn("监听 conn_state 失败", err);
      }

      // 等一帧，确保容器已完成布局再测量列宽。
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      try {
        fit.fit();
      } catch {
        /* 容器隐藏时测量失败，用默认 80x24 */
      }

      const base = inputRef.current;
      try {
        const { tabId: id } = await openTerminal(
          { ...base, cols: term.cols, rows: term.rows },
          onMessage,
        );
        if (disposed) {
          void closeTerminal(id).catch(() => undefined);
          return;
        }
        tabId = id;
        tabIdRef.current = id;
        handlersRef.current.onTabId(id);

        const early = buffered.get(id);
        if (early) handlersRef.current.onState({ state: early.state, reason: early.reason });

        for (const bytes of pending.splice(0)) term.write(bytes, () => ack(bytes));

        // 初次尺寸二次校准（字体加载后列数可能变化）。
        void resizeTerminal(id, term.cols, term.rows).catch(() => undefined);
        term.focus();
      } catch (err) {
        const dto = err as Partial<ConnStateDto> & { message?: string };
        handlersRef.current.onState({
          state: "failed",
          reason: dto.reason ?? dto.message ?? String(err),
        });
      }
    })();

    return () => {
      disposed = true;
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
      container.removeEventListener("paste", onPasteEvent, true);
      ro.disconnect();
      dataSub.dispose();
      titleSub.dispose();
      control.dispose();
      linkProvider.dispose();
      selectionSub.dispose();
      searchResultsSub.dispose();
      unlisten?.();
      const id = tabId;
      if (id) void closeTerminal(id).catch(() => undefined);
      webgl?.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      tabIdRef.current = null;
    };
  }, [containerRef]);

  return {
    retry: () => {
      const id = tabIdRef.current;
      if (!id) return;
      termRef.current?.reset();
      void retryTerminal(id).catch(() => undefined);
    },
    focus: () => termRef.current?.focus(),
    fit: () => {
      try {
        fitRef.current?.fit();
      } catch {
        /* 容器不可见时忽略 */
      }
    },
    send: (text: string) => {
      const id = tabIdRef.current;
      if (id) void sendInput(id, text).catch(() => undefined);
    },
    size: () => {
      const term = termRef.current;
      return term ? { cols: term.cols, rows: term.rows } : null;
    },
    paste: (text: string) => {
      const term = termRef.current;
      const id = tabIdRef.current;
      if (!term || !id) return;
      void sendInput(id, wrapBracketedPaste(text, term.modes.bracketedPasteMode)).catch(
        () => undefined,
      );
      term.focus();
    },
    copy: async () => {
      const term = termRef.current;
      if (!term) return "";
      const text = normalizeSelection(term.getSelection());
      if (!text) return "";
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        /* 忽略权限错误 */
      }
      return text;
    },
    getSelection: () => {
      const term = termRef.current;
      return term ? normalizeSelection(term.getSelection()) : "";
    },
    setTheme: (id: string) => {
      const term = termRef.current;
      if (term) applyTheme(term, id);
    },
    findNext: (query: string, opts?: ISearchOptions) =>
      searchRef.current?.findNext(query, opts) ?? false,
    findPrevious: (query: string, opts?: ISearchOptions) =>
      searchRef.current?.findPrevious(query, opts) ?? false,
    clearSearch: () => searchRef.current?.clearDecorations(),
  };
}
