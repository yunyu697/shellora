import { useEffect, useState } from "react";
import { traySettingsGet, traySettingsSet } from "../../lib/ipc/commands";
import { tr } from "../../i18n";
import { LanguageSettings } from "./LanguageSettings";

/**
 * 设置入口（1.1.0）：语言 + 「关闭窗口时最小化到托盘」。
 * 驻留默认关闭——关闭窗口仍然退出程序；开关落盘在 Rust 侧（settings.json），
 * 因为窗口关闭事件发生时前端不一定还在。
 */
export function TraySettings() {
  const [open, setOpen] = useState(false);
  const [closeToTray, setCloseToTray] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setError("");
    void traySettingsGet()
      .then((s) => {
        setCloseToTray(s.closeToTray);
        setLoaded(true);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [open]);

  async function toggle(next: boolean) {
    setBusy(true);
    setError("");
    try {
      const s = await traySettingsSet(next);
      setCloseToTray(s.closeToTray);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="btn btn--ghost" onClick={() => setOpen(true)}>
        {tr("设置")}
      </button>
      {open ? (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-label={tr("设置")}>
          <div className="settings-card">
            <h2 className="settings-card__title">{tr("设置")}</h2>

            <LanguageSettings />

            <p className="settings-section">{tr("托盘")}</p>
            <label className="settings-field">
              <input
                type="checkbox"
                checked={closeToTray}
                disabled={!loaded || busy}
                onChange={(e) => void toggle(e.target.checked)}
              />
              <span>
                {tr("关闭窗口时最小化到托盘")}
                <small>
                  {tr(
                    "默认关闭：关闭窗口即退出。开启后关闭窗口只会隐藏到托盘（SSH 会话保持连接），可从托盘图标恢复或退出。",
                  )}
                </small>
              </span>
            </label>
            <p className="settings-card__hint">
              {closeToTray
                ? tr("已启用驻留：首次最小化时会提示「Shellora 仍在后台运行」。")
                : tr("当前不驻留：托盘菜单里的「退出 Shellora」会优雅断开全部会话后退出。")}
            </p>

            {error ? <p className="settings-card__warn">{tr("读取设置失败：{error}", { error })}</p> : null}

            <div className="settings-actions">
              <button type="button" className="btn btn--primary" onClick={() => setOpen(false)}>
                {tr("关闭")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
