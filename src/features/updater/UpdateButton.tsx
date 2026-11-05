import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

import { Icon } from "../../components/Icons";
import {
  classifyError,
  extractManifestSize,
  formatBytes,
  formatDate,
  progressPercent,
  type UpdateErrorInfo,
  type UpdateStage,
} from "./logic";

type Phase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

interface UpdateInfo {
  version: string;
  currentVersion: string;
  date?: string;
  notes?: string;
  size?: number;
}

/**
 * 应用内更新入口（头部图标按钮 + 更新面板）。
 *
 * - 启动后静默检查一次，失败不打扰用户，发现新版本只点亮红点；
 * - 手动「检查更新」打开面板，展示版本号、更新说明、安装包体积；
 * - 下载阶段显示进度，下载完成后由 updater 插件完成签名校验，再提示「安装并重启」；
 * - 任一阶段失败都给出稳定错误码与重试入口。
 */
export function UpdateButton() {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<UpdateErrorInfo | null>(null);
  const [retryStage, setRetryStage] = useState<UpdateStage>("check");
  const [currentVersion, setCurrentVersion] = useState("");

  const updateRef = useRef<Update | null>(null);
  const mountedRef = useRef(true);
  /** 只接受最后一次检查的结果，避免静默检查与手动检查互相覆盖。 */
  const seqRef = useRef(0);
  /** 静默检查失败不弹面板；用 ref 区分来源。 */
  const silentRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    void getVersion()
      .then(setCurrentVersion)
      .catch(() => setCurrentVersion(""));
    return () => {
      mountedRef.current = false;
      void updateRef.current?.close().catch(() => undefined);
      updateRef.current = null;
    };
  }, []);

  const releaseUpdate = useCallback(() => {
    void updateRef.current?.close().catch(() => undefined);
    updateRef.current = null;
  }, []);

  const runCheck = useCallback(async () => {
    silentRef.current = false;
    const seq = ++seqRef.current;
    setPhase("checking");
    setError(null);
    setRetryStage("check");
    releaseUpdate();
    try {
      const update = await check({ timeout: 15_000 });
      if (!mountedRef.current || seq !== seqRef.current) {
        void update?.close().catch(() => undefined);
        return;
      }
      if (!update) {
        setInfo(null);
        setPhase("up-to-date");
        return;
      }
      updateRef.current = update;
      const size = extractManifestSize(update.rawJson, navigator.userAgent);
      setInfo({
        version: update.version,
        currentVersion: update.currentVersion,
        date: update.date,
        notes: update.body,
        size,
      });
      setTotal(size ?? null);
      setDownloaded(0);
      setPhase("available");
    } catch (err) {
      if (!mountedRef.current || seq !== seqRef.current) return;
      if (silentRef.current) {
        // 启动静默检查：不打扰，仅保持 idle。
        setPhase("idle");
        return;
      }
      setError(classifyError(err, "check"));
      setRetryStage("check");
      setPhase("error");
    }
  }, [releaseUpdate]);

  // 启动静默检查：只点亮「有新版本」标记，不自动打开面板。
  useEffect(() => {
    let cancelled = false;
    silentRef.current = true;
    const seq = ++seqRef.current;
    (async () => {
      try {
        const update = await check({ timeout: 8_000 });
        if (cancelled || seq !== seqRef.current) {
          void update?.close().catch(() => undefined);
          return;
        }
        if (!update) return;
        updateRef.current = update;
        const size = extractManifestSize(update.rawJson, navigator.userAgent);
        setInfo({
          version: update.version,
          currentVersion: update.currentVersion,
          date: update.date,
          notes: update.body,
          size,
        });
        setTotal(size ?? null);
        setPhase("available");
      } catch {
        /* 静默检查失败不打扰用户 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const download = useCallback(async () => {
    const update = updateRef.current;
    if (!update) {
      await runCheck();
      return;
    }
    setPhase("downloading");
    setError(null);
    setRetryStage("download");
    setDownloaded(0);
    try {
      await update.download((event) => {
        if (!mountedRef.current) return;
        if (event.event === "Started") {
          const length = event.data.contentLength;
          if (length && length > 0) setTotal(length);
        } else if (event.event === "Progress") {
          setDownloaded((prev) => prev + event.data.chunkLength);
        }
      });
      if (!mountedRef.current) return;
      // download() 内部已完成签名校验；能走到这里即视为校验通过。
      setPhase("ready");
    } catch (err) {
      if (!mountedRef.current) return;
      setError(classifyError(err, "download"));
      setRetryStage("download");
      setPhase("error");
    }
  }, [runCheck]);

  const install = useCallback(async () => {
    const update = updateRef.current;
    if (!update) {
      setError(classifyError("下载状态丢失，请重新检查更新", "install"));
      setRetryStage("check");
      setPhase("error");
      return;
    }
    setPhase("installing");
    setError(null);
    setRetryStage("install");
    try {
      // Windows 下安装器启动后应用会退出；macOS / Linux 需要手动 relaunch。
      await update.install({ restartAfterInstall: true });
      await relaunch();
    } catch (err) {
      if (!mountedRef.current) return;
      setError(classifyError(err, "install"));
      setRetryStage("install");
      setPhase("error");
    }
  }, []);

  const retry = useCallback(() => {
    if (retryStage === "check") void runCheck();
    else if (retryStage === "download") void download();
    else void install();
  }, [download, install, retryStage, runCheck]);

  const busy = phase === "checking" || phase === "downloading" || phase === "installing";
  const hasUpdate = phase === "available" || phase === "downloading" || phase === "ready";
  const percent = progressPercent(downloaded, total);

  function openPanel() {
    setOpen(true);
    if (!busy && phase !== "ready" && phase !== "error") void runCheck();
  }

  function closePanel() {
    if (busy) return;
    setOpen(false);
  }

  const title = hasUpdate && info ? `发现新版本 v${info.version}` : "检查更新";

  return (
    <>
      <button
        type="button"
        className={hasUpdate ? "iconbtn upd-trigger is-new" : "iconbtn upd-trigger"}
        title={title}
        aria-label={title}
        onClick={openPanel}
      >
        <Icon name="download" />
        {hasUpdate ? <span className="upd-dot" aria-hidden /> : null}
      </button>

      {open ? (
        <div
          className="settings-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="软件更新"
          onClick={(ev) => {
            if (ev.target === ev.currentTarget) closePanel();
          }}
        >
          <div className="settings-card upd-card">
            <header className="upd-head">
              <span className="upd-mark">
                <Icon name="download" />
              </span>
              <div className="upd-title">
                <h2>软件更新</h2>
                <p>当前版本 v{currentVersion || info?.currentVersion || "—"}</p>
              </div>
              <span className="grow" />
              <button
                type="button"
                className="iconbtn"
                title="关闭"
                aria-label="关闭更新面板"
                disabled={busy}
                onClick={closePanel}
              >
                <Icon name="x" />
              </button>
            </header>

            {phase === "checking" ? (
              <div className="upd-body upd-center">
                <span className="upd-spinner" aria-hidden />
                <p className="upd-lead">正在检查更新…</p>
                <p className="settings-card__hint">连接 GitHub Releases 的更新清单。</p>
              </div>
            ) : null}

            {phase === "up-to-date" ? (
              <div className="upd-body upd-center">
                <span className="upd-badge-ok">
                  <Icon name="check" />
                </span>
                <p className="upd-lead">已是最新版本</p>
                <p className="settings-card__hint">当前 v{currentVersion || info?.currentVersion || "—"}，无需更新。</p>
                <div className="settings-actions">
                  <button type="button" className="btn" onClick={closePanel}>
                    关闭
                  </button>
                  <button type="button" className="btn btn--primary" onClick={() => void runCheck()}>
                    重新检查
                  </button>
                </div>
              </div>
            ) : null}

            {phase === "available" && info ? (
              <div className="upd-body">
                <div className="upd-version">
                  <span className="upd-to">v{info.version}</span>
                  <span className="upd-from">← v{info.currentVersion}</span>
                  {info.date ? <span className="upd-date">{formatDate(info.date)}</span> : null}
                  <span className="grow" />
                  <span className="upd-size">
                    <Icon name="download" /> {formatBytes(info.size)}
                  </span>
                </div>
                <div className="upd-notes">
                  <p className="upd-notes__label">更新说明</p>
                  <pre>{info.notes?.trim() || "该版本未提供更新说明。"}</pre>
                </div>
                <p className="settings-card__hint">
                  安装包会先下载到本地，并校验独立签名（与代码签名证书分离）。
                </p>
                <div className="settings-actions">
                  <button type="button" className="btn" onClick={closePanel}>
                    稍后
                  </button>
                  <button type="button" className="btn btn--primary" onClick={() => void download()}>
                    <Icon name="download" /> 下载更新
                  </button>
                </div>
              </div>
            ) : null}

            {phase === "downloading" && info ? (
              <div className="upd-body">
                <p className="upd-lead">正在下载 v{info.version}…</p>
                <div
                  className="upd-progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent ?? undefined}
                  aria-valuetext={percent === null ? "未知进度" : `${percent}%`}
                >
                  <span
                    className={percent === null ? "upd-progress__bar indeterminate" : "upd-progress__bar"}
                    style={percent === null ? undefined : { width: `${percent}%` }}
                  />
                </div>
                <div className="upd-progress__meta">
                  <span>
                    {formatBytes(downloaded)}
                    {total ? ` / ${formatBytes(total)}` : ""}
                  </span>
                  <span>{percent === null ? "下载中" : `${percent}%`}</span>
                </div>
                <p className="settings-card__hint">下载结束后会自动校验签名；校验失败将拒绝安装。</p>
              </div>
            ) : null}

            {phase === "ready" && info ? (
              <div className="upd-body upd-center">
                <span className="upd-badge-ok">
                  <Icon name="check" />
                </span>
                <p className="upd-lead">v{info.version} 已下载并通过签名校验</p>
                <p className="settings-card__hint">
                  点击「安装并重启」后应用会关闭，由安装器完成升级。未保存的终端会话会中断。
                </p>
                <div className="settings-actions">
                  <button type="button" className="btn" onClick={() => void download()}>
                    重新下载
                  </button>
                  <button type="button" className="btn btn--primary" onClick={() => void install()}>
                    安装并重启
                  </button>
                </div>
              </div>
            ) : null}

            {phase === "installing" ? (
              <div className="upd-body upd-center">
                <span className="upd-spinner" aria-hidden />
                <p className="upd-lead">正在启动安装程序…</p>
                <p className="settings-card__hint">应用即将关闭，安装完成后会重新启动。</p>
              </div>
            ) : null}

            {phase === "error" && error ? (
              <div className="upd-body">
                <div className="upd-error">
                  <span className="upd-error__code">{error.code}</span>
                  <div>
                    <p className="upd-error__title">{error.title}</p>
                    <p className="upd-error__msg">{error.message}</p>
                  </div>
                </div>
                <p className="settings-card__hint">
                  {retryStage === "check"
                    ? "请检查网络或代理后重试。"
                    : retryStage === "download"
                      ? "已下载的部分会被丢弃，重试会重新开始。"
                      : "安装未启动，应用仍可正常使用。"}
                </p>
                <div className="settings-actions">
                  <button type="button" className="btn" onClick={closePanel}>
                    关闭
                  </button>
                  <button type="button" className="btn btn--primary" onClick={retry}>
                    <Icon name="refresh" /> 重试
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
