// 期望产物清单：**唯一来源**。加一个 bundle 只改这里，release.yml、SHA256SUMS、
// manifest 条数校验全部跟着变。
//
// 顺序即发布清单顺序；`match` 只比对文件名。
export const EXPECTED_ARTIFACTS = [
  { id: "nsis", name: "Windows 安装包（NSIS .exe）", match: /setup\.exe$/i },
  { id: "msi", name: "Windows 安装包（.msi）", match: /\.msi$/i },
  { id: "dmg", name: "macOS 安装包（.dmg）", match: /\.dmg$/i },
  { id: "app-tar", name: "macOS 应用包（Shellora.app.tar.gz）", match: /\.app\.tar\.gz$/i },
  { id: "appimage", name: "Linux 安装包（.AppImage）", match: /\.AppImage$/i },
  { id: "deb", name: "Linux 安装包（.deb）", match: /\.deb$/i },
  { id: "rpm", name: "Linux 安装包（.rpm）", match: /\.rpm$/i },
];

export const EXPECTED_COUNT = EXPECTED_ARTIFACTS.length;

// Updater 签名只为「可增量更新」的产物生成：dmg 不产出 `.dmg.sig`（Tauri 的 dmg 只用于首次安装）。
// 白名单校验按这份名单要求「每个可签名产物都有同名 .sig」，而不是笼统要求 7 个。
export const SIGNABLE_IDS = ["nsis", "msi", "app-tar", "appimage", "deb", "rpm"];
export const EXPECTED_SIG_COUNT = SIGNABLE_IDS.length;

// publish 生成、随 Release 一起上传的清单份数（manifest-<ver>.json 与 .md）。
export const EXPECTED_MANIFEST_FILES = 2;
