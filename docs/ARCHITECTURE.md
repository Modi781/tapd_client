# 架构说明

> 面向维护者：系统由哪些部分组成、一次请求怎么流动、为什么这样取舍。
> 产品介绍见 [README](../README.md)，构建与本地数据见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 1. 总览

TAPD Client 是一个 Tauri 2 桌面应用：

- **前端**：React + TypeScript + Vite，主窗口与通知胶囊两个入口。
- **后端**：Rust，负责窗口、命令、会话桥、缓存、轮询、Agent 与本地 HTTP。
- **`tapd-core`**：与 Tauri 无关的模型、过滤器、响应解析、Markdown 导出与配置存储。
- **`tapd-mcp`**：stdio MCP sidecar，随 App 打包，供外部 AI 客户端调用。

```
┌──────────────────────────── TAPD Client.app ────────────────────────────┐
│                                                                         │
│   React UI                         Rust Core                            │
│   主窗口 / 通知胶囊  ◄── IPC ──►   命令、状态、事件                     │
│         │                              │                                │
│         │                    ┌─────────┴──────────┐                     │
│         │                    ▼                    ▼                     │
│         │            Web Session Bridge     Local HTTP (axum)          │
│         │            隐藏 WKWebView          127.0.0.1 + token         │
│         │                    │                    ▲                     │
│         │                    ▼                    │                     │
│         │              www.tapd.cn          MCP sidecar                 │
│         │                                   (tapd-mcp, stdio)           │
│         │                                        ▲                     │
│         └── cache.sqlite3 ◄── 缓存 / 轮询         │                     │
│                                       外部 AI 客户端（opencode 等）     │
│                                                                         │
│   Agent Queue ── 每个任务一个 opencode serve ── /event 订阅 / 权限回复  │
└─────────────────────────────────────────────────────────────────────────┘
```

## 2. 进程与边界

| 部分 | 生命周期 | 职责 |
| --- | --- | --- |
| 主窗口 | 随 App | 项目、缺陷列表、详情、Agent、MCP、设置 |
| 隐藏 WebView | 随 App | 持有 tapd.cn 登录态；执行注入脚本抓取网页内部接口 |
| 通知胶囊 | 随 App | 自绘通知与更新进度，可拖动 |
| 本地 HTTP | 随 App | 仅监听 `127.0.0.1`，随机端口，每次启动轮换 token |
| `tapd-mcp` | 由 AI 客户端启动 | stdio MCP，反向调用本地 HTTP |
| `opencode serve` | 每个 Agent 任务 | 修复会话，Rust 订阅事件流并转成 UI 状态 |

登录页不是独立窗口：主窗口直接镜像隐藏 WebView 里的企业微信二维码，扫码完成后隐藏 WebView 保留会话。

## 3. 关键链路

### 3.1 登录与会话

1. `LoginGate` 显示二维码；`session.rs` 轮询扫码状态。
2. 扫码确认后隐藏 WebView 继续持有 Cookie，主窗口进入业务视图。
3. 会话失效时自动回到扫码页。
4. 退出登录逐条删除 TAPD Cookie 并清空 WebView 数据，避免旧页面加载后自动登回。

### 3.2 缺陷读取与离线缓存

```
React → Tauri command → feature_router → session bridge（隐藏 WebView 内注入 JS）
      → tapd-core 解析 / 过滤 → cache.sqlite3 → 前端渲染
```

- 项目、缺陷列表、详情都先读 SQLite 快照，再后台刷新。
- 只有首次登录且无缓存时才显示骨架屏。
- 缓存是**按查询的按需快照**，不是完整的后台同步引擎。
- `snapshots` 存列表类快照，`bugs` 存缺陷行，`agent_tasks` 记录任务与 bug / session / 日志的关系。

### 3.3 新缺陷通知

1. `notification.rs` 按配置轮询（范围：我的 / 当前项目）。
2. 「我的」范围跨项目轮询，每个项目独立的 cursor / baseline，并与 seen 去重游标统一。
3. 检测到新建、转移、重新打开后写入通知状态，胶囊展开自绘卡片。
4. 「处理」自动改派给自己并把起始状态流转到处理中，成功后进入 Agent 队列。

### 3.4 修复队列与 Agent

1. 从缺陷生成 Markdown 包（`bug.md` + `assets/` + `bug.json`）。
2. 队列固定并发 1，每个任务启动私有 `opencode serve`。
3. Rust 订阅 `/event` 判断轮次完成与权限请求，任务结束自动回收进程并继续队列。
4. 等待审核时可在 Agent tab 或胶囊里「允许一次 / 总是允许 / 拒绝」。
5. 输出写日志文件；「终端恢复」用 `opencode -s <session>` 打开 Terminal。

### 3.5 MCP 调用

