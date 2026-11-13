import { useCallback, useEffect, useRef, useState } from "react";

import { createPortal } from "react-dom";

import { Icon } from "../../components/Icons";
import {
  cancelRemoteDir,
  enqueueTransfers,
  enqueueTree,
  listLocalDir,
  listRemoteDir,
  localHome,
  localMkdir,
  localRemove,
  localRename,
  localStat,
  remoteMkdir,
  remoteRemove,
  remoteRename,
  transferCancel,
  transferCancelGroup,
  transferList,
  transferListGroups,
  transferPause,
  transferPauseGroup,
  transferResolve,
  transferResolveGroup,
  transferResume,
  transferResumeGroup,
} from "../../lib/ipc/commands";
import type {
  ConflictPolicy,
  DirEntry,
  DirListMsg,
  QueueMsg,
  TransferEnqueueItem,
  TransferGroup,
  TransferState,
  TransferTask,
  TreeOptions,
} from "../../lib/ipc/types";
import { FilePane, type PaneSide, formatSize } from "./FilePane";

const PAGE_SIZE = 500;

interface PaneState {
  path: string;
  entries: DirEntry[];
  offset: number;
  hasMore: boolean;
  loading: boolean;
  total?: number;
  note: string | null;
}

/** 待确认的递归入队（一次拖拽可能包含多个目录）。 */
interface TreePrompt {
  items: DirEntry[];
  direction: "upload" | "download";
  destDir: string;
}

/** 供右侧信息栏展示的汇总；仅用于界面呈现，不参与传输逻辑。 */
export interface SftpSummary {
  active: number;
  queued: number;
  done: number;
  mbps: number;
  current: { name: string; percent: number; mbps: number; eta: string } | null;
  recent: Array<{ name: string; size: number; direction: "upload" | "download" }>;
}

interface Props {
  tabId: string | null;
  label: string;
  /** 终端 OSC 7 上报的 cwd；为空则从 / 开始 */
  initialRemotePath?: string | null;
  onSummary?: (summary: SftpSummary) => void;
  onOpenTerminal?: () => void;
  /** 抽屉是否可见：可见时接管 F2 / Delete / Alt+N / Alt+U */
  active?: boolean;
}

function emptyPane(path: string): PaneState {
  return { path, entries: [], offset: 0, hasMore: false, loading: true, note: null };
}

