import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import type { ConnState, ConnStateDto, ConnectionInput } from "../../lib/ipc/types";
import { readToken } from "../../theme";
import { analyzePaste, type PasteAnalysis } from "./pasteGuard";
import { TERMINAL_THEMES, loadStoredThemeId, storeThemeId } from "./themes";
import { useTerminal, type SearchResultEvent } from "./useTerminal";

const STATE_LABEL: Record<ConnState, string> = {
  connecting: "连接中…",
  ready: "已连接",
  suspended: "已挂起",
  closed: "已断开",
  failed: "连接失败",
};

const COPY_ON_SELECT_KEY = "shellora.copyOnSelect";

/** 搜索高亮取自主题令牌，随浅色/深色切换，不在组件内写死颜色。 */
function searchDecorations() {
  const mute = readToken("--text-3");
  const active = readToken("--warning");
  return {
    matchBackground: readToken("--term-search-match"),
    matchBorder: mute,
    matchOverviewRuler: mute,
    activeMatchBackground: active,
    activeMatchBorder: active,
    activeMatchColorOverviewRuler: active,
  };
}

interface PendingPaste {
  text: string;
  analysis: PasteAnalysis;
}

interface Props {
  input: ConnectionInput;
  /** 非活动标签保持挂载与尺寸，仅隐藏，避免 fit 失效 */
  active: boolean;
  /** 从 1 开始，用于 D4 scrollback 降级 */
  tabIndex: number;
  onStateChange?: (state: ConnStateDto) => void;
  onTitleChange?: (title: string) => void;
  onTabId?: (tabId: string) => void;
  onOpenFiles?: () => void;
  /** OSC 7 上报的远端 cwd */
  onCwd?: (cwd: string) => void;
}

