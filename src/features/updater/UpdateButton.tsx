import { useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

type Phase = "idle" | "checking" | "upToDate" | "downloading" | "ready" | "error";

type UpdateState = { phase: Phase; detail?: string };

// 应用内更新：检查 -> 下载并安装 -> 重启。更新包由 tauri-plugin-updater 校验
// 独立签名公钥（与代码签名证书分离），端点在 tauri.conf.json 的 plugins.updater。
export function UpdateButton() {
  const [state, setState] = useState<UpdateState>({ phase: "idle" });

  async function run() {
    setState({ phase: "checking" });
    try {
      const update = await check();
      if (!update) {
        setState({ phase: "upToDate" });
        return;
      }
      setState({ phase: "downloading", detail: update.version });
      await update.downloadAndInstall();
      setState({ phase: "ready", detail: update.version });
    } catch (err) {
      setState({ phase: "error", detail: err instanceof Error ? err.message : String(err) });
    }
  }

  const busy = state.phase === "checking" || state.phase === "downloading";
  const label =
    state.phase === "checking"
      ? "检查中…"
      : state.phase === "downloading"
        ? `下载 ${state.detail}…`
        : state.phase === "ready"
          ? "重启以完成更新"
          : "检查更新";

  const hint =
    state.phase === "upToDate"
      ? "已是最新版本"
      : state.phase === "ready"
        ? `v${state.detail} 已安装`
        : state.phase === "error"
          ? `更新检查失败：${state.detail}`
          : "";

  return (
    <div className="update">
      <button
        type="button"
        className="btn btn--ghost"
        disabled={busy}
        onClick={() => void (state.phase === "ready" ? relaunch() : run())}
      >
        {label}
      </button>
      {hint ? <p className="update__hint">{hint}</p> : null}
    </div>
  );
}