```
AI 客户端 → tapd-mcp (stdio) → POST /mcp/call → mcp.rs
          → 策略检查（写操作 / 项目白名单 / 状态白名单）
          → 会话桥读取或写回 TAPD → mcp_audit.rs 记录
```

- 工具共 9 个：whoami、项目、查询、我的缺陷、详情、导出、状态查询、评论、状态更新。
- 写操作可整体关闭；审计只记录工具、客户端、结果、耗时与项目 / 缺陷，不保存评论正文和 Cookie。
- 「接入 AI 客户端」把 sidecar 路径幂等写入 opencode / ZCode / Claude Code / Cursor / Codex 的用户级配置，并自动备份。

## 4. 已实现能力

### 窗口与交互

- 隐藏 WebView 持有 tapd.cn 会话；登录页把企业微信二维码原样镜像进主窗口，不弹出独立登录窗口。会话失效自动回到扫码页；退出登录逐条删除 TAPD Cookie 并清空 WebView 数据。
- 项目切换（默认上次项目）、我的 / 全部缺陷、状态 / 优先级 / 严重程度 / 关键词筛选、分页。
- 项目 tab：独立管理项目显示、本地文件夹与 Agent 规则；文件夹支持拖入，改动自动保存。
- 缺陷表格：各列有最小宽度，窗口变窄时横向滚动；「操作」列固定在右侧（查看详情 / 在 TAPD 打开 / 复制链接 / Agent 修复）。
- 主窗口外壳：无系统标题栏（macOS Overlay），左侧图标栏 + 可拖拽项目栏 + 浮起的白色内容面板；项目栏拖到最小宽度以下或窗口过窄时自动收起；右键可本地隐藏项目，只剩一个项目时自动隐藏整个项目栏。
- 缺陷详情右侧面板：Codex 风格的第三列，从右侧滑入并与内容区并排，左缘可拖动调宽；窗口过窄时先收起项目列表，仍不够再向左扩张。打开详情只刷新这一条缺陷，不触发列表刷新；内容含基本信息、描述、资源、变更记录、评论、自定义字段。
- 资源查看：资源行有独立「预览」按钮（缩放 / 左右切换 / 缩略图条 / Esc 关闭，支持图片与视频），「打开」按默认应用打开，下拉只负责切换默认应用。
- 顶部状态胶囊：常驻展示通知状态；Agent 运行时切换为「Agent 运行中」，等待权限确认时变为「Agent 待审核」。可拖动并记住位置，单击展开通知 / 打开 Agent 任务，双击打开主窗口。
- 请求抓包：设置底部「接口抓包」自动记录网页内部接口，支持查看与导出 JSON。
- MD 导出：`bug.md` + `assets/` + `bug.json`，含 frontmatter、描述、资源、变更记录、评论；视频 / 图片 / 日志按需下载。
- 账户与会话：从设置中拆成独立视图，入口是项目栏底部的用户按钮；项目栏收起时头像缓动到左侧图标栏。

### 数据与通知

- 离线优先：项目列表、缺陷列表与详情先渲染 SQLite 缓存，再后台刷新；只有首次登录且无缓存时显示骨架屏。刷新期间标题栏居中显示「更新中」。
- 新缺陷通知：顶部胶囊展开自绘卡片（处理 / 查看 / 忽略），支持范围（我的 / 项目）、类型（新建 / 转移 / 重新打开）、轮询、免打扰、模拟通知。「我的」范围跨项目增量轮询，每个项目独立 cursor / baseline，并与 seen 去重游标统一。
- 处理动作：自动改派给自己，并把起始状态流转到处理中（`in_progress` / `progressing`），成功后进入 Agent 队列。

### Agent

- Agent tab：运行栏只显示排队 / 运行 / 待审核任务，结束或取消的任务自动进入历史；不内嵌 TUI，opencode 的 IO 写入日志文件，可「查看日志」或「终端恢复」（`opencode -s <session>` 打开 Terminal）。
- Agent 运行时：每个任务启动私有 `opencode serve`，TUI 通过 `--server` 连接；Rust 订阅 `/event` 判断轮次完成与权限请求，完成后自动回收进程并继续队列。任务与 bug / session / 日志关系同步写入 `agent_tasks` 表。
- 项目级配置：每个项目的本地文件夹与「项目规则」写在自己的项目卡片里；Agent 区只放 agent 参数，默认提示词模板自带 `{{project_rule}}` 段落；未配置目录时点 Agent 修复会先要求选择目录。

### MCP 与运维

