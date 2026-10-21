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
dsh plugin --profile desktop add github:flyer103/dsh-side-chat#v0.5.0

# 本地路径（记录为 link: 依赖）
cd /path/to/dsh-side-chat
dsh plugin --profile desktop add "$(pwd)"

# 用 npm pack 打出的 tarball
dsh plugin --profile desktop add /absolute/path/flyer103-dsh-side-chat-0.5.0.tgz
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
- **继承上下文**：父会话已完成的轮次，加上主会话此刻正在做什么的实时快照；快照在该侧边会话创建时拍下。
- **继承 agent**：相同工作目录、preset 组合、工具、技能、模型路由、sandbox 模式与审批策略。
- **真实改文件**：write / edit / bash 的改动落在同一工作区，主会话能看到。
- **隔离 transcript**：侧边会话的对话不写主会话、不进会话列表、不进 subagent 目录。
- **流式输出**：assistant 文本、思考与工具调用在生成过程中逐 token 渲染（实时事件流）；传输不支持流式时自动回退到轮询。
- **关闭即销毁**：关闭某个 tab 时只 dispose 该 tab 的侧边会话，host 会尝试删除它的落盘产物；已关闭的侧边会话无法再打开，其它侧边会话和主会话都不受影响。收起侧边栏或切换 tab 只是暂停。

## 兼容性

- 在 DSH `0.2.1-rc.2`（Desktop profile，Web GUI）上验证：本版本在隔离的 DSH home 里用全新 `web` profile 起真实 `dsh web` 进程实测——插件启动、8 条 host 路由均有响应（含 SSE 路由的 JSON 回退）、client bundle 正常 serve。
- 本包**未声明** `engines.dsh` / DSH peer 依赖，因此安装时没有版本阻断；这与「已验证版本」是两件事——更新的 DSH 版本未经验证。
- 仅 Web 平台（`dsh.client.platform: web`），没有 CLI/TUI 界面。
- Node.js `>= 22`；插件本身是零依赖 ESM，不 import 任何 `@deepseek-ai/*`。
- 界面文案跟随 DSH 语言设置（Settings → General → Language / 语言）：内置中文与英文；其它语言回退到英文。技术细节——host 错误 message、路由、事件名与工具名——保持英文原文。

## 已知限制

- **侧边会话 tab 内不呈现审批提示**：侧边会话继承父会话的审批策略；父策略需要人工确认时，侧边会话会等待。要真实改文件，建议用 `danger-full-access` 这类不需要交互确认的策略。
- tab 关闭后无法恢复：重新点引导页卡片或按「新建侧边会话」会开始一个新的侧边会话，agent 在下次发消息时才创建。
- P1 已设计未实现：模型选择器、GUI 重启后恢复侧边会话、tab 内审批呈现。
- 继承的上下文是创建时的快照，之后主会话的新消息不会推给已存在的侧边会话；每个侧边会话各有自己的快照。
- 流式输出依赖可流式读取的 `fetch` 响应；如果页面传输会把响应整体缓冲（以「首帧未按时到达」判定），tab 会回退到 snapshot 轮询：运行中指示仍在，回复仍会在生成过程中按轮询粒度浮现。
- 每个侧边会话的首条请求大小都约等于主会话的下一次请求（因为它带着继承历史），同时开 N 个就会把这份开销乘以 N。

## 文档

- [docs/USAGE.md](docs/USAGE.md) — 完整语义（继承/隔离/修改/生命周期/安装/回滚/排障，英文）。
- [docs/DESIGN.md](docs/DESIGN.md) — 范围、阶段与对抗性推演。
- [docs/CONTRACT.md](docs/CONTRACT.md) — host 路由、右侧边栏 tab 集成与渲染契约。

## 仓库结构

| 路径 | 作用 |
|---|---|
| `lib/index.js` | host 半部：路由、实时尝试累积与 SSE 事件流、fork seed、boundary 注入、按实例的 session registry、close/dispose |
| `lib/client.js` | client 半部：右侧边栏 tab 类型 + 引导页入口，按 tab 实例的正文（流式消息区 + composer）、编号 chip、新建按钮与 close handler |
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
