// 20px 线性图标集（stroke 1.5），统一来自设计稿的 sprite 语义。
import type { ReactNode } from "react";

const PATHS: Record<string, ReactNode> = {
  terminal: (
    <>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <path d="M5.2 8.2l2.8 2.3-2.8 2.3M10.8 12.8h4" />
    </>
  ),
  search: (
    <>
      <circle cx="8.8" cy="8.8" r="4.6" />
      <path d="M12.4 12.4l3.4 3.4" />
    </>
  ),
  settings: (
    <>
      <path d="M3 5h8M14 5h3M3 10h3M9 10h8M3 15h10M16 15h1" />
      <circle cx="12.5" cy="5" r="1.5" />
      <circle cx="7" cy="10" r="1.5" />
      <circle cx="14.5" cy="15" r="1.5" />
    </>
  ),
  bell: (
    <>
      <path d="M5 13V9a5 5 0 0110 0v4l1.3 2H3.7L5 13z" />
      <path d="M8 16.5a2 2 0 004 0" />
    </>
  ),
  chevronDown: <path d="M5.5 8l4.5 4.5L14.5 8" />,
  chevronUp: <path d="M5.5 12l4.5-4.5L14.5 12" />,
  chevronRight: <path d="M8 5.5l4.5 4.5L8 14.5" />,
  chevronLeft: <path d="M12 5.5L7.5 10 12 14.5" />,
  plus: <path d="M10 4.5v11M4.5 10h11" />,
  x: <path d="M5 5l10 10M15 5L5 15" />,
  server: (
    <>
      <rect x="3" y="3.5" width="14" height="5.5" rx="1.5" />
      <rect x="3" y="11" width="14" height="5.5" rx="1.5" />
      <path d="M6 6.2h.01M6 13.7h.01M9 6.2h5M9 13.7h5" />
    </>
  ),
  folder: (
    <path d="M3 6.5a1.5 1.5 0 011.5-1.5H8l1.8 2h5.7A1.5 1.5 0 0117 8.5v7A1.5 1.5 0 0115.5 17h-11A1.5 1.5 0 013 15.5v-9z" />
  ),
  file: (
    <>
      <path d="M5 3.5h6l5 5V17H5z" />
      <path d="M11 3.5V9h5" />
    </>
  ),
  archive: (
    <>
      <path d="M3.5 6.5h13v10h-13z" />
      <path d="M3.5 6.5l2-3h9l2 3M8.5 6.5v10M11.5 6.5v10" />
    </>
  ),
  code: <path d="M7 6L3.5 10 7 14M13 6l3.5 4L13 14" />,
  log: (
    <>
      <path d="M4 3.5h9l3 3v10H4z" />
      <path d="M6.5 9h7M6.5 12h7M6.5 15h4" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="1.5" />
      <circle cx="7.5" cy="8" r="1.4" />
      <path d="M4 14l4-4 3 3 2-2 3 3" />
    </>
  ),
  upload: (
    <>
      <path d="M10 14V4M6 7.5L10 3.5l4 4" />
      <path d="M4 15.5h12" />
    </>
  ),
  download: (
    <>
      <path d="M10 3.5v10M6 10L10 14l4-4" />
      <path d="M4 16.5h12" />
    </>
  ),
  arrowRight: <path d="M3.5 10h12M11 5.5l4.5 4.5-4.5 4.5" />,
  arrowLeft: <path d="M16.5 10h-12M9 5.5L4.5 10 9 14.5" />,
  refresh: (
    <>
      <path d="M16 10a6 6 0 11-1.8-4.3" />
      <path d="M16 3.5v3.5h-3.5" />
    </>
  ),
  drive: (
    <>
      <rect x="3" y="5" width="14" height="10" rx="2" />
      <path d="M3 11h14" />
      <circle cx="6" cy="13.2" r=".8" />
      <circle cx="9" cy="13.2" r=".8" />
    </>
  ),
  key: (
    <>
      <circle cx="7.5" cy="9" r="3.5" />
      <path d="M10 11.5l6 6M13.5 15l2-2M15 16.5l2-2" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="9" width="10" height="8" rx="1.5" />
      <path d="M7 9V6.5a3 3 0 016 0V9" />
    </>
  ),
  shield: (
    <>
      <path d="M10 3l6 2.2v4.6c0 3.4-2.5 5.8-6 7.2-3.5-1.4-6-3.8-6-7.2V5.2L10 3z" />
      <path d="M7.2 9.8l2 2 3.6-4" />
    </>
  ),
  user: (
    <>
      <circle cx="10" cy="7" r="3" />
      <path d="M4.5 16.5c.8-3 2.8-4.5 5.5-4.5s4.7 1.5 5.5 4.5" />
    </>
  ),
  zap: <path d="M11 2.5L4.5 11H9l-1 6.5L15.5 9H11l0-6.5z" />,
  network: (
    <>
      <circle cx="10" cy="4.5" r="2" />
      <circle cx="4.5" cy="15" r="2" />
      <circle cx="15.5" cy="15" r="2" />
      <path d="M9 6.3L5.5 13M11 6.3l3.5 6.7M6.5 15h7" />
    </>
  ),
  copy: (
    <>
      <rect x="7" y="7" width="9" height="9" rx="1.5" />
      <path d="M13 7V5.5A1.5 1.5 0 0011.5 4h-7A1.5 1.5 0 003 5.5v7A1.5 1.5 0 004.5 14H7" />
    </>
  ),
  more: (
    <>
      <circle cx="4.5" cy="10" r=".9" />
      <circle cx="10" cy="10" r=".9" />
      <circle cx="15.5" cy="10" r=".9" />
    </>
  ),
  alert: (
    <>
      <path d="M10 3.5L17.5 16.5h-15L10 3.5z" />
      <path d="M10 8v4.5M10 14.8v.01" />
    </>
  ),
  check: <path d="M4.5 10.5l3.5 3.5 7.5-8" />,
  clock: (
    <>
      <circle cx="10" cy="10" r="6.5" />
      <path d="M10 6v4.2l3 1.8" />
    </>
  ),
  star: (
    <path d="M10 3.2l2 4.1 4.5.7-3.3 3.2.8 4.5-4-2.1-4 2.1.8-4.5-3.3-3.2 4.5-.7L10 3.2z" />
  ),
  trash: (
    <>
      <path d="M4.5 6h11M8 6V4h4v2M6 6l.8 10h6.4L14 6" />
    </>
  ),
  pause: <path d="M7 5v10M13 5v10" />,
  play: <path d="M7 5l8 5-8 5V5z" />,
  panel: (
    <>
      <rect x="3" y="3.5" width="14" height="13" rx="1.5" />
      <path d="M8.5 3.5v13" />
    </>
  ),
  split: (
    <>
      <rect x="3" y="3.5" width="14" height="13" rx="1.5" />
      <path d="M10 3.5v13" />
    </>
  ),
  sync: (
    <>
      <path d="M15.5 8a6 6 0 00-10.6-2M4.5 12a6 6 0 0010.6 2" />
      <path d="M15.5 4v4h-4M4.5 16v-4h4" />
    </>
  ),
  pencil: (
    <>
      <path d="M12.5 4.5l3 3M4 16l1-4 8.5-8.5 3 3L8 15l-4 1z" />
    </>
  ),
  globe: (
    <>
      <circle cx="10" cy="10" r="6.5" />
      <path d="M3.5 10h13M10 3.5c2 2 3 4 3 6.5s-1 4.5-3 6.5c-2-2-3-4-3-6.5s1-4.5 3-6.5z" />
    </>
  ),
  activity: <path d="M3 10h3.5l2.5-6 3.5 12 2.5-6H17" />,
  sun: (
    <>
      <circle cx="10" cy="10" r="3.2" />
      <path d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M5 5l1.4 1.4M13.6 13.6L15 15M15 5l-1.4 1.4M6.4 13.6L5 15" />
    </>
  ),
  moon: <path d="M15.5 12.5a6 6 0 01-7.9-7.9 6.6 6.6 0 108.8 9.1 6 6 0 01-.9-1.2z" />,
};

interface IconProps {
  name: keyof typeof PATHS | string;
  size?: number;
  className?: string;
}

export function Icon({ name, size, className }: IconProps) {
  const body = PATHS[name] ?? PATHS.file;
  return (
    <svg
      className={className ? `ic ${className}` : "ic"}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      {body}
    </svg>
  );
}