function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  const dto = err as { message?: string; code?: string } | null | undefined;
  return dto?.message ?? dto?.code ?? String(err);
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function joinRemote(dir: string, name: string): string {
  if (!dir || dir === "/") return `/${name}`;
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function joinLocal(dir: string, name: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  if (dir.endsWith("\\") || dir.endsWith("/")) return `${dir}${name}`;
  return `${dir}${sep}${name}`;
}

/** 每个会话各自记住本机 / 远端浏览到的目录，切换标签互不干扰。 */
type StoredPaths = { local?: string; remote?: string };

function pathsKey(tabId: string | null): string {
  return `shellora.sftpPath.${tabId || "default"}`;
}

function readStoredPaths(tabId: string | null): StoredPaths {
  try {
    const raw = window.localStorage.getItem(pathsKey(tabId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoredPaths;
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoredPath(tabId: string | null, side: PaneSide, path: string): void {
  if (!path) return;
  try {
    const next = { ...readStoredPaths(tabId), [side]: path };
    window.localStorage.setItem(pathsKey(tabId), JSON.stringify(next));
  } catch {
    /* 隐私模式忽略 */
  }
}

function formatEta(secs: number | null): string {
  if (secs === null || !Number.isFinite(secs)) return "—";
  if (secs < 60) return `${Math.ceil(secs)}s`;
  return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
}

const STATE_LABEL: Record<TransferState, string> = {
  queued: "排队中",
  running: "传输中",
  paused: "已暂停",
  conflict: "目标已存在",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
  skipped: "已跳过",
};

const DEFAULT_TREE_OPTIONS: TreeOptions = {
  maxDepth: 10,
  maxFiles: 5000,
  createEmptyDirs: false,
  conflictPolicy: "ask",
};

export function SftpManager({
  tabId,
  label,
  initialRemotePath,
  onSummary,
  onOpenTerminal,
  active = false,
}: Props) {
  const [local, setLocal] = useState<PaneState>(() => emptyPane(""));
  const [remote, setRemote] = useState<PaneState>(() => emptyPane(initialRemotePath || "/"));
  const [selectedLocal, setSelectedLocal] = useState<Set<string>>(new Set());
  const [selectedRemote, setSelectedRemote] = useState<Set<string>>(new Set());
  const [tasks, setTasks] = useState<Record<string, TransferTask>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [groups, setGroups] = useState<Record<string, TransferGroup>>({});
  const [groupOrder, setGroupOrder] = useState<string[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  /** 抽屉里的传输队列折叠状态，跨会话记忆。 */
  const [queueOpen, setQueueOpen] = useState(() => {
    try {
      return localStorage.getItem("shellora.queueOpen") !== "0";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("shellora.queueOpen", queueOpen ? "1" : "0");
    } catch {
      // 隐私模式等写入失败时保持内存态即可
    }
  }, [queueOpen]);
  const [treePrompt, setTreePrompt] = useState<TreePrompt | null>(null);
  const [treeOptions, setTreeOptions] = useState<TreeOptions>(DEFAULT_TREE_OPTIONS);
  const [notice, setNotice] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [choice, setChoice] = useState<"overwrite" | "skip" | "rename">("overwrite");
  const [dismissedConflicts, setDismissedConflicts] = useState<Set<string>>(new Set());
  const [swapped, setSwapped] = useState(false);
  /** 抽屉里一次只看一侧：远端（默认）或本机，避免 420px 内并排挤成两半 */
  const [paneView, setPaneView] = useState<PaneSide>("remote");

  const listingRef = useRef<string>("");
  const remoteNavTabRef = useRef<string | null>(null);
  const remoteChannelRef = useRef<ReturnType<typeof listRemoteDir>["channel"] | null>(null);
  const queueChannelsRef = useRef<Array<ReturnType<typeof enqueueTransfers>["channel"]>>([]);
  const localSeqRef = useRef(0);
  const localMoreRef = useRef(false);
  const dragRef = useRef<{ side: PaneSide; files: DirEntry[] } | null>(null);

  const navigateLocal = useCallback((nextPath: string) => {
    const seq = ++localSeqRef.current;
    localMoreRef.current = false;
    setLocal(emptyPane(nextPath));
    void listLocalDir(nextPath, 0, PAGE_SIZE)
      .then((page) => {
        if (localSeqRef.current !== seq) return;
        setLocal({
          path: nextPath,
          entries: page.entries,
          offset: page.nextOffset,
          hasMore: page.hasMore,
          loading: false,
          note: null,
        });
        writeStoredPath(tabId, "local", nextPath);
      })
      .catch((err) => {
        if (localSeqRef.current !== seq) return;
        setLocal((prev) =>
          prev.path === nextPath ? { ...prev, loading: false, note: errorText(err) } : prev,
        );
      });
  }, [tabId]);

  const loadMoreLocal = useCallback(() => {
    if (localMoreRef.current || !local.hasMore || local.loading) return;
    localMoreRef.current = true;
    const seq = localSeqRef.current;
    const offset = local.offset;
    const path = local.path;
    setLocal((prev) => ({ ...prev, loading: true }));
    void listLocalDir(path, offset, PAGE_SIZE)
      .then((page) => {
        if (localSeqRef.current !== seq) return;
        setLocal((prev) => ({
          ...prev,
          entries: [...prev.entries, ...page.entries],
          offset: page.nextOffset,
          hasMore: page.hasMore,
          loading: false,
        }));
      })
      .catch((err) => {
        if (localSeqRef.current !== seq) return;
        setLocal((prev) => ({ ...prev, loading: false, note: errorText(err) }));
      })
      .finally(() => {
        localMoreRef.current = false;
      });
  }, [local.hasMore, local.loading, local.offset, local.path]);

  const navigateRemote = useCallback(
    (nextPath: string) => {
      if (!tabId) return;
      const previous = listingRef.current;
      if (previous) void cancelRemoteDir(previous);
      const id = crypto.randomUUID();
      listingRef.current = id;
      setRemote(emptyPane(nextPath));
      const { channel, done } = listRemoteDir(tabId, nextPath, id, (msg: DirListMsg) => {
        if (msg.listingId !== id) return;
        if (msg.k === "page") {
          setRemote((prev) =>
            prev.path !== nextPath
              ? prev
              : {
                  ...prev,
                  entries: [...prev.entries, ...msg.entries],
                  offset: prev.offset + msg.entries.length,
                },
          );
        } else if (msg.k === "done") {
          setRemote((prev) =>
            prev.path !== nextPath
              ? prev
              : { ...prev, loading: false, total: msg.total, note: null },
          );
          writeStoredPath(tabId, "remote", nextPath);
        } else {
          setRemote((prev) =>
            prev.path !== nextPath
              ? prev
              : { ...prev, loading: false, note: `${msg.code}: ${msg.message}` },
          );
        }
      });
      remoteChannelRef.current = channel;
      void done.catch((err) => {
        setRemote((prev) =>
          prev.path === nextPath ? { ...prev, loading: false, note: errorText(err) } : prev,
        );
      });
    },
    [tabId],
  );

  useEffect(() => {
    const stored = readStoredPaths(tabId).local;
    void localHome()
      .then((home) => navigateLocal(stored || home))
      .catch((err) => setLocal((prev) => ({ ...prev, loading: false, note: errorText(err) })));
  }, [navigateLocal, tabId]);

  // 仅在切换标签时对齐远端目录；终端后续 cd（OSC 7）不再打断用户在 SFTP 里的浏览。
  useEffect(() => {
    if (!tabId) {
      remoteNavTabRef.current = null;
      setRemote(emptyPane(initialRemotePath || "/"));
      return;
    }
    if (remoteNavTabRef.current === tabId) return;
    remoteNavTabRef.current = tabId;
    const stored = readStoredPaths(tabId).remote;
    navigateRemote(stored || initialRemotePath || "/");
  }, [navigateRemote, initialRemotePath, tabId]);

  useEffect(
    () => () => {
      if (listingRef.current) void cancelRemoteDir(listingRef.current);
    },
    [],
  );

  const applyTask = useCallback((task: TransferTask) => {
    setTasks((prev) => ({ ...prev, [task.id]: task }));
    setOrder((prev) => (prev.includes(task.id) ? prev : [...prev, task.id]));
  }, []);

  const applyGroup = useCallback((group: TransferGroup) => {
    setGroups((prev) => ({ ...prev, [group.id]: group }));
    setGroupOrder((prev) => (prev.includes(group.id) ? prev : [...prev, group.id]));
  }, []);

  const onQueueMsg = useCallback(
    (msg: QueueMsg) => {
      if (msg.k === "update") applyTask(msg.task);
      else applyGroup(msg.group);
    },
    [applyTask, applyGroup],
  );

  const refreshQueue = useCallback(() => {
    void transferList()
      .then((list) => {
        const next: Record<string, TransferTask> = {};
        for (const task of list) next[task.id] = task;
        setTasks(next);
        setOrder(list.map((t) => t.id));
      })
      .catch((err) => setNotice(errorText(err)));
    void transferListGroups()
      .then((list) => {
        const next: Record<string, TransferGroup> = {};
        for (const group of list) next[group.id] = group;
        setGroups(next);
        setGroupOrder(list.map((g) => g.id));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshQueue();
  }, [refreshQueue]);

  const enqueue = useCallback(
    async (items: TransferEnqueueItem[]) => {
      if (items.length === 0) return;
      const { channel, done } = enqueueTransfers(items, onQueueMsg);
      queueChannelsRef.current.push(channel);
      try {
        const ids = await done;
        setOrder((prev) => [...prev, ...ids.filter((id) => !prev.includes(id))]);
        setNotice(`已入队 ${ids.length} 个任务（默认并发 2）`);
      } catch (err) {
        setNotice(errorText(err));
      }
    },
    [onQueueMsg],
  );

  const onDragStart = (side: PaneSide, files: DirEntry[]) => {
    dragRef.current = { side, files };
  };

  const transferItems = (side: PaneSide, files: DirEntry[], targetDir: string) => {
    if (!tabId) {
      setNotice("远端会话未就绪：先打开一个连接");
      return;
    }
    const direction: "upload" | "download" = side === "local" ? "upload" : "download";
    const plain = files.filter((f) => !f.isDir);
    const dirs = files.filter((f) => f.isDir);

    if (plain.length > 0) {
      const items: TransferEnqueueItem[] = plain.map((file) =>
        direction === "upload"
          ? {
              direction,
              tabId,
              remotePath: joinRemote(targetDir, file.name),
              localPath: file.path,
            }
          : {
              direction,
              tabId,
              remotePath: file.path,
              localPath: joinLocal(targetDir, file.name),
            },
      );
      void enqueue(items);
    }

    if (dirs.length > 0) {
      setTreePrompt({ items: dirs, direction, destDir: targetDir });
    }
  };

  const onDropTarget = (targetSide: PaneSide, targetDir: string) => {
    const payload = dragRef.current;
    dragRef.current = null;
    if (!payload || payload.side === targetSide) return;
    transferItems(payload.side, payload.files, targetDir);
  };

  const onTransferSelected = (side: PaneSide, items: DirEntry[]) => {
    const target = side === "local" ? remote.path : local.path;
    if (target) transferItems(side, items, target);
  };

  // ---- 抽屉常驻操作行：上传 / 新建目录 / 下载 / 重命名 / 删除 ----
  const [editing, setEditing] = useState<
    { mode: "create" } | { mode: "rename"; entry: DirEntry } | null
  >(null);
  const [draft, setDraft] = useState("");
  const [opBusy, setOpBusy] = useState(false);

  const activePane = paneView === "remote" ? remote : local;
  const activeSelected = paneView === "remote" ? selectedRemote : selectedLocal;
  const selItems = activePane.entries.filter((e) => activeSelected.has(e.path));
  const singleSel = selItems.length === 1 ? selItems[0] : null;
  /** 新建/重命名对两栏都开放：远端要会话就绪，本机只要当前目录有效。 */
  const canCreate = !opBusy && !editing && (paneView === "remote" ? !!tabId : !!local.path);
  const canRename = canCreate && !!singleSel;
  /** 删除对两栏都开放：远端要会话就绪，本机只要当前目录有效。 */
  const canDelete =
    selItems.length > 0 && !opBusy && (paneView === "remote" ? !!tabId : !!local.path);

  const refreshActive = () => {
    if (paneView === "remote") navigateRemote(remote.path || "/");
    else navigateLocal(local.path);
  };

  const runOp = async (label: string, fn: () => Promise<void>) => {
    setOpBusy(true);
    try {
      await fn();
      setNotice(`${label}成功`);
      refreshActive();
    } catch (err) {
      setNotice(`${label}失败：${errorText(err)}`);
    } finally {
      setOpBusy(false);
    }
  };

  const startCreate = () => {
    setEditing({ mode: "create" });
    setDraft("新建目录");
  };

  const startRename = () => {
    if (!singleSel) return;
    setEditing({ mode: "rename", entry: singleSel });
    setDraft(singleSel.name);
  };

  const submitEdit = () => {
    const name = draft.trim();
    const current = editing;
    setEditing(null);
    setDraft("");
    if (!current || !name) return;
    if (paneView === "remote") {
      if (!tabId) return;
      const to = joinRemote(remote.path || "/", name);
      if (current.mode === "create") {
        void runOp("新建目录", () => remoteMkdir(tabId, to));
      } else if (to !== current.entry.path) {
        void runOp("重命名", () => remoteRename(tabId, current.entry.path, to));
      }
      return;
    }
    if (!local.path) return;
    const to = joinLocal(local.path, name);
    if (current.mode === "create") {
      void runOp("新建目录", () => localMkdir(to));
    } else if (to !== current.entry.path) {
      void runOp("重命名", () => localRename(current.entry.path, to));
    }
  };

  const cancelEdit = () => {
    setEditing(null);
    setDraft("");
  };

  const deleteSelected = () => {
    if (!canDelete) return;
    const remoteTab = paneView === "remote" ? tabId : null;
    if (paneView === "remote" && !remoteTab) return;
    const side = paneView === "remote" ? "远端" : "本机";
    const names = selItems.map((e) => e.name).join("、");
    const hint = selItems.some((e) => e.isDir) ? "\n\n目录必须为空才能删除。" : "";
    const extra =
      paneView === "local" ? "\n\n本机文件会被直接删除，不进回收站。" : hint;
    if (!window.confirm(`删除${side} ${selItems.length} 项？\n${names}${extra}`)) return;
    void runOp("删除", async () => {
      for (const item of selItems) {
        if (remoteTab) await remoteRemove(remoteTab, item.path, item.isDir);
        else if (paneView === "local") await localRemove(item.path, item.isDir);
      }
      setSelectedRemote(new Set());
      setSelectedLocal(new Set());
    });
  };

  const uploadSelected = () => {
    const items = local.entries.filter((e) => selectedLocal.has(e.path));
    if (!items.length || !remote.path) return;
    transferItems("local", items, remote.path);
  };

  const downloadSelected = () => {
    const items = remote.entries.filter((e) => selectedRemote.has(e.path));
    if (!items.length || !local.path) return;
    transferItems("remote", items, local.path);
  };

  // ---- 行右键菜单：定位在光标处，点外部 / Esc / 滚动即关闭 ----
  const [rowMenu, setRowMenu] = useState<
    { x: number; y: number; side: PaneSide; entry: DirEntry } | null
  >(null);

  useEffect(() => {
    if (!rowMenu) return;
    const close = () => setRowMenu(null);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [rowMenu]);

  const openRowMenu = (side: PaneSide, entry: DirEntry, x: number, y: number) => {
    setRowMenu({ x, y, side, entry });
  };

  const menuDelete = (side: PaneSide, entry: DirEntry) => {
    const sideName = side === "remote" ? "远端" : "本机";
    const extra = side === "local" ? "\n\n本机文件会被直接删除，不进回收站。" : "";
    if (!window.confirm(`删除${sideName}「${entry.name}」？${extra}`)) return;
    void runOp("删除", async () => {
      if (side === "remote") {
        if (!tabId) throw new Error("会话未就绪");
        await remoteRemove(tabId, entry.path, entry.isDir);
        setSelectedRemote(new Set());
      } else {
        await localRemove(entry.path, entry.isDir);
        setSelectedLocal(new Set());
      }
    });
  };

  const menuCopyPath = (entry: DirEntry) => {
    void navigator.clipboard.writeText(entry.path).then(
      () => setNotice("已复制路径"),
      () => setNotice("复制失败：剪贴板不可用"),
    );
  };

  // F2 重命名 / Delete 删除 / Alt+N 新建目录 / Alt+U 上传：只在抽屉可见时接管
  useEffect(() => {
    if (!active) return;
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null;
      const typing =
        el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || !!el?.isContentEditable;
      if (typing) return;
      if (ev.key === "F2" && canRename) {
        ev.preventDefault();
        startRename();
      } else if (ev.key === "Delete" && canDelete) {
        ev.preventDefault();
        deleteSelected();
      } else if (ev.altKey && ev.key.toLowerCase() === "n" && canCreate) {
        ev.preventDefault();
        startCreate();
      } else if (ev.altKey && ev.key.toLowerCase() === "u") {
        ev.preventDefault();
        uploadSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // 外部文件拖入（Tauri 窗口级 file drop）：直接入队上传到当前远端目录
  useEffect(() => {
    if (!active || !tabId || !remote.path) return;
    let cancelled = false;
    const onDrop = async (ev: Event) => {
      const detail = (ev as CustomEvent<{ paths: string[] }>).detail;
      const paths = detail?.paths?.filter(Boolean) ?? [];
      if (!paths.length) return;
      if (paneView !== "remote") {
        setNotice("切换到远端窗格后再拖入即可上传");
        return;
      }
      const stats = await Promise.all(
        paths.map((p) => localStat(p).catch(() => ({ isDir: false, isSymlink: false, size: 0 }))),
      );
      if (cancelled) return;
      const files: string[] = [];
      const dirs: string[] = [];
      paths.forEach((p, i) => {
        const st = stats[i];
        if (st.isDir && !st.isSymlink) dirs.push(p);
        else files.push(p);
      });
      const items = files.map((localPath) => ({
        direction: "upload" as const,
        tabId,
        remotePath: joinRemote(remote.path, basename(localPath)),
        localPath,
      }));
      if (items.length > 0) {
        void enqueue(items);
        setNotice(`已入队 ${items.length} 个文件`);
      }
      if (dirs.length > 0) {
        setTreePrompt({
          items: dirs.map<DirEntry>((p) => ({
            path: p,
            name: basename(p),
            isDir: true,
            isSymlink: false,
            size: 0,
            mtime: 0,
          })),
          direction: "upload",
          destDir: remote.path,
        });
      }
    };
    window.addEventListener("shellora:external-drop", onDrop);
    return () => {
      cancelled = true;
      window.removeEventListener("shellora:external-drop", onDrop);
    };
  }, [active, tabId, remote.path, paneView, enqueue]);

  const confirmTree = async () => {
    const prompt = treePrompt;
    if (!prompt) return;
    if (!tabId) {
      setTreePrompt(null);
      setNotice("远端会话未就绪：先打开一个连接");
      return;
    }
    setTreePrompt(null);
    const options = { ...treeOptions };
    let files = 0;
    let dirs = 0;
    let bytes = 0;
    for (const item of prompt.items) {
      const { channel, done } = enqueueTree(
        {
          direction: prompt.direction,
          tabId,
          sourcePath: item.path,
          destDir: prompt.destDir,
          options,
        },
        onQueueMsg,
      );
      queueChannelsRef.current.push(channel);
      try {
        const started = await done;
        files += started.files;
        dirs += started.dirsCreated;
        bytes += started.bytes;
      } catch (err) {
        setNotice(errorText(err));
      }
    }
    setNotice(
      `递归入队 ${prompt.items.length} 个目录：${files} 个文件 / ${dirs} 个新目录 / ${formatSize(bytes, false)}`,
    );
  };

  const conflict = order
    .map((id) => tasks[id])
    .find(
      (task): task is TransferTask =>
        Boolean(task && task.state === "conflict" && !dismissedConflicts.has(task.id)),
    );

  useEffect(() => {
    setRenameInput("");
    setChoice("overwrite");
  }, [conflict?.id]);

  const resolve = (selected: "overwrite" | "skip" | "rename") => {
    if (!conflict) return;
    const newName = selected === "rename" ? renameInput.trim() || null : null;
    void transferResolve(conflict.id, selected, newName)
      .then(() => {
        setRenameInput("");
        setDismissedConflicts((prev) => {
          const next = new Set(prev);
          next.delete(conflict.id);
          return next;
        });
      })
      .catch((err) => setNotice(errorText(err)));
  };

  const action = (promise: Promise<void>) => {
    void promise.catch((err) => setNotice(errorText(err)));
  };

  const toggleGroup = (id: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const looseTasks = order
    .map((id) => tasks[id])
    .filter((t): t is TransferTask => Boolean(t) && !t.groupId);

  const running = order
    .map((id) => tasks[id])
    .filter((t): t is TransferTask => Boolean(t) && t.state === "running");
  const queued = order.filter((id) => tasks[id]?.state === "queued").length;
  const doneCount = order.filter((id) => tasks[id]?.state === "done").length;
  const totalMbps = running.reduce((sum, t) => sum + t.mbps, 0);

  useEffect(() => {
    if (!onSummary) return;
    const currentTask = running[0] ?? null;
    onSummary({
      active: running.length,
      queued,
      done: doneCount,
      mbps: totalMbps,
      current: currentTask
        ? {
            name: basename(
              currentTask.direction === "upload" ? currentTask.localPath : currentTask.remotePath,
            ),
            percent:
              currentTask.total > 0
                ? Math.min(100, (currentTask.transferred / currentTask.total) * 100)
                : 0,
            mbps: currentTask.mbps,
            eta: formatEta(currentTask.etaSecs),
          }
        : null,
      recent: order
        .map((id) => tasks[id])
        .filter((t): t is TransferTask => Boolean(t) && t.state === "done")
        .slice(-3)
        .reverse()
        .map((t) => ({
          name: basename(t.direction === "upload" ? t.localPath : t.remotePath),
          size: t.total,
          direction: t.direction,
        })),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, order, onSummary]);

  const localPane = (
    <FilePane
      key="local"
      side="local"
      title="本地磁盘"
      path={local.path}
      entries={local.entries}
      selected={selectedLocal}
      loading={local.loading}
      note={local.note}
      onNavigate={(path) => {
        setSelectedLocal(new Set());
        navigateLocal(path);
      }}
      onRefresh={() => navigateLocal(local.path)}
      onSelect={setSelectedLocal}
      onLoadMore={loadMoreLocal}
      onDragStart={onDragStart}
      onDropTarget={onDropTarget}
      onTransferSelected={onTransferSelected}
      onRowContextMenu={openRowMenu}
    />
  );
  const remotePane = (
    <FilePane
      key="remote"
      side="remote"
      title={`SFTP · ${label}`}
      path={remote.path || "/"}
      entries={remote.entries}
      selected={selectedRemote}
      loading={remote.loading}
      total={remote.total}
      note={remote.note}
      idle={!tabId}
      idleHint="从左侧会话库打开一个连接，远端目录会在这里显示。"
      onNavigate={(path) => {
        setSelectedRemote(new Set());
        navigateRemote(path);
      }}
      onRefresh={() => navigateRemote(remote.path)}
      onSelect={setSelectedRemote}
      onDragStart={onDragStart}
      onDropTarget={onDropTarget}
      onTransferSelected={onTransferSelected}
      onRowContextMenu={openRowMenu}
    />
  );

  return (
    <section className="files" aria-label="SFTP 双栏工作站">
      <header className="filehead">
        <h2>Files</h2>
        <span className="hostchip">
          <span className="dot" />
          {label}
        </span>
        <div className="seg seg--pane" role="tablist" aria-label="窗格">
          <button
            type="button"
            className={paneView === "remote" ? "on" : ""}
            onClick={() => setPaneView("remote")}
          >
            远端
          </button>
          <button
            type="button"
            className={paneView === "local" ? "on" : ""}
            onClick={() => setPaneView("local")}
          >
            本机
          </button>
        </div>
        <span className="grow" />
        {notice ? <span className="sftp-notice">{notice}</span> : null}
        <button type="button" className="btn btn--ghost" onClick={refreshQueue}>
          <Icon name="refresh" /> 刷新队列
        </button>
        {onOpenTerminal ? (
          <button type="button" className="btn btn--ghost" onClick={onOpenTerminal}>
            <Icon name="terminal" /> 终端
          </button>
        ) : null}
      </header>

      <div className="dops" role="toolbar" aria-label="文件操作">
        <button
          type="button"
          className="dop dop--primary"
          title="上传选中的本机文件 (Alt+U)"
          disabled={selectedLocal.size === 0 || !remote.path || opBusy}
          onClick={uploadSelected}
        >
          <Icon name="upload" /><span className="dop__t">上传</span>
        </button>
        <button
          type="button"
          className="dop"
          title="新建目录 (Alt+N)"
          disabled={!canCreate}
          onClick={startCreate}
        >
          <Icon name="plus" /><span className="dop__t">新建目录</span>
        </button>
        <button
          type="button"
          className="dop"
          title="下载选中的远端文件"
          disabled={selectedRemote.size === 0 || !tabId || opBusy}
          onClick={downloadSelected}
        >
          <Icon name="download" /><span className="dop__t">下载</span>
        </button>
        <button
          type="button"
          className="dop"
          title="重命名选中的项 (F2)"
          disabled={!canRename}
          onClick={startRename}
        >
          <Icon name="pencil" /><span className="dop__t">重命名</span>
        </button>
        <button
          type="button"
          className="dop dop--danger"
          title="删除选中的项 (Delete)"
          disabled={!canDelete}
          onClick={deleteSelected}
        >
          <Icon name="trash" /><span className="dop__t">删除</span>
        </button>
        <span className="grow" />
        <span className="dops__sel">
          {selItems.length ? `已选 ${selItems.length}` : paneView === "remote" ? "未选择" : "本机窗格"}
        </span>
      </div>

      {editing ? (
        <div className="dedit">
          <Icon name={editing.mode === "create" ? "folder" : "pencil"} />
          <span className="dedit__label">{editing.mode === "create" ? "新目录" : "重命名为"}</span>
          <input
            autoFocus
            value={draft}
            onChange={(ev) => setDraft(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter") {
                ev.preventDefault();
                submitEdit();
              } else if (ev.key === "Escape") {
                ev.preventDefault();
                cancelEdit();
              }
            }}
            aria-label={editing.mode === "create" ? "新目录名称" : "新名称"}
          />
          <button type="button" className="dop dop--primary" onClick={submitEdit}>
            确定
          </button>
          <button type="button" className="dop" onClick={cancelEdit}>
            取消
          </button>
        </div>
      ) : null}

      <div className="fsp fsp--single">
        <div className={paneView === "local" ? "pane-slot on" : "pane-slot"}>{localPane}</div>
        <div className="axis" aria-label="传输方向">
          <button
            type="button"
            className="ab hot"
            title={swapped ? "下载选中项" : "上传选中项"}
            disabled={swapped ? selectedRemote.size === 0 || !tabId : selectedLocal.size === 0 || !tabId}
            onClick={() =>
              onTransferSelected(
                swapped ? "remote" : "local",
                swapped
                  ? remote.entries.filter((e) => selectedRemote.has(e.path))
                  : local.entries.filter((e) => selectedLocal.has(e.path)),
              )
            }
          >
            <Icon name={swapped ? "arrowLeft" : "arrowRight"} />
          </button>
          <button
            type="button"
            className="ab"
            title="交换左右窗格"
            onClick={() => setSwapped((prev) => !prev)}
          >
            <Icon name="sync" />
          </button>
          <span className="lbl">SWAP</span>
          <button
            type="button"
            className="ab"
            title={swapped ? "上传选中项" : "下载选中项"}
            disabled={swapped ? selectedLocal.size === 0 || !tabId : selectedRemote.size === 0 || !tabId}
            onClick={() =>
              onTransferSelected(
                swapped ? "local" : "remote",
                swapped
                  ? local.entries.filter((e) => selectedLocal.has(e.path))
                  : remote.entries.filter((e) => selectedRemote.has(e.path)),
              )
            }
          >
            <Icon name={swapped ? "arrowRight" : "arrowLeft"} />
          </button>
        </div>
        <div className={paneView === "remote" ? "pane-slot on" : "pane-slot"}>{remotePane}</div>
      </div>
      <section
        className={queueOpen ? "queue2" : "queue2 queue2--folded"}
        aria-label="传输队列"
      >
        <header className="qhead2">
          <span className="ttl">Transfers</span>
          <span className="cnt">
            {running.length + queued} 进行中 · {doneCount} 已完成
          </span>
          <span className="spd">
            <Icon name="activity" />
            <b>{totalMbps.toFixed(2)} MiB/s</b>
          </span>
          <button type="button" className="qb" title="刷新" onClick={refreshQueue}>
            <Icon name="refresh" />
          </button>
          <button
            type="button"
            className="qb"
            title={queueOpen ? "折叠传输队列" : "展开传输队列"}
            aria-expanded={queueOpen}
            onClick={() => setQueueOpen((open) => !open)}
          >
            <Icon name={queueOpen ? "chevronDown" : "chevronUp"} />
          </button>
        </header>

        {groupOrder.length === 0 && looseTasks.length === 0 ? (
          <p className="qempty">
            把左侧本地文件/目录拖到右侧远端目录即上传，反向即下载；Ctrl/Shift 可多选，空白处拖动可框选。
          </p>
        ) : (
          <ul className="qlist">
            {groupOrder.map((gid) => {
              const group = groups[gid];
              if (!group) return null;
              const percent =
                group.total > 0
                  ? Math.min(100, (group.transferred / group.total) * 100)
                  : group.state === "done"
                    ? 100
                    : 0;
              const canPause = group.state === "running" || group.state === "queued";
              const canResume = group.state === "paused";
              const canCancel =
                group.state === "running" ||
                group.state === "queued" ||
                group.state === "paused" ||
                group.state === "conflict";
              const children = order
                .map((id) => tasks[id])
                .filter((t): t is TransferTask => Boolean(t) && t.groupId === gid);
              const open = expandedGroups.has(gid);
              return (
                <li className={`qrow2 qrow2--group qrow2--${group.state}`} key={gid}>
                  <span className={`dtile ${group.direction === "upload" ? "up" : "done"}`}>
                    <Icon name={group.direction === "upload" ? "upload" : "download"} />
                  </span>
                  <span className="nm">
                    <span className="n ell">{group.label}/</span>
                    <span className="p">
                      {group.filesDone}/{group.filesTotal} 文件 · {group.policy} · 递归
                    </span>
                  </span>
                  <span className="bar">
                    <i style={{ width: `${percent}%` }} />
                  </span>
                  <span className="pct">{Math.round(percent)}%</span>
                  <span className="rate">{group.mbps.toFixed(2)} MiB/s</span>
                  <span className="eta">ETA {formatEta(group.etaSecs)}</span>
                  {group.state === "conflict" ? <span className="qbadge warn">CONFLICT</span> : null}
                  {group.errorCode ? <span className="qbadge err">{group.errorCode}</span> : null}
                  <button type="button" className="qa" title="详情" onClick={() => toggleGroup(gid)}>
                    <Icon name={open ? "chevronUp" : "chevronDown"} />
                  </button>
                  {canPause ? (
                    <button
                      type="button"
                      className="qa"
                      title="暂停"
                      onClick={() => action(transferPauseGroup(gid))}
                    >
                      <Icon name="pause" />
                    </button>
                  ) : null}
                  {canResume ? (
                    <button
                      type="button"
                      className="qa"
                      title="继续"
                      onClick={() => action(transferResumeGroup(gid))}
                    >
                      <Icon name="play" />
                    </button>
                  ) : null}
                  {canCancel ? (
                    <button
                      type="button"
                      className="qa"
                      title="取消"
                      onClick={() => action(transferCancelGroup(gid))}
                    >
                      <Icon name="x" />
                    </button>
                  ) : null}
                  {group.state === "conflict" ? (
                    <div className="qgroup__policy">
                      <span>整组处理：</span>
                      <button
                        type="button"
                        className="abtn"
                        onClick={() => action(transferResolveGroup(gid, "overwrite"))}
                      >
                        全部覆盖
                      </button>
                      <button
                        type="button"
                        className="abtn"
                        onClick={() => action(transferResolveGroup(gid, "skip"))}
                      >
                        全部跳过
                      </button>
                      <button
                        type="button"
                        className="abtn"
                        onClick={() => action(transferResolveGroup(gid, "rename"))}
                      >
                        全部重命名
                      </button>
                    </div>
                  ) : null}
                  {open ? (
                    <ul className="qgroup__children">
                      {children.map((task) => (
                        <li key={task.id} className={`qchild qchild--${task.state}`}>
                          <span className="qchild__name">
                            {task.direction === "upload"
                              ? basename(task.localPath)
                              : basename(task.remotePath)}
                          </span>
                          <span className={`qbadge ${task.state === "done" ? "ok" : ""}`}>
                            {STATE_LABEL[task.state]}
                          </span>
                          <span className="qchild__size">
                            {formatSize(task.transferred, false)} /{" "}
                            {task.total > 0 ? formatSize(task.total, false) : "?"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}

            {looseTasks.map((task) => {
              const percent =
                task.total > 0
                  ? Math.min(100, (task.transferred / task.total) * 100)
                  : task.state === "done"
                    ? 100
                    : 0;
              const canPause = task.state === "running" || task.state === "queued";
              const canResume = task.state === "paused";
              const canCancel =
                task.state === "running" ||
                task.state === "paused" ||
                task.state === "queued" ||
                task.state === "conflict";
              const name = basename(
                task.direction === "upload" ? task.localPath : task.remotePath,
              );
              const tone =
                task.state === "conflict"
                  ? "conflict"
                  : task.state === "done"
                    ? "done"
                    : task.direction === "upload"
                      ? "up"
                      : "down";
              return (
                <li className={`qrow2 qrow2--${task.state}`} key={task.id}>
                  <span className={`dtile ${tone}`}>
                    <Icon
                      name={
                        task.state === "conflict"
                          ? "alert"
                          : task.state === "done"
                            ? "check"
                            : task.direction === "upload"
                              ? "upload"
                              : "download"
                      }
                    />
                  </span>
                  <span className="nm">
                    <span className="n ell">{name}</span>
                    <span className="p">
                      {task.direction === "upload"
                        ? `LOCAL → ${basename(task.remotePath) ? "REMOTE" : ""}`
                        : "REMOTE → LOCAL"}{" "}
                      · {STATE_LABEL[task.state]}
                      {task.resumedBytes > 0
                        ? ` · 续传 ${formatSize(task.resumedBytes, false)}`
                        : ""}
                    </span>
                  </span>
                  {task.state === "conflict" ? (
                    <span className="qbadge warn">CONFLICT</span>
                  ) : null}
                  {task.errorCode ? <span className="qbadge err">{task.errorCode}</span> : null}
                  <span className="bar">
                    <i
                      className={
                        task.state === "conflict" ? "warn" : task.state === "done" ? "dn" : ""
                      }
                      style={{ width: `${percent}%` }}
                    />
                  </span>
                  <span className="pct">{Math.round(percent)}%</span>
                  <span className="rate">
                    {task.state === "running" ? `${task.mbps.toFixed(2)} MiB/s` : "—"}
                  </span>
                  <span className="eta">
                    {task.state === "done" ? "完成" : `ETA ${formatEta(task.etaSecs)}`}
                  </span>
                  {canPause ? (
                    <button
                      type="button"
                      className="qa"
                      title="暂停"
                      onClick={() => action(transferPause(task.id))}
                    >
                      <Icon name="pause" />
                    </button>
                  ) : null}
                  {canResume ? (
                    <button
                      type="button"
                      className="qa"
                      title="继续"
                      onClick={() => action(transferResume(task.id))}
                    >
                      <Icon name="play" />
                    </button>
                  ) : null}
                  {canCancel ? (
                    <button
                      type="button"
                      className="qa"
                      title="取消"
                      onClick={() => action(transferCancel(task.id))}
                    >
                      <Icon name="x" />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {treePrompt ? (
        <div className="conflict" role="alertdialog" aria-modal="true" aria-label="递归传输目录">
          <div className="confdlg2">
            <header className="cfhead2">
              <span className="icwrap">
                <Icon name="folder" />
              </span>
              <div>
                <h3>递归传输目录</h3>
                <p>
                  {treePrompt.items.map((item) => item.name).join("、")} → {treePrompt.destDir}
                </p>
              </div>
            </header>
            <div className="cfbody2">
              <div className="tgrid">
                <label className="field2">
                  <span className="lb2">最大深度</span>
                  <input
                    className="in2"
                    type="number"
                    min={1}
                    value={treeOptions.maxDepth}
                    onChange={(ev) =>
                      setTreeOptions((prev) => ({
                        ...prev,
                        maxDepth: Math.max(1, Number(ev.target.value) || 1),
                      }))
                    }
                  />
                </label>
                <label className="field2">
                  <span className="lb2">最大文件数</span>
                  <input
                    className="in2"
                    type="number"
                    min={1}
                    value={treeOptions.maxFiles}
                    onChange={(ev) =>
                      setTreeOptions((prev) => ({
                        ...prev,
                        maxFiles: Math.max(1, Number(ev.target.value) || 1),
                      }))
                    }
                  />
                </label>
                <label className="field2">
                  <span className="lb2">冲突策略</span>
                  <select
                    className="in2"
                    value={treeOptions.conflictPolicy}
                    onChange={(ev) =>
                      setTreeOptions((prev) => ({
                        ...prev,
                        conflictPolicy: ev.target.value as ConflictPolicy,
                      }))
                    }
                  >
                    <option value="ask">逐个询问</option>
                    <option value="overwrite">整组覆盖</option>
                    <option value="skip">整组跳过</option>
                    <option value="rename">整组重命名</option>
                  </select>
                </label>
              </div>
              <label className="tchk">
                <input
                  type="checkbox"
                  checked={treeOptions.createEmptyDirs}
                  onChange={(ev) =>
                    setTreeOptions((prev) => ({ ...prev, createEmptyDirs: ev.target.checked }))
                  }
                />
                创建空目录
              </label>
            </div>
            <footer className="cffoot2">
              <span className="grow" />
              <button type="button" className="btn" onClick={() => setTreePrompt(null)}>
                取消
              </button>
              <button type="button" className="btn btn--primary" onClick={() => void confirmTree()}>
                开始传输
              </button>
            </footer>
          </div>
        </div>
      ) : null}

      {conflict ? (
        <div className="conflict" role="alertdialog" aria-modal="true" aria-label="目标已存在">
          <div className="confdlg2">
            <header className="cfhead2">
              <span className="icwrap">
                <Icon name="alert" />
              </span>
              <div>
                <h3>File conflict</h3>
                <p className="ell">
                  {conflict.direction === "upload" ? conflict.remotePath : conflict.localPath}
                </p>
              </div>
              <span className="cnt2">
                <b>{Math.round((conflict.transferred / Math.max(1, conflict.total)) * 100)}%</b>
                {formatSize(conflict.transferred, false)} /{" "}
                {conflict.total > 0 ? formatSize(conflict.total, false) : "?"}
              </span>
            </header>

            <div className="cfbody2">
              <div className="cmp2">
                <div className="fcard2">
                  <div className="tagrow">
                    <span className="src">
                      {conflict.direction === "upload" ? "SOURCE · LOCAL" : "SOURCE · REMOTE"}
                    </span>
                  </div>
                  <div className="fn2">
                    <span className="ftile">
                      <Icon name="file" />
                    </span>
                    <span>
                      {basename(
                        conflict.direction === "upload"
                          ? conflict.localPath
                          : conflict.remotePath,
                      )}
                    </span>
                  </div>
                  <div className="meta2">
                    {formatSize(conflict.total, false)} ·{" "}
                    {conflict.direction === "upload" ? conflict.localPath : conflict.remotePath}
                  </div>
                </div>

                <span className="ar2">
                  <Icon name="arrowRight" />
                </span>

                <div className="fcard2 old">
                  <div className="tagrow">
                    <span className="dst">
                      {conflict.direction === "upload" ? "EXISTING · REMOTE" : "EXISTING · LOCAL"}
                    </span>
                  </div>
                  <div className="fn2">
                    <span className="ftile">
                      <Icon name="alert" />
                    </span>
                    <span>
                      {basename(
                        conflict.direction === "upload"
                          ? conflict.remotePath
                          : conflict.localPath,
                      )}
                    </span>
                  </div>
                  <div className="meta2">
                    {conflict.direction === "upload" ? conflict.remotePath : conflict.localPath}
                  </div>
                </div>
              </div>

              <div className="optrow">
                {(
                  [
                    {
                      key: "overwrite" as const,
                      icon: "upload",
                      title: "覆盖",
                      desc: "用源文件替换目标，保留最新内容",
                    },
                    {
                      key: "skip" as const,
                      icon: "arrowRight",
                      title: "跳过",
                      desc: "保留目标文件，不传输本项",
                    },
                    {
                      key: "rename" as const,
                      icon: "pencil",
                      title: "重命名",
                      desc: "以新名称保存源文件，目标不变",
                    },
                  ]
                ).map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    className={choice === opt.key ? "opt2 on" : "opt2"}
                    onClick={() => setChoice(opt.key)}
                  >
                    <span className="ico">
                      <Icon name={opt.icon} />
                    </span>
                    <b>{opt.title}</b>
                    <span>{opt.desc}</span>
                    <span className="radio" />
                  </button>
                ))}
              </div>

              {choice === "rename" ? (
                <input
                  className="ren2"
                  value={renameInput}
                  placeholder={`留空自动追加 (1) · ${basename(
                    conflict.direction === "upload" ? conflict.localPath : conflict.remotePath,
                  )}`}
                  onChange={(ev) => setRenameInput(ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") resolve("rename");
                  }}
                />
              ) : null}

              <div className="cfnote">
                仅处理当前冲突；整组冲突可在队列行内批量覆盖 / 跳过 / 重命名。
              </div>

              <div className="applyrow">
                <Icon name="shield" />
                覆盖会立即替换目标文件，此操作不可撤销。
                <span className="r">{STATE_LABEL[conflict.state]}</span>
              </div>
            </div>

            <footer className="cffoot2">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() =>
                  setDismissedConflicts((prev) => new Set(prev).add(conflict.id))
                }
              >
                稍后处理
              </button>
              <span className="grow" />
              <button type="button" className="btn" onClick={() => resolve("skip")}>
                跳过
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => resolve(choice)}
              >
                应用
              </button>
            </footer>
          </div>
        </div>
      ) : null}
      {rowMenu
        ? createPortal(
            <div
              className="ctxmenu"
              role="menu"
              style={{
                left: Math.max(8, Math.min(rowMenu.x, window.innerWidth - 200)),
                top: Math.max(8, Math.min(rowMenu.y, window.innerHeight - 232)),
              }}
              onMouseDown={(ev) => ev.stopPropagation()}
              onContextMenu={(ev) => ev.preventDefault()}
            >
              <div className="ctxmenu__head" title={rowMenu.entry.name}>
                {rowMenu.entry.name}
              </div>
              {rowMenu.side === "remote" ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={!local.path}
                  onClick={() => {
                    const entry = rowMenu.entry;
                    setRowMenu(null);
                    transferItems("remote", [entry], local.path);
                  }}
                >
                  <Icon name="download" />
                  下载到本机
                </button>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  disabled={!remote.path}
                  onClick={() => {
                    const entry = rowMenu.entry;
                    setRowMenu(null);
                    transferItems("local", [entry], remote.path);
                  }}
                >
                  <Icon name="upload" />
                  上传到远端
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const entry = rowMenu.entry;
                  setRowMenu(null);
                  setEditing({ mode: "rename", entry });
                  setDraft(entry.name);
                }}
              >
                <Icon name="pencil" />
                重命名
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setRowMenu(null);
                  startCreate();
                }}
              >
                <Icon name="plus" />
                新建目录
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const entry = rowMenu.entry;
                  setRowMenu(null);
                  menuCopyPath(entry);
                }}
              >
                <Icon name="copy" />
                复制路径
              </button>
              <div className="ctxmenu__sep" />
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => {
                  const { side, entry } = rowMenu;
                  setRowMenu(null);
                  menuDelete(side, entry);
                }}
              >
                <Icon name="trash" />
                删除
              </button>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}