- MCP tab：9 个工具（whoami / 项目 / 查询 / 我的缺陷 / 详情 / 导出 / 状态查询 / 评论 / 状态更新）；「接入 AI 客户端」按客户端一行，一键写入 opencode / ZCode / Claude Code / Cursor / Codex 的用户级配置（自动备份、幂等）；启动 Agent 时也会幂等确保注入 opencode。
- MCP 策略与审计：可关闭写操作、限制可访问项目、限制目标状态白名单；每次调用记录工具、客户端、允许 / 拒绝 / 失败、耗时与项目 / 缺陷（不保存评论正文和 Cookie），支持筛选、导出与清空。
- 首启引导：首次登录后展示三步引导（登录与离线缓存 / MCP 与 Agent / 通知与胶囊），可跳过，完成状态写入 `config.json`。
- 自动更新：启动后检查 GitHub Releases，之后每小时查询一次并记录检查时间；标题栏更新图标在有新版本时变绿，hover 展示更新日志。更新期间主窗口隐藏，胶囊放大 4 倍显示下载 / 解包安装进度；失败时可手动下载或取消。
- 诊断包：设置 → 运行信息一键导出脱敏 zip，包含版本与系统信息、脱敏配置、通知设置、Agent 摘要、MCP 审计和最近日志；不包含 Cookie、本地 API token、请求 / 响应正文。
- 清理缓存：设置 → 本地数据一键删除应用数据目录下的全部内容，随后自动重启；删除在下次启动时、日志与 SQLite 打开前执行，目录来自 `AppPaths`；导出目录不受影响。
- 本地回环 API：随机端口 + 每次启动轮换 token，`runtime.json` 0600。

## 5. 模块地图

```
apps/desktop/
  src/
    App.tsx                  主窗口路由与整体布局
    components/              LoginGate、列表、详情、Agent、MCP、设置、引导、胶囊视图
    lib/                     前端 API、缓存、通知、Agent、MCP、更新封装
    windows/IslandWindow.tsx 通知胶囊窗口
  src-tauri/src/
    session.rs               隐藏 WebView、同步 / 异步桥、Cookie
    inject.js                抓包与 __TAPDCB__ 请求助手
    commands.rs              Tauri 命令（会话、缺陷、MCP 配置、媒体打开方式）
    feature_router.rs        通知 / Agent / 缓存 / MCP 的统一命令路由
    cache.rs                 SQLite 离线快照缓存
    notification.rs          轮询、分类、通知窗口、接受动作
    agent.rs                 Agent 队列、PTY、opencode server 事件、任务持久化
    opencode.rs              opencode serve / SSE / 权限回复适配
    mcp.rs                   MCP 工具调度、策略强制与审计记录
    mcp_audit.rs             有界 MCP 调用审计（JSON，脱敏摘要）
    mcp_import.rs            各 AI 客户端配置一键注入
    export.rs                MD 导出与资源下载
    diagnostics.rs           脱敏诊断包
    server.rs                本地 HTTP（/healthz、/mcp/call、调试端点）
    update.rs                GitHub Releases 检查与更新状态
    reset.rs / open_with.rs  本地数据清理 / 按默认应用打开资源
crates/tapd-core/            模型、过滤器、响应解析、Markdown、配置与存储
crates/tapd-mcp/             MCP stdio sidecar
docs/                        架构、开发、计划、接口、通知、Agent、MCP、发版
fixtures/                    假 agent 等测试辅助
scripts/                     图标、sidecar、发版等构建工具
```

## 6. 设计取舍

- **复用网页会话，不走 Open API**：保持与公司账号 / SSO 一致，代价是依赖未公开的内部接口，改版时需要更新 `tapd-core` 适配层。
- **缓存是快照**：优先保证打开即见，不做全量后台同步与离线搜索。
- **Agent 并发固定 1**：同一时间只有一个任务占用仓库，避免互相踩踏。
- **通知自绘**：不使用系统通知，才能承载处理 / 查看 / 忽略三个动作与更新进度。
- **写操作收窄**：MCP 只开放评论与状态更新，不提供删除、改处理人、批量操作。
- **本地 API 最小暴露**：随机端口 + 每次启动轮换 token，`runtime.json` 权限 0600。
- **不做未读与托盘角标**：TAPD 没有提供缺陷通知的已读状态，客户端不自行发明计数。

## 7. 当前限制

- 仅 macOS（发布物为 Apple Silicon arm64）。
- 通知的「项目」范围仍只轮询当前项目；「我的」范围已跨项目轮询。
- `assigned_time` 缺失时“转移”判定偏保守。
- Agent 就绪检测是启发式的；取消只杀直接子进程，opencode 派生的孙进程可能残留。
- 发布包默认未签名、未公证；首次打开需在「系统设置 → 隐私与安全性」中允许。
- TAPD 网页内部接口未公开，改版时需要更新适配层。

## 8. 下一步

1. 完整的跨项目缓存同步与离线搜索。
2. 如确有需要，再扩展「项目」范围的多项目轮询与更细的游标策略。
3. 签名 / 公证发布，以及 MCP 调用限流与按 `clientInfo.name` 的独立策略档案。
4. 多 Agent / 并发队列（当前固定并发 1，是刻意约束）。

更完整的阶段计划与验收记录见 [PLAN.md](PLAN.md)，接口验证见 [spike.md](spike.md)。
