# M5 终端仿真打磨 · 验收证据

> 规则：每条验收都必须可判定。能自动化的给出用例编号与命令；不能自动化的（IME、真实滚轮、像素截图、长时间挂机、macOS 实机）明确记为**未验**并给出复现步骤，不写成"已完成"。
>
> 自动化命令：`pnpm exec vitest run`（7 个文件 42 例）、`cargo test --test m5_flood -- --test-threads=1`（1 例）。

## 0. 本轮实现与用例

| 能力 | 代码 | 说明 |
|---|---|---|
| addon 全接入 | `src/features/terminal/useTerminal.ts` | fit / web-links / search / unicode11 / clipboard(OSC52) / webgl |
| 主题包 ≥6 套 | `src/features/terminal/themes.ts` | 7 套：One Dark、Solarized Dark/Light、Dracula、Nord、Gruvbox、High Contrast |
| 键位映射 | `keymap.ts` | mac Option=Meta（ESC 前缀）；Win/Linux Alt=ESC 前缀；⌘C / Ctrl+Shift+C 复制 |
| 粘贴保护 | `pasteGuard.ts` + `TerminalPane.tsx` | 含换行/控制字符弹窗，500 行脚本行数逐条准确；bracketed paste 包装 |
| 搜索 UI | `TerminalPane.tsx` | 增量搜索、n/m 计数、上一个/下一个、区分大小写、清除高亮 |
| 链接 | `links.ts` | URL 标点裁剪、`file:line`；URL 经 opener 插件打开系统浏览器 |
| 光标形状 | `terminalControl.ts` | DECSCUSR 1–6 映射并回传 UI（`data-cursor-shape`） |
| OSC 7 cwd | `terminalControl.ts` + `App.tsx` + `SftpManager.tsx` | cwd 实时同步为 SFTP 远端初始路径 |
| 弱动画 | `src/styles/base.css` | `prefers-reduced-motion` 全局降级 |

## 1. 验收 1：§4 终端仿真 17 项

