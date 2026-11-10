# Agent 修复队列（M7）

M7 把「处理缺陷」接到 opencode：导出 Markdown → 串行队列 → PTY 中启动 opencode TUI → 自动注入修复任务 → 客户端内嵌终端实时查看/接管。

## 1. 配置

设置 → Agent 修复：

| 配置 | 说明 |
| --- | --- |
| opencode 路径 | 默认 `opencode`（走 PATH），也可填绝对路径；「检测版本」会执行 `opencode --version` |
| 项目仓库映射 | 每个 TAPD 项目对应一个本地仓库绝对路径；缺失时任务会直接失败并提示去配置 |
| prompt 模板 | 支持变量 `{{title}}`、`{{md_path}}`、`{{repo_path}}`、`{{workspace_name}}`、`{{bug_id}}`、`{{severity}}`、`{{priority}}`；默认模板要求提交代码并回写 TAPD |
| TUI 就绪静默 | 有输出后静默多久认为 TUI 就绪，默认 900ms |
| 就绪超时 | 最长等待，默认 15s；超时会强制注入并记录 warning |
| 自动打开控制台 | 任务启动时自动打开终端窗口 |

配置文件：`~/Library/Application Support/com.tapdclient.desktop/agent.json`。

## 2. 触发方式

- 缺陷详情 →「用 Agent 修复」。
- 通知窗口 →「处理」（M6 完成改派/接受后触发 `agent://enqueue`）。

任务入队后：

1. 状态 `queued`，立即返回前端（提示“已加入队列”）。
2. `preparing`：调用 M4 导出，生成 `bug.md` + `assets/` + `bug.json`。
3. 校验仓库映射、opencode 可执行文件。
4. `running`：在仓库目录用 portable-pty 启动 `opencode` 完整 TUI。
5. 检测 TUI 就绪（输出静默或超时），写入渲染后的 prompt + 回车。
6. 进程退出：exit 0 → `succeeded`，否则 `failed`。

严格串行：同一时间只允许一个任务处于 preparing/running；后续任务排队，前一个退出后自动启动。

## 3. 控制台

- 独立窗口 `Agent 控制台`，xterm.js 全屏终端。
- 标题栏显示任务标题、状态、仓库路径、队列长度、退出码。
- 支持键盘输入直通 PTY、窗口缩放同步 cols/rows。
- 操作：中断（kill 子进程）、重试（新建任务）、打开导出目录。
- 输出实时写入 `agent-logs/<taskId>.log`；重开窗口会回放日志尾部。

## 4. 任务与恢复

- 文件：`~/Library/Application Support/com.tapdclient.desktop/agent-tasks.json`
- 状态：`queued | preparing | running | succeeded | failed | canceled`
- 客户端重启时，遗留的 `preparing/running` 会标记为 failed（“客户端重启”），`queued` 任务继续执行。
- 取消只对 opencode 直接子进程发信号；它派生的孙进程可能残留，需要手动清理。

## 5. TAPD 回写

默认 prompt 的第 4 步要求 agent 提交代码并回写 TAPD。MCP 提供：

- `tapd_get_bug_transitions`：读取当前状态与允许的下一步。
- `tapd_add_bug_comment`：追加「原因 / 方案 / 影响范围」评论。
- `tapd_update_bug_status`：把状态更新到目标（支持中文名或 key）；若不能直接到达，会先自动接受再流转。

写操作受 TAPD 工作流约束；非法流转会返回允许的下一步，agent 可据此调整。所有写操作都记录在客户端日志。

## 6. 安全与边界

- 仓库映射由用户显式配置，客户端不会自动猜测项目路径。
- prompt 明确要求不自行 `git commit` / `push`，但最终由 AI 与仓库权限决定，建议在专用分支/工作区使用。
- 客户端只负责启动 TUI 和注入首条消息；后续交互、权限确认都在终端内由用户控制。
- 输出按批解码，极端情况下批边界可能拆开多字节字符；日志文件保存原始字节，不受影响。

## 7. 人工验收

1. 设置 → Agent 修复：填 `opencode`，点「检测版本」；为当前项目填仓库绝对路径；保存。
2. 缺陷详情 →「用 Agent 修复」：提示加入队列并弹出控制台。
3. 观察状态 `queued → preparing → running`，TUI 出现后自动提交 prompt。
4. 再入队第二个缺陷：显示排队，第一个退出后才启动。
5. 测试中断/重试、重启客户端后的任务恢复。

如需不依赖 opencode 做 PTY 冒烟测试，可将 binaryPath 临时指向 `fixtures/fake-agent.sh`（会打印 READY 并回显输入），测试完恢复为 opencode。
