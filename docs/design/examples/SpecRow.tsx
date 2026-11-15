// 参考组件：按 docs/design/ui-spec.md §9 搭建，所有度量都来自令牌，组件内没有裸数值。
//
// 本文件是规范示例，**不参与构建**（不在 src/ 下，tsconfig 与 vite 都不会打包它）。
// 用法：复制到 src/features/<模块>/ 下再改信息结构；
//   1) 把下面这行导入改回 `../../components/Icons`（docs 下不解析该路径）；
//   2) 样式在 docs/design/examples/SpecRow.css，复制进 src/styles/base.css 的组件段。
import { Icon } from "../../components/Icons";

export interface SpecRowProps {
  title: string;
  meta: string;
  icon?: string;
  selected?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}

export function SpecRow({ title, meta, icon = "server", selected = false, disabled = false, onSelect }: SpecRowProps) {
  return (
    <button
      type="button"
      className={`specrow${selected ? " is-selected" : ""}`}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
    >
      {/* 图标：容器 --box-xs(24)，图标 --icon-sm(14)，两者相差 --sp-2，光学左移 --sp-0 */}
      <span className="specrow__tile">
        <Icon name={icon} />
      </span>
      <span className="specrow__text">
        {/* 主行 --fs-sm/--lh-md，副行 --fs-sm/--lh-sm，左缘一致 */}
        <span className="specrow__title">{title}</span>
        <span className="specrow__meta">{meta}</span>
      </span>
      <Icon name="chevronRight" />
    </button>
  );
}