export function TerminalPane({
  input,
  active,
  tabIndex,
  onStateChange,
  onTitleChange,
  onTabId,
  onOpenFiles,
  onCwd,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ConnStateDto>({ state: "connecting", reason: null });
  const [title, setTitle] = useState(`SSH ${input.username}@${input.host}`);
  const [tabId, setTabId] = useState<string | null>(null);

  const [themeId, setThemeId] = useState(() => loadStoredThemeId(window.localStorage));
  const [copyOnSelect, setCopyOnSelect] = useState(() => {
    try {
      return window.localStorage.getItem(COPY_ON_SELECT_KEY) === "1";
    } catch {
      return false;
    }
  });

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<SearchResultEvent>({ resultIndex: -1, resultCount: 0 });
  const [pendingPaste, setPendingPaste] = useState<PendingPaste | null>(null);
  const [cursorShape, setCursorShape] = useState("block-blink");
  const [notice, setNotice] = useState<string | null>(null);

  const requestPaste = useCallback((text: string) => {
    if (!text) return;
    const analysis = analyzePaste(text);
    if (analysis.needsConfirm) {
      setPendingPaste({ text, analysis });
      return;
    }
    apiRef.current.paste(text);
  }, []);

  const api = useTerminal(
    hostRef,
    input,
    {
      onState: (next) => {
        setState(next);
        onStateChange?.(next);
      },
      onTitle: (next) => {
        setTitle(next);
        onTitleChange?.(next);
      },
      onTabId: (id) => {
        setTabId(id);
        onTabId?.(id);
      },
      onCwd: (cwd) => onCwd?.(cwd),
      onPasteText: requestPaste,
      onSearchResults: setResults,
      onCursorShape: (shape) => setCursorShape(`${shape.style}-${shape.blink ? "blink" : "steady"}`),
      onOpenLink: (uri, kind) => {
        if (kind === "url") {
          // 交给系统默认浏览器；插件不可用时退回 window.open。
          void openUrl(uri).catch(() => window.open(uri, "_blank", "noopener,noreferrer"));
          return;
        }
        void navigator.clipboard
          ?.writeText(uri)
          .then(() => setNotice(`已复制 ${uri}，请在编辑器中打开`))
          .catch(() => setNotice(`文件链接：${uri}`));
      },
    },
    { scrollback: tabIndex > 8 ? 5000 : 10000, themeId, copyOnSelect },
  );
  const apiRef = useRef(api);
  apiRef.current = api;

  // 切回标签后重新测量并聚焦（隐藏期间尺寸不变，ResizeObserver 不会触发）。
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      apiRef.current.fit();
      apiRef.current.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);

  useEffect(() => {
    apiRef.current.setTheme(themeId);
    storeThemeId(themeId, window.localStorage);
  }, [themeId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(COPY_ON_SELECT_KEY, copyOnSelect ? "1" : "0");
    } catch {
      /* 忽略配额/隐私模式错误 */
    }
  }, [copyOnSelect]);

  const runSearch = (backward: boolean) => {
    if (!query) return;
    const options = { caseSensitive, decorations: searchDecorations() };
    if (backward) apiRef.current.findPrevious(query, options);
    else apiRef.current.findNext(query, options);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    apiRef.current.clearSearch();
    apiRef.current.focus();
  };

  const confirmPaste = () => {
    if (pendingPaste) apiRef.current.paste(pendingPaste.text);
    setPendingPaste(null);
  };

  const canRetry = state.state === "failed" || state.state === "closed";
  const preview = pendingPaste
    ? pendingPaste.text.split(/\r\n|\r|\n/).slice(0, 4).join("\n")
    : "";

  return (
    <section
      className={active ? "pane pane--active" : "pane pane--hidden"}
      data-cursor-shape={cursorShape}
    >
      <header className="pane__bar">
        <span className={`dot dot--${state.state}`} aria-hidden />
        <span className="pane__title">{title}</span>
        <span className="pane__state">{STATE_LABEL[state.state]}</span>
        {state.reason ? <span className="pane__reason">{state.reason}</span> : null}
        <span className="pane__spacer" />
        <select
          className="pane__theme"
          aria-label="终端主题"
          value={themeId}
          onChange={(ev) => setThemeId(ev.target.value)}
        >
          {TERMINAL_THEMES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn--ghost"
          aria-pressed={searchOpen}
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
        >
          搜索
        </button>
        {tabId ? (
          <button type="button" className="btn btn--ghost" onClick={onOpenFiles}>
            文件
          </button>
        ) : null}
        {canRetry ? (
          <button type="button" className="btn btn--ghost" onClick={api.retry}>
            重连
          </button>
        ) : null}
      </header>

      {searchOpen ? (
        <div className="pane__search" role="search">
          <input
            className="pane__search-input"
            autoFocus
            placeholder="搜索缓冲区"
            value={query}
            onChange={(ev) => {
              setQuery(ev.target.value);
              if (ev.target.value) {
                apiRef.current.findNext(ev.target.value, {
                  caseSensitive,
                  incremental: true,
                  decorations: searchDecorations(),
                });
              } else {
                apiRef.current.clearSearch();
                setResults({ resultIndex: -1, resultCount: 0 });
              }
            }}
            onKeyDown={(ev) => {
              if (ev.key === "Enter") {
                ev.preventDefault();
                runSearch(Boolean(ev.shiftKey));
              } else if (ev.key === "Escape") {
                ev.preventDefault();
                closeSearch();
              }
            }}
          />
          <span className="pane__search-count">
            {results.resultCount > 0 ? `${results.resultIndex + 1}/${results.resultCount}` : "0/0"}
          </span>
          <button type="button" className="btn btn--ghost" onClick={() => runSearch(false)}>
            下一个
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => runSearch(true)}>
            上一个
          </button>
          <label className="pane__check">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(ev) => {
                setCaseSensitive(ev.target.checked);
                if (query) runSearch(false);
              }}
            />
            区分大小写
          </label>
          <label className="pane__check">
            <input
              type="checkbox"
              checked={copyOnSelect}
              onChange={(ev) => setCopyOnSelect(ev.target.checked)}
            />
            选中即复制
          </label>
        </div>
      ) : null}

      {notice ? (
        <div className="pane__notice">
          <span>{notice}</span>
          <button type="button" className="btn btn--ghost" onClick={() => setNotice(null)}>
            关闭
          </button>
        </div>
      ) : null}

      <div ref={hostRef} className="pane__term" />

      {pendingPaste ? (
        <div className="paste-guard" role="dialog" aria-modal="true" aria-label="粘贴确认">
          <div className="paste-guard__card">
            <h3 className="paste-guard__title">粘贴确认</h3>
            <p className="paste-guard__summary">{pendingPaste.analysis.summary}</p>
            <pre className="paste-guard__preview">{preview}</pre>
            <p className="paste-guard__hint">
              含换行的粘贴可能立即在多行 shell 或编辑器中执行，请确认内容来源可信。
            </p>
            <div className="paste-guard__actions">
              <button type="button" className="btn btn--ghost" onClick={() => setPendingPaste(null)}>
                取消
              </button>
              <button type="button" className="btn btn--primary" onClick={confirmPaste}>
                发送
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
