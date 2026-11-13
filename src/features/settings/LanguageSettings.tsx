import { LOCALES, normalizeLocale, systemLocale, useI18n, type LocaleMode } from "../../i18n";
import { tr } from "../../i18n";

/**
 * 语言设置：默认跟随系统，系统语言不在支持范围时回落英语；
 * 手动选择会持久化并同步到 Rust（托盘菜单/提示同步切换）。
 */
export function LanguageSettings() {
  const { mode, setLocaleMode } = useI18n();
  const sys = systemLocale();
  const sysLabel = LOCALES.find((l) => l.id === sys)?.native ?? "English";

  return (
    <>
      <p className="settings-section">{tr("语言")}</p>
      <label className="settings-field settings-field--stack">
        <select
          value={mode === "system" ? "system" : normalizeLocale(mode) ?? "system"}
          onChange={(e) => setLocaleMode(e.target.value as LocaleMode)}
        >
          <option value="system">{tr("跟随系统（当前：{lang}）", { lang: sysLabel })}</option>
          {LOCALES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.native}
            </option>
          ))}
        </select>
        <small>{tr("界面与托盘菜单会立即切换，无需重启。")}</small>
      </label>
    </>
  );
}
