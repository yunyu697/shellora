import { useState } from "react";
import { clearData, noteUiAction } from "../../lib/ipc/commands";
import type { DataClearReport, DataClearScope } from "../../lib/ipc/types";
import { relaunch } from "@tauri-apps/plugin-process";

type Stage = "select" | "confirm" | "done" | "error";

interface ScopeItem {
  id: string;
  label: string;
  detail: string;
}

const CACHE_ITEMS: ScopeItem[] = [
  {
    id: "transfer_job",
    label: "传输缓存",
    detail: "传输任务记录与断点续传偏移（不影响已传输的文件）",
  },
  { id: "logs", label: "运行日志", detail: "应用数据目录下的 logs/（如存在）" },
];

const ALL_ITEMS: ScopeItem[] = [
  { id: "connection", label: "连接与会话库", detail: "已保存的连接、会话及其排序/备注" },
  {
    id: "credential_ref",
    label: "凭据引用",
    detail: "仅引用条目；密码本身从未入库（D1）",
  },
  {
    id: "known_host",
    label: "已知主机信任记录",
    detail: "应用数据库内的 TOFU 记录；不改系统 ~/.ssh/known_hosts",
  },
  ...CACHE_ITEMS,
  {
    id: "localStorage",
    label: "终端配置",
    detail: "主题、界面偏好等本地存储（重启后恢复默认）",
  },
];

function itemsFor(scope: DataClearScope): ScopeItem[] {
  return scope === "all" ? ALL_ITEMS : CACHE_ITEMS;
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
        数据清理
      </button>
      {open ? (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="清理本地数据">
          <div className="settings-card">
            <h2 className="settings-card__title">清理本地数据</h2>

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
                      仅清缓存
                      <small>保留连接、会话、信任记录</small>
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
                      全部清除
                      <small>不可恢复；改回默认配置</small>
                    </span>
                  </label>
                </fieldset>

                <p className="settings-card__hint">将删除：</p>
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
                    取消
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => {
                      setAcknowledged(false);
                      setStage("confirm");
                    }}
                  >
                    下一步
                  </button>
                </div>
              </>
            ) : null}

            {stage === "confirm" ? (
              <>
                <p className="settings-card__warn">
                  {scope === "all"
                    ? "全部清除会删除连接、会话、凭据引用与信任记录，且无法恢复。"
                    : "仅清除缓存与日志，连接与会话不受影响。"}
                </p>
                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                  />
                  我已了解上述影响，确认清除
                </label>
                <div className="settings-actions">
                  <button type="button" className="btn" onClick={() => setStage("select")} disabled={busy}>
                    返回
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger"
                    disabled={!acknowledged || busy}
                    onClick={() => void run()}
                  >
                    {busy ? "清除中…" : "确认清除"}
                  </button>
                </div>
              </>
            ) : null}

            {stage === "done" && report ? (
              <>
                <p className="settings-card__ok">
                  已清除 {report.rowsRemoved} 条业务记录（{report.items.join("、")}）。
                  {report.warnings.length ? ` 警告：${report.warnings.join("；")}` : ""}
                </p>
                <p className="settings-card__hint">
                  数据库路径：{report.dbPath}。重启后以空库启动。
                </p>
                <div className="settings-actions">
                  <button type="button" className="btn" onClick={close}>
                    关闭
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => {
                      // 记一笔“重置后重启”，避免下次启动把它算成异常终止。
                      void noteUiAction("ui:relaunch:data-reset").finally(() => void relaunch());
                    }}
                  >
                    立即重启
                  </button>
                </div>
              </>
            ) : null}

            {stage === "error" ? (
              <>
                <p className="settings-card__warn">清除失败：{error}</p>
                <div className="settings-actions">
                  <button type="button" className="btn" onClick={close}>
                    关闭
                  </button>
                  <button type="button" className="btn btn--primary" onClick={() => setStage("select")}>
                    重试
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
