import { createRoot } from "react-dom/client";

import { SelfTest } from "./features/selftest/SelfTest";
import "./styles/base.css";

const root = document.getElementById("root");
if (!root) throw new Error("缺少 #root 容器");

const params = new URLSearchParams(window.location.search);

// `?selftest=1`（或 CDP 注入的启动前标记）只挂载 M0 性能自测页，正常启动不加载该分支。
const selftest =
  params.has("selftest") ||
  (window as unknown as { __M0_SELFTEST__?: boolean }).__M0_SELFTEST__ === true;

// `?preview=1` 仅在本地视觉回归时装载夹具 IPC，不进入正常启动路径。
async function boot() {
  // 夹具必须先于 App 模块求值安装（App 在模块级读取预览标记）。
  if (import.meta.env.DEV && params.has("preview")) await import("./lib/ipc/preview");
  const { default: App } = await import("./App");
  createRoot(root as HTMLElement).render(selftest ? <SelfTest /> : <App />);
}

void boot();