| 编号 | 验收点 | 证据（用例） | 结论 |
|---|---|---|---|
| T01 | 真彩色 / 256 色 | `golden.test.ts` ›「38;2;12;200;99 精确落到 RGB cell」「48;2 与 38;5;196」 | 自动化通过 |
| T02 | 基础 16 色 + SGR 属性 | `golden.test.ts` ›「SGR 1/2/3/4/5/7/9」+「16 色落索引」 | 自动化通过 |
| T03 | resize / SIGWINCH | 前端 `golden.test.ts` ›「resize 更新 cols/rows + onResize」「第 81 字符换行」；服务端 `m0_e2e.rs` › `stty size` / window-change | 自动化通过 |
| T04 | 宽字符 / emoji | `golden.test.ts` ›「CJK 占 2 列、竖线落第 10 列」「ZWJ emoji + 组合符」 | 自动化通过 |
| T05 | IME 组词/提交/删除 | 见 `docs/qa/ime-matrix.md`（60 行） | **未验**（需三平台实机 + 输入法） |
| T06 | 鼠标上报（SGR） | `control.test.ts` ›「1000/1002/1003 模式切换」「SGR 左键/拖动/滚轮/修饰键编码」 | 部分自动化：模式与编码通过；真实 DOM 鼠标事件 → xterm 内置，未在无头环境复现（**DOM 路径未验**） |
| T07 | 滚轮滚动 | `control.test.ts` ›「alternate screen 转方向键」 | 部分自动化：序列正确；真实滚轮手感/加速度 **未验**（需实机） |
| T08 | alternate screen | `golden.test.ts` ›「1049h/l 恢复原内容」 | 自动化通过 |
| T09 | bracketed paste | `paste.test.ts` ›「2004h 包装 ESC[200~…201~」 | 自动化通过（运行时 `paste()` 走同一包装函数） |
| T10 | 链接 | `links.test.ts` 4 例（标点裁剪 / file:line / 重叠优先 / 列范围） | 部分自动化：识别通过；OSC 8 由 xterm 内核处理、实际点击打开 **未验** |
| T11 | 搜索 | `search.test.ts` 4 例（计数 3/2、前后循环、不改缓冲区） | 部分自动化：计数与跳转通过；高亮像素渲染 **未验** |
| T12 | 选中复制 | `paste.test.ts` › normalizeSelection 2 例 | 部分自动化：复制内容规范化通过；双击断词/拖选 DOM 行为 **未验** |
| T13 | 多行粘贴确认 | `paste.test.ts` 5 例（3 行/500 行/单行/控制字符/行数统计） | 部分自动化：判定逻辑通过；弹窗交互 **未验** |
| T14 | 光标形状 | `control.test.ts` ›「1–6 映射 + 未知参数忽略」 | 部分自动化：DECSCUSR 映射通过；像素形状截图 **未验** |
| T15 | DEC 图形集 | `golden.test.ts` ›「lqqqk → ┌───┐」 | 自动化通过 |
| T16 | 焦点/标题/OSC 7 | `control.test.ts` 4 例（OSC0/2 标题、OSC7 解析、1004 模式、focus 序列） | 部分自动化：标题/OSC7/模式通过；真实 focus/blur DOM 事件 **未验** |
| T17 | 同步输出无花屏 | 需 `vim`/`htop` 实机连续 5 分钟 | **未验**（无头环境无法判定视觉） |

> 汇总：14 项中 T01/02/03/04/08/09/15 为完整自动化；T06/07/10/11/12/13/14/16 为"逻辑自动化 + 渲染/DOM 部分未验"；T05/T17 未验。

## 2. 验收 2：macOS 42 项清单与截图

- 清单：`docs/qa/macos-checklist.md`（42 条，状态全部为「未验」）。
- 截图目录：`docs/qa/macos/v1.1/`（当前仅占位 `.gitkeep`）。
- 阻塞原因：本机为 Windows，无 macOS 12+ 实机/截图环境。

## 3. 验收 3：三平台 IME 各 20 词

- 记录表：`docs/qa/ime-matrix.md`（Windows/macOS/Linux × 20 词 = 60 行）。
- 全部状态「未验」，需在实机输入法下逐词上屏并截图。

## 4. 验收 4：500 行脚本粘贴

| 子项 | 证据 | 结论 |
|---|---|---|
| 确认弹窗行数 = 500 | `paste.test.ts` ›「500 行脚本行数准确」断言 `lineCount === 500` 且 `needsConfirm` | 自动化通过（判定层） |
| 确认弹窗实际交互 | `TerminalPane.tsx` 弹窗（取消/发送） | **未验**（无 DOM 组件测试） |
| `cat > /tmp/x` 后远端字节一致 | 需真实 sshd 与文件校验 | **未验** |

## 5. 验收 5：vim/htop/tmux/less/mysql 连续 5 分钟无花屏

- 未验。需要真实远端与可视窗口，逐程序录屏 5 分钟，并检查 tmux resize 边框。

## 6. 验收 6：8 标签 × 6 小时内存增长 ≤80MB、`webglcontextlost=0`

- 未验（挂机时长与实机条件不具备）。
- 观测点已埋：`useTerminal.ts` 的 `onWebglContextLost` 回调，可接日志/面板计数；本轮未跑 6 小时挂机。

## 7. 验收 7：10MB 洪峰不丢字节

| 子项 | 证据 | 结论 |
|---|---|---|
| 远端输出量 = 接收量 | `m5_flood.rs` › `m5_10mb_flood_has_zero_byte_loss`：夹具精确输出 10MiB，断言 START/END 间载荷 `== 10 * 1024 * 1024` 字节 | 自动化通过 |
| 前端 xterm 渲染层不丢字节 | xterm `write` 顺序消费同一字节流；无头下无法观测像素 | **未验**（渲染层） |

> `wc -c` 的等价物：夹具 `bench burst 10` 的发送量是确定值 10MiB，测试直接比对字节数。

## 8. 验收 8：`prefers-reduced-motion` + 200% 缩放无溢出

| 子项 | 证据 | 结论 |
|---|---|---|
| reduced-motion 降级 | `base.css` 末尾媒体查询（动画/过渡降至 0.001ms） | 实现完成，**视觉核对未验** |
| 200% 缩放截图比对 | 需系统缩放 + 截图 | **未验** |

## 9. 已知限制

1. `@xterm/headless` 仅用于测试；其 6.0 与运行时 xterm 5.5 存在 API 差异，搜索用例对 `getSelectionPosition` / `registerDecoration` / `registerMarker` 做了最小桩，未覆盖高亮渲染。
2. 文件链接（`file:line`）当前复制路径并提示，未直接唤起编辑器。
3. OSC 7 不校验 host 字段，按"当前连接即该主机"处理。
4. 系统浏览器打开依赖 `tauri-plugin-opener`；插件不可用时退回 `window.open`。
5. 主题切换持久化在 `localStorage`，按窗口生效。
