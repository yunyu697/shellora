import { useState } from "react";
import { clearData, noteUiAction } from "../../lib/ipc/commands";
import type { DataClearReport, DataClearScope } from "../../lib/ipc/types";
import { relaunch } from "@tauri-apps/plugin-process";
import { tr } from "../../i18n";

type Stage = "select" | "confirm" | "done" | "error";

interface ScopeItem {
  id: string;
  label: string;
  detail: string;
}

function cacheItems(): ScopeItem[] {
  return [
    {
      id: "transfer_job",
      label: tr("传输缓存"),
      detail: tr("传输任务记录与断点续传偏移（不影响已传输的文件）"),
    },
    { id: "logs", label: tr("运行日志"), detail: tr("应用数据目录下的 logs/（如存在）") },
  ];
}

function allItems(): ScopeItem[] {
  return [
    {
      id: "connection",
      label: tr("连接与会话库"),
      detail: tr("已保存的连接、会话及其排序/备注"),
    },
    {
      id: "credential_ref",
      label: tr("凭据引用"),
      detail: tr("仅引用条目；密码本身从未入库（D1）"),
    },
    {
      id: "known_host",
      label: tr("已知主机信任记录"),
      detail: tr("应用数据库内的 TOFU 记录；不改系统 ~/.ssh/known_hosts"),
    },
    ...cacheItems(),
    {
      id: "localStorage",
      label: tr("终端配置"),
      detail: tr("主题、界面偏好等本地存储（重启后恢复默认）"),
    },
  ];
}

function itemsFor(scope: DataClearScope): ScopeItem[] {
  return scope === "all" ? allItems() : cacheItems();
}

// 设置入口：清理本地数据（M6 验收 5）。两档 + 二次确认。
export function DataResetButton() {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<DataClearScope>("cache");
  const [stage, setStage] = useState<Stage>("select");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<DataClearReport | null>(null);
  const [error, setError] = useState("");

  function reset() {
    setScope("cache");
    setStage("select");
    setAcknowledged(false);
    setBusy(false);
    setReport(null);
    setError("");
  }

  function close() {
    setOpen(false);
    reset();
  }

  async function run() {
    setBusy(true);
    try {
      const result = await clearData(scope);
      if (scope === "all") {
        // 终端配置（主题等）存在 localStorage，随全清一并移除。
        localStorage.clear();
      }
      setReport(result);
      setStage("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="btn btn--ghost" onClick={() => setOpen(true)}>
        {tr("数据清理")}
      </button>
      {open ? (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-label={tr("清理本地数据")}>
          <div className="settings-card">
            <h2 className="settings-card__title">{tr("清理本地数据")}</h2>

            {stage === "select" ? (
              <>
                <fieldset className="settings-scope">
                  <label className="settings-radio">
                    <input
                      type="radio"
                      name="data-scope"
                      checked={scope === "cache"}
                      onChange={() => setScope("cache")}
                    />
                    <span>
                      {tr("仅清缓存")}
                      <small>{tr("保留连接、会话、信任记录")}</small>
                    </span>
                  </label>
                  <label className="settings-radio">
                    <input
                      type="radio"
                      name="data-scope"
                      checked={scope === "all"}
                      onChange={() => setScope("all")}
                    />
                    <span>
                      {tr("全部清除")}
                      <small>{tr("不可恢复；改回默认配置")}</small>
                    </span>
                  </label>
                </fieldset>

                <p className="settings-card__hint">{tr("将删除：")}</p>
                <ul className="settings-list">
                  {itemsFor(scope).map((item) => (
                    <li key={item.id}>
                      <strong>{item.label}</strong>
                      <span>{item.detail}</span>
                    </li>
                  ))}
                </ul>

                <div className="settings-actions">
                  <button type="button" className="btn" onClick={close}>
                    {tr("取消")}
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => {
                      setAcknowledged(false);
                      setStage("confirm");
                    }}
                  >
                    {tr("下一步")}
                  </button>
                </div>
              </>
            ) : null}

            {stage === "confirm" ? (
              <>
                <p className="settings-card__warn">
                  {scope === "all"
                    ? tr("全部清除会删除连接、会话、凭据引用与信任记录，且无法恢复。")
                    : tr("仅清除缓存与日志，连接与会话不受影响。")}
                </p>
                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                  />
                  {tr("我已了解上述影响，确认清除")}
                </label>
                <div className="settings-actions">
                  <button type="button" className="btn" onClick={() => setStage("select")} disabled={busy}>
                    {tr("返回")}
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger"
                    disabled={!acknowledged || busy}
                    onClick={() => void run()}
                  >
                    {tr(busy ? "清除中…" : "确认清除")}
                  </button>
                </div>
              </>
            ) : null}

            {stage === "done" && report ? (
              <>
                <p className="settings-card__ok">
                  {tr("已清除 {count} 条业务记录（{items}）。", {
                    count: report.rowsRemoved,
                    items: report.items.join("、"),
                  })}
                  {report.warnings.length
                    ? " " + tr("警告：{warnings}", { warnings: report.warnings.join("；") })
                    : ""}
                </p>
                <p className="settings-card__hint">
                  {tr("数据库路径：{path}。重启后以空库启动。", { path: report.dbPath })}
                </p>
                <div className="settings-actions">
                  <button type="button" className="btn" onClick={close}>
                    {tr("关闭")}
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => {
                      // 记一笔“重置后重启”，避免下次启动把它算成异常终止。
                      void noteUiAction("ui:relaunch:data-reset").finally(() => void relaunch());
                    }}
                  >
                    {tr("立即重启")}
                  </button>
                </div>
              </>
            ) : null}

            {stage === "error" ? (
              <>
                <p className="settings-card__warn">{tr("清除失败：{error}", { error })}</p>
                <div className="settings-actions">
                  <button type="button" className="btn" onClick={close}>
                    {tr("关闭")}
                  </button>
                  <button type="button" className="btn btn--primary" onClick={() => setStage("select")}>
                    {tr("重试")}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

