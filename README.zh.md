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
dsh plugin --profile desktop add github:flyer103/dsh-side-chat#v0.3.2

# 本地路径（记录为 link: 依赖）
cd /path/to/dsh-side-chat
dsh plugin --profile desktop add "$(pwd)"

# 用 npm pack 打出的 tarball
dsh plugin --profile desktop add /absolute/path/flyer103-dsh-side-chat-0.3.2.tgz
```

`--profile` 用你实际运行的那个：Desktop 应用用 `desktop`，自己起的 web 进程用 `web` 或你的 profile 名。装进 `desktop` 时建议先退出 Desktop 应用（CLI 会等 profile 写锁），装完再打开；无论如何都要重启才生效。`add` 会自动把包追加进 profile 的 `dsh.profile.bundles`，**不需要**手工编辑 profile 的 `cordis.patch.yml`；重复执行是安全的。

也可以从本地仓库跑安装脚本：

```bash
node scripts/install.mjs --profile desktop            # 幂等；不会重启 DSH
node scripts/install.mjs --profile desktop --dry-run  # 只打印计划
```

然后**重启 DSH**，打开任意会话，从会话头部展开右侧边栏（**「打开侧边栏」/「Open sidebar」**），在边栏的引导页里点 **「侧边会话」**（English 界面显示 Side chat）卡片，侧边会话会作为该栏的一个原生 tab 打开。**没有独立的侧边会话按钮，也没有浮层**：入口就在右侧边栏的引导页（已开其它 tab 时，可用 tab 条上的「+」控件打开引导页）。发送第一条消息——侧边会话在首条消息发送时才创建，关闭 tab 即销毁；收起侧边栏或切到别的 tab 只是暂停，不销毁；只打开 tab 不发送不产生任何会话或开销。

## 它做什么

- **右侧边栏原生 tab**：作为右侧边栏里的一个 tab 存在，没有独立按钮、没有浮层。
- **继承上下文**：父会话已完成的轮次，加上主会话此刻正在做什么的实时快照。
- **继承 agent**：相同工作目录、preset 组合、工具、技能、模型路由、sandbox 模式与审批策略。
- **真实改文件**：write / edit / bash 的改动落在同一工作区，主会话能看到。
- **隔离 transcript**：侧边会话的对话不写主会话、不进会话列表、不进 subagent 目录。
- **关闭即销毁**：关闭 tab 时 agent 被 dispose，host 会尝试删除它的落盘产物；侧边会话无法再次打开。收起侧边栏或切换 tab 只是暂停。

## 兼容性

- 在 DSH `0.2.1-rc.2`（Desktop profile，Web GUI）上验证：在 desktop profile 的隔离副本里实测插件启动、7 条 host 路由响应、client bundle 正常 serve。
- 本包**未声明** `engines.dsh` / DSH peer 依赖，因此安装时没有版本阻断；这与「已验证版本」是两件事——更新的 DSH 版本未经验证。
- 仅 Web 平台（`dsh.client.platform: web`），没有 CLI/TUI 界面。
- Node.js `>= 22`；插件本身是零依赖 ESM，不 import 任何 `@deepseek-ai/*`。
- 界面文案跟随 DSH 语言设置（Settings → General → Language / 语言）：内置中文与英文；其它语言回退到英文。技术细节——host 错误 message、路由、事件名与工具名——保持英文原文。

## 已知限制

- **侧边会话 tab 内不呈现审批提示**：侧边会话继承父会话的审批策略；父策略需要人工确认时，侧边会话会等待。要真实改文件，建议用 `danger-full-access` 这类不需要交互确认的策略。
- 每个父会话在每个侧边栏分栏（pane）里只有一个侧边会话 tab；再次点引导页卡片会聚焦已有 tab。
- tab 关闭后无法恢复：重新打开引导页卡片会开始一个新的侧边会话，agent 在下次发消息时才创建。
- P1 已设计未实现：模型选择器、单会话多个侧边会话、GUI 重启后恢复侧边会话、tab 内审批呈现。
- 继承的上下文是创建时的快照，之后主会话的新消息不会推给已存在的侧边会话。
- 回复不是逐 token 流式渲染：assistant 消息在提交后才出现，期间显示运行中指示。
- 首条消息的请求大小约等于主会话的下一次请求（因为它带着继承历史）。

## 文档

- [docs/USAGE.md](docs/USAGE.md) — 完整语义（继承/隔离/修改/生命周期/安装/回滚/排障，英文）。
- [docs/DESIGN.md](docs/DESIGN.md) — 范围、阶段与对抗性推演。
- [docs/CONTRACT.md](docs/CONTRACT.md) — host 路由、右侧边栏 tab 集成与渲染契约。

## 仓库结构

| 路径 | 作用 |
|---|---|
| `lib/index.js` | host 半部：路由、fork seed、boundary 注入、close/dispose |
| `lib/client.js` | client 半部：右侧边栏 tab 类型 + 引导页入口，以及 tab 正文（消息区 + composer） |
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
