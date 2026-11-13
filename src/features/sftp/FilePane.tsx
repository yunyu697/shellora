import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, MouseEvent as ReactMouseEvent } from "react";

import { Icon } from "../../components/Icons";
import type { DirEntry } from "../../lib/ipc/types";
import { tr } from "../../i18n";

const ROW_H = 44;
const OVERSCAN = 4;

export type PaneSide = "local" | "remote";

interface Props {
  side: PaneSide;
  title: string;
  path: string;
  entries: DirEntry[];
  selected: Set<string>;
  loading: boolean;
  /** 远端分页完成后的总数；本地为已加载数。 */
  total?: number;
  note?: string | null;
  /** 远端会话未就绪时只展示占位态。 */
  idle?: boolean;
  idleHint?: string;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
  onSelect: (next: Set<string>) => void;
  onLoadMore?: () => void;
  onDragStart: (side: PaneSide, files: DirEntry[]) => void;
  onDropTarget: (side: PaneSide, dir: string) => void;
  /** 选中项一键上传/下载到对侧当前目录。 */
  onTransferSelected?: (side: PaneSide, items: DirEntry[]) => void;
  /** 行右键：在光标处打开操作菜单。 */
  onRowContextMenu?: (side: PaneSide, entry: DirEntry, x: number, y: number) => void;
}

interface Crumb {
  label: string;
  path: string;
}

interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  top: number;
  left: number;
  width: number;
  height: number;
  base: Set<string>;
}

function crumbs(path: string, side: PaneSide): Crumb[] {
  if (!path) return [];
  if (side === "remote" || path.startsWith("/")) {
    const parts = path.split("/").filter(Boolean);
    if (side === "remote") {
      const out: Crumb[] = [{ label: "/", path: "/" }];
      let acc = "";
      for (const part of parts) {
        acc += `/${part}`;
        out.push({ label: part, path: acc });
      }
      return out;
    }
  }
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const out: Crumb[] = [];
  let acc = "";
  parts.forEach((part, index) => {
    acc = index === 0 ? part : `${acc}\\${part}`;
    out.push({ label: part, path: index === 0 ? `${acc}\\` : acc });
  });
  return out;
}

function parentOf(path: string, side: PaneSide): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (idx < 0) return null;
  const parent = trimmed.slice(0, idx);
  if (parent === "") return side === "remote" ? "/" : "\\";
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent;
}

