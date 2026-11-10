# TAPD Client

「AI 驱动的 TAPD 通知/Agent 工具」

Tauri 2 桌面客户端：复用 TAPD 网页登录态，重建缺陷视图，支持按处理人/状态筛选、缺陷详情、MD 导出、可配置的新缺陷通知与 opencode 修复队列，并通过 MCP 服务把缺陷交给 AI：查询、详情、导出，以及修复后的评论与状态回写（已在 opencode v2.0.29 验证）。

当前进度：**M0–M8 已完成**：`tapd-mcp` sidecar 随 App 打包，`release` 分支（由 `main` 合并进入）由 GitHub Actions 生成 arm64 dmg；SQLite 离线缓存、Agent tab（内嵌终端 / 审核 / 历史）与 MCP tab 已接入。

- 完整计划：[docs/PLAN.md](docs/PLAN.md)
- 接口验证：[docs/spike.md](docs/spike.md)
- 通知配置：[docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md)
- Agent 队列：[docs/AGENT.md](docs/AGENT.md)
- MCP 接入：[docs/MCP.md](docs/MCP.md)
- 打包发版：[docs/RELEASE.md](docs/RELEASE.md)

## 已实现

- 隐藏 WebView 登录 tapd.cn，登录态持久化、失效自动重新弹窗；退出登录会逐条删除 TAPD Cookie 并清空 WebView 数据，不会因为旧页面仍在加载而自动登回。
- 项目切换（默认上次项目）、我的/全部缺陷、状态/优先级/严重程度/关键词筛选、分页。
- 离线优先：项目列表、缺陷列表与详情先渲染 SQLite 缓存（`cache.sqlite3`），再后台刷新；只有首次登录且无缓存时显示骨架屏。刷新期间标题栏居中显示「更新中」。
- 缺陷表格：各列有最小宽度，窗口变窄时表格横向滚动；「操作」列固定在右侧（查看详情 / 在 TAPD 打开 / 复制链接 / Agent 修复）。
- 主窗口外壳：无系统标题栏（macOS Overlay），左侧图标栏 + 可拖拽项目栏 + 浮起的白色内容面板；项目栏拖到最小宽度以下会自动收起，标题栏按钮可随时展开。
- 缺陷详情右侧面板：Codex 风格的第三列（非遮罩抽屉），从右侧滑入并与内容区并排，左缘可拖动调整宽度；窗口过窄时先自动向左扩张再展开。顶部只有关闭按钮、底部固定操作、中间内容滚动，打开面板后标题栏仍可拖动窗口。内容含基本信息、描述、资源（附件 + 描述/评论内嵌图片视频，带缩略图）、变更记录、评论、自定义字段，可直接跳转 TAPD。
- 资源查看：资源行有独立的「预览」按钮（缩放 / 左右切换 / 底部居中缩略图条 / Esc 关闭，图片与视频），「打开」按钮按已选的默认应用打开，下拉只负责切换默认应用。
- 顶部状态胶囊：常驻胶囊展示通知状态；Agent 运行时切换为「Agent 运行中」，等待权限确认时变为「Agent 待审核」，空闲时不显示 Agent 状态。可拖动并记住位置，单击展开通知 / 打开 Agent 任务、双击打开主窗口。
- 请求抓包：自动记录网页内部接口，支持查看与导出 JSON（M0 工具，保留）。
- MD 导出：`bug.md` + `assets/` + `bug.json`，含 frontmatter、描述、资源（附件 + 内嵌）、变更记录、评论；视频/图片/日志按需下载。
- 新缺陷通知：自绘弹窗（处理 / 查看 / 忽略），支持范围（我的/项目）、类型（新建/转移/重新打开）、轮询、免打扰、模拟通知。
- 处理动作：自动改派给自己，并把起始状态流转到处理中（`in_progress` / `progressing`），成功后进入 Agent 队列。
- Agent tab：内嵌 opencode TUI（不再是独立窗口），严格串行队列、自动注入 prompt、取消/重试；等待审核时可直接在 tab 或胶囊里「允许一次 / 总是允许 / 拒绝」。历史子页可筛选执行记录、查看 opencode 日志并跳转关联缺陷。
- Agent 运行时：每个任务启动私有 `opencode serve`，TUI 通过 `--server` 连接；Rust 订阅 `/event` 判断轮次完成与权限请求，完成后自动回收进程并继续队列。
- 项目级配置：每个项目的本地文件夹与「项目规则」写在自己的项目卡片里（文件夹可拖入或点「选择」打开目录选择器，改动失焦即保存）；Agent 区只放 agent 参数，默认提示词模板自带 `{{project_rule}}` 段落；未配置目录时点 Agent 修复会先要求选择目录，选完自动继续入队。
- MCP tab：9 个工具（whoami / 项目 / 查询 / 我的缺陷 / 详情 / 导出 / 状态查询 / 评论 / 状态更新）；「一键导入 opencode」会把 sidecar 合并进 opencode 全局配置（自动备份），之后启动 Agent 时也会幂等确保注入；另附 Claude Code / Cursor / Codex 接入教程。
- 本地回环 API：随机端口 + 每次启动轮换 token，`runtime.json` 0600。

