# TAPD Client

Tauri 2 桌面客户端：复用 TAPD 网页登录态，重建缺陷视图，支持按处理人/状态筛选、缺陷详情、MD 导出，并通过 MCP 只读服务把缺陷交给 AI（已在 opencode v2.0.29 验证）。

当前进度：**M0–M5 已完成**。SQLite 缓存、新缺陷通知窗口、opencode 自动修复队列尚未实现。

- 完整计划：[docs/PLAN.md](docs/PLAN.md)
- 接口验证：[docs/spike.md](docs/spike.md)
- MCP 接入：[docs/MCP.md](docs/MCP.md)

## 已实现

- 隐藏 WebView 登录 tapd.cn，登录态持久化、失效自动重新弹窗。
- 项目切换（默认上次项目）、我的/全部缺陷、状态/优先级/严重程度/关键词筛选、分页。
- 缺陷详情抽屉：基本信息、描述、资源、评论、自定义字段，可直接跳转 TAPD。
- 请求抓包：自动记录网页内部接口，支持查看与导出 JSON（M0 工具，保留）。
- MD 导出：`bug.md` + `assets/` + `bug.json`，含 frontmatter、描述、附件、评论；视频/图片/日志按需下载。
- MCP 只读服务：6 个工具（whoami / 项目 / 缺陷查询 / 我的缺陷 / 详情 / 导出），opencode 可直接连接。
- 本地回环 API：随机端口 + 每次启动轮换 token，`runtime.json` 0600。

## 开发

前置：Node 20+、pnpm、Rust 1.85+、Xcode Command Line Tools。

```bash
pnpm install
pnpm dev              # 启动 Tauri 开发窗口
pnpm typecheck        # 前端类型检查
pnpm check:rust       # Rust 编译检查
cargo test -p tapd-core
cargo build -p tapd-mcp
```

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
5. 在设置页复制 opencode 的 MCP 配置。

## 目录结构

```
apps/desktop/            Tauri 应用（React 前端 + Rust 后端）
  src-tauri/src/
    session.rs           隐藏 WebView / 同步+异步桥 / Cookie
    inject.js            抓包与 __TAPDCB__ 请求助手
    commands.rs          Tauri 命令（会话、缺陷、MCP 配置）
    mcp.rs               MCP 工具调度（只读）
    export.rs            MD 导出与资源下载
    server.rs            本地 HTTP（/healthz、/mcp/call、调试端点）
crates/tapd-core/        模型、过滤器、响应解析、Markdown 渲染
crates/tapd-mcp/         MCP stdio sidecar
docs/                    计划、接口验证、MCP 文档
scripts/                 图标等本地工具
```

## 本地数据

- 数据目录：`~/Library/Application Support/com.tapdclient.desktop`
- 日志：`<数据目录>/logs/`
- 抓包导出：`<数据目录>/captures/`
- 缺陷导出：`~/Documents/TAPDClient/exports/<项目>-<id>/<缺陷>-<slug>/`
- `runtime.json`：本地 API 端口与 token（0600）

## 当前限制

- 仅 macOS。
- 数据实时请求 TAPD，尚未落 SQLite；因此没有离线列表与本地增量通知。
- MCP 为只读；写评论/改状态/指派仅预留。
- 新缺陷弹窗通知与 opencode 修复队列未实现。
- 打包尚未嵌入 sidecar；当前 opencode 配置指向 `target/debug/tapd-mcp`。
- TAPD 网页内部接口未公开，改版时需要更新 `tapd-core` 适配层（已集中处理并附 fixtures 友好结构）。

## 下一步

1. M6：SQLite 缓存 + 增量轮询 + 自绘通知窗口（处理 / 查看 / 忽略）。
2. M7：opencode PTY 控制台 + 串行任务队列，打通「处理 → 导出 → 修复」。
3. M8：sidecar 打包进 App、universal dmg、MCP 策略设置与审计界面。