export function formatSize(size: number, isDir: boolean): string {
  if (isDir) return "—";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function formatMtime(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** 按后缀给出文件类型图标与色块，视觉分类与设计稿一致。 */
function fileKind(entry: DirEntry): { icon: string; tint: string } {
  if (entry.isDir) return { icon: "folder", tint: "tint-blue" };
  if (entry.isSymlink) return { icon: "network", tint: "tint-slate" };
  const name = entry.name.toLowerCase();
  if (/\.(zip|tar|tgz|gz|bz2|xz|7z|rar)$/.test(name)) return { icon: "archive", tint: "tint-violet" };
  if (/\.(png|jpg|jpeg|gif|webp|svg|ico)$/.test(name)) return { icon: "image", tint: "tint-amber" };
  if (/\.(md|txt|log)$/.test(name)) return { icon: "log", tint: "tint-teal" };
  if (/\.(js|ts|tsx|jsx|json|html|css|sh|py|rs|go|yml|yaml|toml)$/.test(name))
    return { icon: "code", tint: "tint-teal" };
  return { icon: "file", tint: "tint-slate" };
}

export function FilePane({
  side,
  title,
  path,
  entries,
  selected,
  loading,
  total,
  note,
  idle,
  idleHint,
  onNavigate,
  onRefresh,
  onSelect,
  onLoadMore,
  onDragStart,
  onDropTarget,
  onTransferSelected,
  onRowContextMenu,
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<string | null>(null);
  const dragPathsRef = useRef<Set<string>>(new Set());
  const historyRef = useRef<{ stack: string[]; index: number }>({ stack: [], index: -1 });

  const [height, setHeight] = useState(320);
  const [scrollTop, setScrollTop] = useState(0);
  const [dropDir, setDropDir] = useState<string | null>(null);
  const [paneDrop, setPaneDrop] = useState(false);
  const [dragging, setDragging] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const marqueeBaseRef = useRef<Set<string>>(new Set());
  const startRef = useRef<{ x: number; y: number; active: boolean } | null>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // 记录路径历史，供前进/后退按钮使用。
  useEffect(() => {
    if (!path) return;
    const h = historyRef.current;
    if (h.stack[h.index] === path) return;
    h.stack = h.stack.slice(0, h.index + 1);
    h.stack.push(path);
    h.index = h.stack.length - 1;
  }, [path]);

  const visible = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const count = Math.ceil(height / ROW_H) + OVERSCAN * 2;
    return { start, end: Math.min(entries.length, start + count) };
  }, [scrollTop, height, entries.length]);

  const breads = crumbs(path, side);
  const parent = parentOf(path, side);
  const canBack = historyRef.current.index > 0;
  const canForward = historyRef.current.index < historyRef.current.stack.length - 1;

  const goBack = () => {
    const h = historyRef.current;
    if (h.index <= 0) return;
    h.index -= 1;
    onNavigate(h.stack[h.index]);
  };

  const goForward = () => {
    const h = historyRef.current;
    if (h.index >= h.stack.length - 1) return;
    h.index += 1;
    onNavigate(h.stack[h.index]);
  };

  const clickRow = (ev: ReactMouseEvent, entry: DirEntry) => {
    if (ev.shiftKey && anchorRef.current) {
      const a = entries.findIndex((e) => e.path === anchorRef.current);
      const b = entries.findIndex((e) => e.path === entry.path);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const next = ev.metaKey || ev.ctrlKey ? new Set(selected) : new Set<string>();
        for (const item of entries.slice(lo, hi + 1)) next.add(item.path);
        onSelect(next);
        anchorRef.current = entry.path;
        return;
      }
    }
    if (ev.metaKey || ev.ctrlKey) {
      const next = new Set(selected);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      onSelect(next);
    } else {
      onSelect(new Set([entry.path]));
    }
    anchorRef.current = entry.path;
  };

  // 框选：从空白处按下开始，行矩形与选区相交即选中。
  const startMarquee = (ev: ReactMouseEvent<HTMLDivElement>) => {
    const target = ev.target as HTMLElement;
    if (target.closest(".frow")) return;
    if (ev.button !== 0) return;
    const box = bodyRef.current?.getBoundingClientRect();
    if (!box) return;
    const x = ev.clientX - box.left;
    const y = ev.clientY - box.top;
    marqueeBaseRef.current = ev.metaKey || ev.ctrlKey ? new Set(selected) : new Set();
    if (!ev.metaKey && !ev.ctrlKey) onSelect(new Set());
    startRef.current = { x, y, active: true };
    setMarquee({ x0: x, y0: y, x1: x, y1: y, top: y, left: x, width: 0, height: 0, base: marqueeBaseRef.current });
  };

  useEffect(() => {
    if (!marquee) return;
    const onMove = (ev: globalThis.MouseEvent) => {
      const start = startRef.current;
      const box = bodyRef.current?.getBoundingClientRect();
      if (!start || !start.active || !box) return;
      const x = Math.max(0, Math.min(box.width, ev.clientX - box.left));
      const y = Math.max(0, Math.min(box.height, ev.clientY - box.top));
      const left = Math.min(start.x, x);
      const top = Math.min(start.y, y);
      const width = Math.abs(x - start.x);
      const height = Math.abs(y - start.y);
      setMarquee((prev) =>
        prev ? { ...prev, x1: x, y1: y, top, left, width, height } : prev,
      );

      const scrolled = bodyRef.current?.scrollTop ?? 0;
      const y0 = top + scrolled;
      const y1 = top + height + scrolled;
      const first = Math.max(0, Math.floor(y0 / ROW_H));
      const last = Math.min(entries.length - 1, Math.floor(y1 / ROW_H));
      const next = new Set(marqueeBaseRef.current);
      for (let i = first; i <= last; i += 1) {
        const rowTop = i * ROW_H;
        const rowBottom = rowTop + ROW_H;
        if (rowBottom >= y0 && rowTop <= y1) next.add(entries[i].path);
      }
      onSelect(next);
    };
    const onUp = () => {
      startRef.current = null;
      setMarquee(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [marquee, entries, onSelect]);

  const startDrag = (ev: DragEvent, entry: DirEntry) => {
    const picked = selected.has(entry.path)
      ? entries.filter((e) => selected.has(e.path))
      : [entry];
    const items = picked.filter((e) => !e.isSymlink);
    if (items.length === 0) {
      ev.preventDefault();
      return;
    }
    dragPathsRef.current = new Set(items.map((i) => i.path));
    setDragging(dragPathsRef.current);
    onDragStart(side, items);
    ev.dataTransfer.effectAllowed = "copy";
    ev.dataTransfer.setData("text/plain", items.map((f) => f.path).join("\n"));
  };

  const endDrag = () => {
    dragPathsRef.current = new Set();
    setDragging(new Set());
    setDropDir(null);
    setPaneDrop(false);
  };

  const dropOnDir = (ev: DragEvent, dir: string) => {
    ev.preventDefault();
    ev.stopPropagation();
    setDropDir(null);
    setPaneDrop(false);
    onDropTarget(side, dir);
    endDrag();
  };

  const dropOnPane = (ev: DragEvent) => {
    ev.preventDefault();
    setPaneDrop(false);
    onDropTarget(side, path);
    endDrag();
  };

  const selectedCount = selected.size;

  return (
    <section
      className={paneDrop ? "fpanel drop" : "fpanel"}
      onDragEnter={(ev) => {
        if (ev.dataTransfer.types.includes("text/plain")) setPaneDrop(true);
      }}
      onDragOver={(ev) => {
        if (ev.dataTransfer.types.includes("text/plain")) ev.preventDefault();
      }}
      onDragLeave={(ev) => {
        if (!ev.currentTarget.contains(ev.relatedTarget as Node)) setPaneDrop(false);
      }}
    >
      <header className="fhead">
        <span className="scope">{side === "local" ? "LOCAL" : "REMOTE"}</span>
        <span className="ttl">{title}</span>
        <span className="sub ell">{path || (side === "local" ? tr("此电脑") : "/")}</span>
        <span className="grow" />
        <button
          type="button"
          className="ib"
          disabled={!parent}
          onClick={() => parent && onNavigate(parent)}
          title={tr("上一级")}
        >
          <Icon name="chevronUp" />
        </button>
        <button type="button" className="ib" onClick={onRefresh} disabled={loading || idle} title={tr("刷新")}>
          <Icon name="refresh" />
        </button>
        <button type="button" className="ib" title={tr("更多")}>
          <Icon name="more" />
        </button>
      </header>

      <nav className="crumb2" aria-label={tr("{title}路径", { title })}>
        <button type="button" className="cb" onClick={goBack} disabled={!canBack} title={tr("后退")}>
          <Icon name="chevronLeft" />
        </button>
        <button type="button" className="cb" onClick={goForward} disabled={!canForward} title={tr("前进")}>
          <Icon name="chevronRight" />
        </button>
        <span className="sep">/</span>
        {breads.map((crumb) => (
          <span key={crumb.path} style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-1)" }}>
            <button
              type="button"
              className={crumb.path === path ? "c last" : "c"}
              onClick={() => onNavigate(crumb.path)}
            >
              {crumb.label}
            </button>
            {crumb.path === path ? null : <span className="sep">/</span>}
          </span>
        ))}
      </nav>

      {selectedCount > 0 ? (
        <div className="selbar">
          <b>
            {selectedCount} selected
          </b>
          <span className="num">
            {formatSize(
              entries.filter((e) => selected.has(e.path)).reduce((sum, e) => sum + e.size, 0),
              false,
            )}
          </span>
          <button
            type="button"
            className="abtn"
            onClick={() =>
              onTransferSelected?.(
                side,
                entries.filter((e) => selected.has(e.path)),
              )
            }
          >
            <Icon name={side === "local" ? "upload" : "download"} />
            {side === "local" ? "Upload" : "Download"}
          </button>
          <button type="button" className="x" aria-label={tr("清除选择")} onClick={() => onSelect(new Set())}>
            <Icon name="x" />
          </button>
        </div>
      ) : null}

      <div className="colrow">
        <span className="nm">{tr("名称")}</span>
        <span className="sz">{tr("大小")}</span>
        <span className="dt">{tr("修改时间")}</span>
      </div>

      {idle ? (
        <div className="empty2">
          <Icon name="server" />
          <b>{tr("远端会话未就绪")}</b>
          <span>{idleHint ?? tr("从会话库打开一个连接后，这里会显示远端目录。")}</span>
        </div>
      ) : (
        <div
          ref={bodyRef}
          className="flist"
          onMouseDown={startMarquee}
          onScroll={(ev) => {
            const el = ev.currentTarget;
            setScrollTop(el.scrollTop);
            if (onLoadMore && el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_H * 6) {
              onLoadMore();
            }
          }}
          onDragOver={(ev) => {
            if (ev.dataTransfer.types.includes("text/plain")) ev.preventDefault();
          }}
          onDragEnter={() => setPaneDrop(true)}
          onDrop={dropOnPane}
        >
          {entries.length === 0 && !loading ? (
            <p className="flist__empty">{tr("空目录")}</p>
          ) : (
            <div className="flist__inner" style={{ height: entries.length * ROW_H }}>
              {entries.slice(visible.start, visible.end).map((entry, offset) => {
                const index = visible.start + offset;
                const kind = fileKind(entry);
                const isSel = selected.has(entry.path);
                return (
                  <div
                    key={entry.path}
                    className={[
                      "frow",
                      entry.isDir ? "frow--dir" : "",
                      isSel ? "sel" : "",
                      dragging.has(entry.path) ? "dragging" : "",
                      dropDir === entry.path ? "dropline" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={{ top: index * ROW_H, height: ROW_H }}
                    title={entry.path}
                    onMouseDown={(ev) => ev.stopPropagation()}
                    onClick={(ev) => clickRow(ev, entry)}
                    onContextMenu={(ev) => {
                      ev.preventDefault();
                      if (!isSel) onSelect(new Set([entry.path]));
                      onRowContextMenu?.(side, entry, ev.clientX, ev.clientY);
                    }}
                    onDoubleClick={() => entry.isDir && onNavigate(entry.path)}
                    draggable={!entry.isSymlink}
                    onDragStart={(ev) => startDrag(ev, entry)}
                    onDragEnd={endDrag}
                    onDragOver={(ev) => {
                      if (entry.isDir) {
                        ev.preventDefault();
                        setDropDir(entry.path);
                      }
                    }}
                    onDragLeave={() => setDropDir((prev) => (prev === entry.path ? null : prev))}
                    onDrop={(ev) => entry.isDir && dropOnDir(ev, entry.path)}
                  >
                    <span className={isSel ? "chk on" : "chk"}>
                      {isSel ? <Icon name="check" /> : null}
                    </span>
                    <span className={`ftile ${kind.tint}`}>
                      <Icon name={kind.icon} />
                    </span>
                    <span className="nm">
                      <span>{entry.name}</span>
                    </span>
                    <span className="sz">{formatSize(entry.size, entry.isDir)}</span>
                    <span className="dt">{formatMtime(entry.mtime)}</span>
                  </div>
                );
              })}
            </div>
          )}
          {loading ? <div className="flist__loading">{tr("加载中…")}</div> : null}
          {marquee && marquee.width > 3 && marquee.height > 3 ? (
            <div
              className="marquee"
              style={{
                top: marquee.top,
                left: marquee.left,
                width: marquee.width,
                height: marquee.height,
              }}
            />
          ) : null}
        </div>
      )}

      {paneDrop ? (
        <span className="droplabel">
          <Icon name="copy" />
          {`Copy to ${path || "/"}`}
        </span>
      ) : null}

      {note ? <div className="fpane__note">{note}</div> : null}

      <footer className="ffoot">
        <span>{tr("{n} 项", { n: entries.length })}</span>
        <span className="grow" />
        <span className="num">
          {total !== undefined && total !== entries.length
            ? `${entries.length} / ${total}`
            : `${entries.length}`}
        </span>
        <span className="st">
          <span className={side === "remote" && idle ? "dot off" : "dot"} />
          {side === "remote" ? (idle ? tr("未连接") : "SFTP · 21 ms") : tr("本地磁盘")}
        </span>
      </footer>
    </section>
  );
}

