# dsh-side-chat

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 用的**侧边会话**：从会话头部展开右侧边栏，添加 **侧边会话**（English 界面为 Side chat）tab，聊完关掉，主会话完全不受影响——但侧边会话用的是**同一个 agent、同一套工具，并且会真实修改同一工作区的文件**。

[English](README.md) | 中文

[![CI](https://github.com/flyer103/dsh-side-chat/actions/workflows/test.yml/badge.svg)](https://github.com/flyer103/dsh-side-chat/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/flyer103/dsh-side-chat)](https://github.com/flyer103/dsh-side-chat/releases)
[![npm](https://img.shields.io/npm/v/@flyer103/dsh-side-chat)](https://www.npmjs.com/package/@flyer103/dsh-side-chat)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 快速开始

```bash
# npm（推荐）
dsh plugin --profile desktop add @flyer103/dsh-side-chat

# GitHub：默认分支，或固定到 tag
dsh plugin --profile desktop add github:flyer103/dsh-side-chat
dsh plugin --profile desktop add github:flyer103/dsh-side-chat#v0.10.4

# 本地路径（记录为 link: 依赖）
cd /path/to/dsh-side-chat
dsh plugin --profile desktop add "$(pwd)"

# 用 npm pack 打出的 tarball
dsh plugin --profile desktop add /absolute/path/flyer103-dsh-side-chat-0.10.4.tgz
```

`--profile` 用你实际运行的那个：Desktop 应用用 `desktop`，自己起的 web 进程用 `web` 或你的 profile 名。装进 `desktop` 时建议先退出 Desktop 应用（CLI 会等 profile 写锁），装完再打开；无论如何都要重启才生效。`add` 会自动把包追加进 profile 的 `dsh.profile.bundles`，**不需要**手工编辑 profile 的 `cordis.patch.yml`；重复执行是安全的。

也可以从本地仓库跑安装脚本：

```bash
node scripts/install.mjs --profile desktop            # 幂等；不会重启 DSH
node scripts/install.mjs --profile desktop --dry-run  # 只打印计划
```

然后**重启 DSH**，打开任意会话，从会话头部展开右侧边栏（**「打开侧边栏」/「Open sidebar」**），在边栏的引导页里点 **「侧边会话」**（English 界面显示 Side chat）卡片，侧边会话会作为该栏的一个原生 tab 打开。**没有会话头部的专属侧边会话按钮，也没有浮层**：入口就在右侧边栏的引导页（已开其它 tab 时，可用 tab 条上的「+」控件打开引导页）；tab 打开后，状态栏上还有 **「新建侧边会话」**（English 界面显示 New side chat）按钮。发送第一条消息——**该 tab 的**侧边会话在首条消息发送时才创建，关闭该 tab 即销毁；收起侧边栏或切到别的 tab 只是暂停，不销毁；只打开 tab 不发送不产生任何会话或开销。每点一次引导页卡片、每按一次 tab 状态栏的「新建侧边会话」按钮，都会在同一分栏里再开一个侧边会话 tab，各自拥有独立的侧边会话，tab 标题按父会话编号（「侧边会话」「侧边会话 2」…；English 界面为 Side chat、Side chat 2…）。关闭其中一个侧边会话 tab 只销毁它自己，其它侧边会话和主会话都不受影响。

## 它做什么

- **右侧边栏原生 tab**：作为右侧边栏里的一个 tab 存在，没有会话头部的独立按钮、没有浮层。
- **可同时开多个**：同一个父会话可以并排开多个独立的侧边会话 tab，每个都是自己的临时侧边会话，tab 标题按父会话编号；可从引导页卡片或 tab 状态栏的「新建侧边会话」按钮再开一个。
- **把回复带回主会话**：每条已完成的助手回复下方有「引用到主会话」按钮，按下后该回复作为 Markdown 引用插入主会话输入框草稿，不会自动发送。
- **继承上下文**：父会话已完成的轮次，加上主会话此刻正在做什么的实时快照；快照在该侧边会话创建时拍下。
- **继承 agent**：相同工作目录、preset 组合、工具、技能、模型路由、sandbox 模式与审批策略。
- **真实改文件**：write / edit / bash 的改动落在同一工作区，主会话能看到。
- **用 `@` 引用文件和会话**：在侧边会话输入框里输入 `@` 会弹出与主输入框相同的双域菜单——先文件/目录路径，再其它会话。选中文件插入与主会话完全相同的 `@path` 文本（引用只是文本，模型仍用自己的工具读取文件；选中目录会保留菜单继续下钻）；选中会话插入一个紧凑的标题引用，发送时展开为主输入框的规范会话引用，由 DSH 把该会话的快照作为上下文带给侧边会话。已发送的用户气泡会把文件 / 目录 / 会话引用渲染成 chip。会话内容由 DSH 自己的会话引用服务准备，本插件不读取会话日志。
- **可以发图片**：在侧边会话输入框粘贴截图、拖入图片文件，或用回形针按钮选择图片。图片加入后立即上传，以缩略图显示（上传中 / 移除 / 重试）；发送时作为真实的图片内容（可与文字同发，也可只发图片），并在对话气泡里渲染，点击可看原图。支持的格式与大小 / 数量上限来自 DSH 自带的附件 provider；模型路由不支持图片时会在发送前明确拒绝。
- **隔离 transcript**：侧边会话的对话不写主会话、不进会话列表、不进 subagent 目录。
- **流式输出**：assistant 文本、思考与工具调用在生成过程中逐 token 渲染（实时事件流）；传输不支持流式时自动回退到轮询。
- **表格 / 代码可复制**：鼠标悬停渲染出来的表格会出现「复制表格」chip，把表格同时以 HTML 表格和制表符分隔文本写进剪贴板——粘进飞书文档、Word 里仍是表格，粘进表格软件则拆成单元格；代码块沿用 shell 自带的复制 / 换行工具栏。
- **渲染 LaTeX**：assistant 回复里的 `$…$`、`$$…$$`、`\(…\)` 与行首 `\[…\]` 由 shell 的 KaTeX 渲染；列首的裸 display 环境（如 `\begin{align}…\end{align}`）由插件包成 display math 后再交给 shell。
- **输入框随草稿长高**：多行草稿会逐行增高，上限对齐主输入框，超过后框内滚动；增高时消息区保持贴底，发送或清空后缩回一行。
- **显示自己的用量**：composer 下方有一条细状态栏（位置对应 DSH 主输入框的底部 dock），显示这个侧边会话的总 token 数、缓存命中率，以及一个小的上下文占用圆环 + 百分比；悬停可看精确的未缓存输入 / 缓存读取 / 输出计数（提供方报告缓存写入时还会列出缓存写入）和近似的「~已用 / 窗口」值。侧边会话还没有用量样本时整行隐藏，新建侧边会话时重新计数。
- **关闭即销毁**：关闭某个 tab 时只 dispose 该 tab 的侧边会话，host 会尝试删除它的落盘产物；已关闭的侧边会话无法再打开，其它侧边会话和主会话都不受影响。收起侧边栏或切换 tab 只是暂停。

## 兼容性

- 在 DSH `0.2.2-rc.3`（Desktop profile，Web GUI）上做过验证，这是有记录的目标版本；当前 Desktop 构建是 `0.2.2-rc.5`——插件在该构建上安装并使用，其 composer 高度上限也按该构建重新核对过，但下面的实测没有在 rc.5 上重跑。核心面板在隔离的 DSH home 里用全新 `web` profile 起真实 `dsh web` 进程实测——插件启动、host 路由均有响应（含 SSE 路由的 JSON 回退）、client bundle 正常 serve；之后新增的 `@` 路由（文件/目录 + 会话候选）与图片上传 / 读取路由由 host/client 单测覆盖，其中 `@` 合并路由与两个图片二进制路由另外在进程内真实 HTTP server 上验证过帧格式，会话 mention 的拼写也用已安装构建自带的解析器核对过；会话引用与图片输入尚未做 GUI 端到端实测，LaTeX display 环境的包裹由单测 + 真实 Markdown 解析器核对覆盖，同样没有 GUI 实测。
- 「复制表格」chip 的双格式剪贴板内容（HTML 表格 + 制表符文本，以及降级写文本的回退路径）由 client 单测覆盖；手动粘贴进飞书文档 / Word 的实测尚未记录。
- 本包**未声明** `engines.dsh` / DSH peer 依赖，因此安装时没有版本阻断；这与「已验证版本」是两件事——更新的 DSH 版本未经验证。
- 仅 Web 平台（`dsh.client.platform: web`），没有 CLI/TUI 界面。
- Node.js `>= 22`；插件本身是零依赖 ESM，不 import 任何 `@deepseek-ai/*`。
- 界面文案跟随 DSH 语言设置（Settings → General → Language / 语言）：内置中文与英文；其它语言回退到英文。技术细节——host 错误 message、路由、事件名与工具名——保持英文原文。

## 已知限制

- **侧边会话 tab 内不呈现审批提示**：侧边会话继承父会话的审批策略；父策略需要人工确认时，侧边会话会等待。要真实改文件，建议用 `danger-full-access` 这类不需要交互确认的策略。
- tab 关闭后无法恢复：重新点引导页卡片或按「新建侧边会话」会开始一个新的侧边会话，agent 在下次发消息时才创建。
- P1b 已设计未实现：模型选择器、GUI 重启后恢复侧边会话、tab 内审批呈现。
- `@` 补全依赖 host 的引用 provider：文件/目录补全需要 file-reference provider，会话补全需要 DSH 的 session-reference 服务；官方 Web 栈两者都挂载，缺一个就只列另一个，两个都缺时菜单隐藏。会话引用的准备（预算、截断、失败语义）归 DSH，与主会话完全一致；会话 chip 只是展示。`/` 命令与技能、以及通用（非图片）文件附件还没有进入侧边会话输入框。
- 图片输入只支持图片，且需要视觉模型：粘贴 / 拖入非图片文件会被忽略；模型路由不支持图片时发送会被明确拒绝（草稿与缩略图保留）。DSH 的附件对象永不删除，因此移除缩略图、发送失败或关闭 tab 可能在同一 DSH home 下留下无引用对象——无害、不出现在任何列表里。图片栏是每个 tab 的内存态，host 重启即丢失。
- 继承的上下文是创建时的快照，之后主会话的新消息不会推给已存在的侧边会话；每个侧边会话各有自己的快照。
- 流式输出依赖可流式读取的 `fetch` 响应；如果页面传输会把响应整体缓冲（以「首帧未按时到达」判定），tab 会回退到 snapshot 轮询：运行中指示仍在，回复仍会在生成过程中按轮询粒度浮现。
- 每个侧边会话的首条请求大小都约等于主会话的下一次请求（因为它带着继承历史），同时开 N 个就会把这份开销乘以 N。
- 用量 dock 是近似值，且两类数字口径不同：token 总量与缓存命中率只统计这个侧边会话自己实际计费的请求——包括它首次请求重新发送的继承上下文——不包含父会话更早的请求；上下文占用出于同一原因取绝对值——继承的上下文确实在提示词里——但它不做 DSH 的 projected-token（surface delta）修正，因此可能比主会话的上下文条慢一步。dock 不显示轮次 / 步数 / tok/s，没有点开的详情弹窗，也不跟随 DSH「Performance & usage（性能与用量）」的详细 / 简洁偏好，内容固定。
- 重新接上的侧边会话 tab 如果会话日志超过 snapshot 的 2000 条分页，dock 可能少算较早的用量；从第一条消息起就在看的 tab 不受影响，因为它逐条收到所有已提交事件。

## 文档

- [docs/USAGE.md](docs/USAGE.md) — 完整语义（继承/隔离/修改/生命周期/安装/回滚/排障，英文）。
- [docs/DESIGN.md](docs/DESIGN.md) — 范围、阶段与对抗性推演。
- [docs/CONTRACT.md](docs/CONTRACT.md) — host 路由、右侧边栏 tab 集成与渲染契约。

## 仓库结构

| 路径 | 作用 |
|---|---|
| `lib/index.js` | host 半部：路由、实时尝试累积与 SSE 事件流、fork seed、boundary 注入、按实例的 session registry、close/dispose |
| `lib/client.js` | client 半部：右侧边栏 tab 类型 + 引导页入口，按 tab 实例的正文（流式消息区 + composer + 用量 dock）、编号 chip、新建按钮与 close handler |
| `cordis.patch.yml` | bundle patch：插入 `dsh-side-chat` 行 |
| `scripts/install.mjs` | 本地仓库的幂等安装/卸载脚本 |
| `dsh.plugin.json` | 社区约定的清单元数据；DSH 不读取（官方展示元数据来自 `package.json` 与可选 `locale/*.json`） |
| `tests/` | `node --test` 单测 |

## 卸载

```bash
dsh plugin --profile desktop remove @flyer103/dsh-side-chat
```

然后重启 DSH。没有 transcript、schema 或工作区数据的迁移或删除；侧边会话本来就是临时的。

## License

MIT
