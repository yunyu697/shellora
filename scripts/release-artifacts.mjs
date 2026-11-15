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
