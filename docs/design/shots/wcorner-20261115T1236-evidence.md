# 窗口圆角真机复测证据（2026-11-15 12:36 批次）

单窗口一轮：启动 → 浅色抓取 → 应用内切深色抓取 → `Stop-Process`。未使用 Alt+Tab、未切换前台、未开第二个窗口或调试工具窗口。

## 1. 构建

| 项 | 值 |
| --- | --- |
| 代码基线 | `358abf8`（2026-11-15 12:19:33 +0800）之后的工作树 |
| 构建命令 | `pnpm tauri build --no-bundle` |
| 产物 | `src-tauri/target/release/shellora.exe` |
| 构建完成时间 | 2026-11-15 12:28:19 |
| 大小 | 22,257,152 bytes |
| SHA256 | `02BA54BB45318C37152D769A89F7EF24DA002F07C71A078AF932BD89BCD22BD4` |

未使用 1.1.1 的旧产物。

## 2. 当前主题（应用内切换后由页面读回）

| 轮次 | `localStorage['shellora.uiTheme']` | `--border` | `--bg` |
| --- | --- | --- | --- |
| light | `light` | `#e2e7ee` | `#f4f6f9` |
| dark | `dark` | `#1e2a36` | `#0b0f14` |

## 3. DWM 属性读回

| 属性 | 值 | 说明 |
| --- | --- | --- |
| `DWMWA_WINDOW_CORNER_PREFERENCE`(33) | `2` = `DWMWCP_ROUND` | 两轮一致，与 `frame.rs::init` 一致 |
| `DWMWA_VISIBLE_FRAME_BORDER_THICKNESS`(37) | `2`（物理像素） | 200% 缩放 = 1 CSS px，即 DWM 边框厚度 |
| `DWMWA_USE_IMMERSIVE_DARK_MODE`(20) | Set 成功（深色轮 `1`、浅色轮 `0`） | 该属性只支持 Set |
| `DWMWA_BORDER_COLOR`(34) | 写 `COLORREF(#1E2A36)` / `COLORREF(#E2E7EE)` 均返回 `S_OK`；读回恒为 `0x80070057`（`E_INVALIDARG`） | **该属性只支持 Set，不能作为验收断言**；本项以第 4 节的像素剖面代替 |
| `GWL_EXSTYLE` layered 位 | 未置位 | 窗口非分层，排除「透明区被填色」 |

## 4. 角部逐像素剖面

从 12 倍放大图（最近邻）还原源物理像素，取离角点 10px 的直边处沿外法线 `d = -6 .. +6` 采样。
`d` 为正表示向窗口内部。实测输出（原样粘贴）：

```
dark
tl  -6:AEC1CD -5:AEC0CC -4:ACBFCB -3:AABDC9 -2:AABCC8 -1:A9BBC7 0:A8BAC6 1:25323D 2:1E2A36 3:141C25 4:111821 5:111821 6:111821
tr  -6:DCDCDC -5:DBDBDB -4:DADADA -3:D9D9D9 -2:D7D7D7 -1:D6D6D6 0:D5D5D5 1:697077 2:1E2A36 3:1B2631 4:111821 5:111821 6:111821
bl  -6:111821 -5:111821 -4:141C25 -3:1E2A36 -2:232E39 -1:917D7F 0:927E80 1:937F81 2:947F82 3:958083 4:958082 5:968183 6:968183
br  -6:111821 -5:111821 -4:1B2631 -3:1E2A36 -2:4B5259 -1:8A8A8A 0:8A8A8A 1:8B8B8B 2:8C8C8C 3:8D8D8D 4:8E8E8E 5:8F8F8F 6:919191

light
tl  -6:BED3E0 -5:BED3E0 -4:BDD2DF -3:BDD2DF -2:BDD2DF -1:BCD0DD 0:BCD0DD 1:E0E6ED 2:E2E7EE 3:F9FAFC 4:FFFFFF 5:FFFFFF 6:FFFFFF
tr  -6:F1F1F1 -5:F0F0F0 -4:F0F0F0 -3:EFEFEF -2:EFEFEF -1:EEEEEE 0:EDEDED 1:E6E9ED 2:E2E7EE 3:E9EDF2 4:FFFFFF 5:FFFFFF 6:FFFFFF
bl  -6:FFFFFF -5:FFFFFF -4:F9FAFC -3:E2E7EE -2:E1E4EB -1:C7ACAF 0:C8ADB0 1:C8ADB0 2:C8ADB0 3:CAAEB1 4:C9ADB0 5:CAAEB1 6:CAADB0
br  -6:FFFFFF -5:FFFFFF -4:E9EDF2 -3:E2E7EE -2:D2D5D9 -1:BDBDBD 0:BDBDBD 1:BDBDBD 2:BEBEBE 3:BEBEBE 4:BFBFBF 5:BFBFBF 6:BFBFBF
```

读法：

- **窗口最外那一行实色像素**：深色轮四角均为 `1E2A36`（上两角在 `+2`、下两角在 `-3`，差 1px 是裁剪基准与 `DWMWA_EXTENDED_FRAME_BOUNDS` 取整），与 `--border` 完全一致；浅色轮四角均为 `E2E7EE`，同样与 `--border` 一致。
- 紧贴窗口外侧那 1 个像素（深色 `25323D`/`697077`/`232E39`/`4B5259`，浅色 `E0E6ED`/`E6E9ED`/`E1E4EB`/`D2D5D9`）是边框色与**窗外背景**的抗锯齿混合，窗外是哪块窗口就偏哪边（上两角背后是浅色，下两角背后是壁纸/其它窗口），属窗口外的像素，不计入。
- `#F6F3EB`（白边原色）在 8 个角、`d = -6..+6` 全剖面中**命中 0 次**；同名批次的角袋统计里 `#F6F3EB ± 3` 命中数也为 0。

## 5. 结论

`358abf8` 已复测，四角无浅色残留，8 张图与属性读回见本目录。

- 图：`wcorner-20261115T1236-{light,dark}-{tl,tr,bl,br}-12x.png`（各 20px 裁切 × 12 倍最近邻）
- 本文件：属性读回与逐像素剖面
- macOS：**未验证**（本机无 macOS、现有 dmg 不含本轮改动、托管 runner 无人值守）
- 进程：应用退出后 `shellora` 为 0 个；`msedgewebview2` 中无归属本应用的实例