## 开发

前置：Node 20.19+、pnpm 12、Rust 1.85+、Xcode Command Line Tools。

```bash
pnpm install
pnpm dev              # 启动 Tauri 开发窗口
pnpm typecheck        # 前端类型检查
pnpm check:rust       # Rust 编译检查
cargo test -p tapd-core
cargo build -p tapd-mcp
pnpm build            # 本机架构 app + dmg（自动先构建 sidecar）
pnpm build:arm64      # 显式 arm64 app + dmg（与 release CI 一致）
```

打包会把 `tapd-mcp` 放进 `TAPD Client.app/Contents/MacOS/`，设置页复制的 MCP 配置会直接指向该路径。发布流程见 [docs/RELEASE.md](docs/RELEASE.md)。

MCP 联调（需先 `pnpm dev` 并登录）：

```bash
opencode mcp add tapd -- "$PWD/target/debug/tapd-mcp"
opencode mcp list     # ✓ tapd connected
```

## 首次运行

1. 启动后自动弹出「登录 TAPD」窗口，完成公司账号 / SSO 登录。
2. 登录成功后窗口自动隐藏，客户端保留会话。
3. 选择左侧项目，默认展示「我负责的」缺陷；可切换「全部」。
4. 点击缺陷行打开详情；点击「导出 MD」生成可交给 AI 的缺陷包。
5. 设置 → Agent：填写 opencode 路径与当前项目仓库路径。
6. 设置 → 新缺陷通知：选择范围（我的/项目）与是否包含转移、重新打开。
7. 打开 MCP tab →「一键导入 opencode」，后续启动 Agent 会自动确保注入。
8. Agent tab：运行中查看内嵌终端与队列；「待审核」时在 tab 或胶囊里批准/拒绝；历史子页查看执行记录与日志。

## 目录结构

```
apps/desktop/            Tauri 应用（React 前端 + Rust 后端）
  src-tauri/src/
    session.rs           隐藏 WebView / 同步+异步桥 / Cookie
    inject.js            抓包与 __TAPDCB__ 请求助手
    commands.rs          Tauri 命令（会话、缺陷、MCP 配置、媒体打开方式）
    cache.rs             SQLite 离线快照缓存（项目/缺陷列表/详情）
    notification.rs      轮询、分类、通知窗口、接受动作
    agent.rs             Agent 队列、PTY、opencode server 事件、任务持久化
    opencode.rs          opencode serve / SSE / 权限回复适配
    mcp.rs               MCP 工具调度（只读）
    mcp_import.rs        opencode 全局配置一键注入
    export.rs            MD 导出与资源下载
    server.rs            本地 HTTP（/healthz、/mcp/call、调试端点）
    feature_router.rs    通知/Agent/缓存/MCP 的统一命令路由
crates/tapd-core/        模型、过滤器、响应解析、Markdown、存储
crates/tapd-mcp/         MCP stdio sidecar
docs/                    计划、接口验证、通知、Agent、MCP、发版文档
fixtures/                假 agent 等测试辅助
scripts/                 图标、sidecar 等本地/CI 构建工具
```

## 本地数据

- 数据目录：`~/Library/Application Support/com.tapdclient.desktop`
- 日志：`<数据目录>/logs/`
- 通知状态：`<数据目录>/notifications.json`
- 离线缓存：`<数据目录>/cache.sqlite3`（退出登录时清空）
- Agent 配置/任务/日志：`agent.json`、`agent-tasks.json`、`agent-logs/`、`agent-events/`
- 抓包导出：`<数据目录>/captures/`
- 缺陷导出：`~/Documents/TAPDClient/exports/<项目>-<id>/<缺陷>-<slug>/`
- `runtime.json`：本地 API 端口与 token（0600）

## 当前限制

- 仅 macOS。
- 数据实时请求 TAPD，尚未落 SQLite；没有离线列表与跨重启增量缓存。
- 通知轮询只覆盖上次选择的项目；`assigned_time` 缺失时“转移”判定偏保守。
- MCP 写回仅开放评论与状态更新；不提供删除、改处理人、批量操作。
- Agent 就绪检测是启发式的；取消只杀直接子进程，opencode 派生的孙进程可能残留。
- 发布包默认未签名、未公证；首次打开需要在「系统设置 → 隐私与安全性」里允许，或使用配置了签名的 CI 构建。
- TAPD 网页内部接口未公开，改版时需要更新 `tapd-core` 适配层（已集中处理并附 fixtures 友好结构）。

## 下一步

1. SQLite 缓存 + 跨项目增量轮询（与通知游标统一）。
2. M8 剩余：MCP 策略设置与审计界面、首启引导、诊断包。
3. 通知历史视图、托盘角标与未读计数。
4. Agent 任务常驻面板、并发数可配置（当前固定 1）。
