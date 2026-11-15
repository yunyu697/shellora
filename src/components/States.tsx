import type { ReactNode } from "react";
import { Icon } from "./Icons";

interface StateProps {
  /** 图标名，取自 src/components/Icons.tsx */
  icon?: string;
  title: string;
  desc?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}

const cx = (...parts: Array<string | false | undefined>) => parts.filter(Boolean).join(" ");

/**
 * 空状态：图标 + 标题 + 说明 + 操作。
 * 只写一句话的空态会让用户不知道下一步，统一走这个组件。
 */
export function EmptyState({ icon = "layers", title, desc, action, compact, className }: StateProps) {
  return (
    <div className={cx("state", compact && "state--compact", className)} role="status">
      <Icon name={icon} className="state__ic" />
      <b className="state__t">{title}</b>
      {desc ? <span className="state__d">{desc}</span> : null}
      {action ? <div className="state__a">{action}</div> : null}
    </div>
  );
}

/** 加载态：骨架行 + 一行说明，不用转圈图标。 */
export function LoadingState({
  title,
  rows = 6,
  compact,
  className,
}: {
  title: string;
  rows?: number;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cx("state", "state--loading", compact && "state--compact", className)}
      role="status"
      aria-live="polite"
    >
      <div className="skel" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <span key={i} className="skel__r" />
        ))}
      </div>
      <span className="state__d">{title}</span>
    </div>
  );
}

/** 错误态：与空态同构，图标换成警示色，操作位放重试。 */
export function ErrorState({ title, desc, action, compact, className }: StateProps) {
  return (
    <div className={cx("state", "state--error", compact && "state--compact", className)} role="alert">
      <Icon name="alert" className="state__ic" />
      <b className="state__t">{title}</b>
      {desc ? <span className="state__d">{desc}</span> : null}
      {action ? <div className="state__a">{action}</div> : null}
    </div>
  );
}
