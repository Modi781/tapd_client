# Agent 修复队列

把「处理缺陷」接到 opencode：导出 Markdown → 串行队列 → PTY 中启动 opencode TUI → 自动注入修复任务 → 在 Agent tab 内嵌终端实时查看/接管；同时通过私有 `opencode serve` 事件流判断完成与权限审核。

## 1. 配置

设置 → Agent：

| 配置 | 说明 |
| --- | --- |
| opencode 路径 | 默认 `opencode`（走 PATH），也可填绝对路径；「检测版本」会执行 `opencode --version` |
| 项目仓库映射 | 每个 TAPD 项目对应一个本地仓库绝对路径；缺失时任务会失败并提示去配置 |
| prompt 模板 | 支持变量 `{{title}}`、`{{md_path}}`、`{{repo_path}}`、`{{workspace_name}}`、`{{bug_id}}`、`{{severity}}`、`{{priority}}`、`{{project_rule}}`；默认模板要求提交代码并回写 TAPD |
| TUI 就绪静默 | 有输出后静默多久认为 TUI 就绪，默认 900ms |
| 就绪超时 | 最长等待，默认 15s；超时会强制注入并记录 warning |

配置文件：`~/Library/Application Support/com.tapdclient.desktop/agent.json`。

启动任务前会幂等检查 opencode 全局配置是否包含 `tapd` MCP（与 MCP tab 的「一键导入 opencode」共用逻辑），失败只记录警告，不阻塞任务。

## 2. 触发方式

- 缺陷详情 →「用 Agent 修复」。
- 通知窗口 →「处理」（完成改派/接受后触发 `agent://enqueue`）。

任务入队后：

1. 状态 `queued`，立即返回前端（提示“已加入队列”）。
2. `preparing`：调用导出，生成 `bug.md` + `assets/` + `bug.json`。
3. 校验仓库路径（使用入队时已解析的 `repo_path`）、opencode 可执行文件，并确保 MCP 注入。
4. `running`：在仓库目录启动私有 `opencode serve`，再用 portable-pty 启动 `opencode --server http://127.0.0.1:<port>` TUI；Rust 订阅 server 的 `/event`。
5. 检测 TUI 就绪（输出静默或超时），写入渲染后的 prompt + 回车。
6. server 事件 `session.idle`（注入后带 ~2s 宽限）→ `succeeded`，自动回收 TUI/server 并继续下一个任务；`session.execution.failed` → `failed`。
7. 若 server/SSE 不可用，回退为仅 TUI + 进程退出码语义（任务日志会记录降级原因）。

严格串行：同一时间只有一个任务占用 worker；`preparing/running/waiting_review` 都算运行态，后续任务排队。

## 3. Agent tab

- 「运行」子页：内嵌 xterm 终端（不再是独立窗口），键盘输入直通 PTY，容器尺寸变化会同步 cols/rows。
- 头部显示任务标题、状态、项目/缺陷、仓库路径、队列/运行/待审核数量与退出码。
- 操作：中断（进程组 kill）、重试（新建任务）、打开导出目录、打开关联缺陷。
- 权限审核：opencode 发出权限请求时状态变为 `waiting_review`，终端上方出现「允许一次 / 总是允许 / 拒绝」，回复走 `POST /session/{id}/permissions/{pid}`；顶部胶囊同时变为「Agent 待审核」。
- 输出实时写入 `agent-logs/<taskId>.log`；切换任务会回放日志尾部。

## 4. 任务、历史与恢复

- 文件：`agent-tasks.json`（任务）、`agent-logs/`（TUI 与服务日志）、`agent-events/`（server 事件 JSONL，用于版本适配排障）。
- 状态：`queued | preparing | running | waiting_review | succeeded | failed | canceled`
- 「历史」子页：按项目 / 状态 / 关键词筛选执行记录，查看错误、prompt、退出码、日志尾部，并可跳转到关联缺陷。
- 客户端重启时，遗留的 `preparing/running/waiting_review` 会标记为 failed（“客户端重启”），`queued` 任务继续执行。
- 取消会先尝试 `POST /session/{id}/abort`，再 kill TUI + server 进程组；开放的其他子进程仍可能残留。

## 5. TAPD 回写

默认 prompt 的第 4 步要求 agent 提交代码并回写 TAPD。MCP 提供：

- `tapd_get_bug_transitions`：读取当前状态与允许的下一步。
- `tapd_add_bug_comment`：追加「原因 / 方案 / 影响范围」评论。
- `tapd_update_bug_status`：把状态更新到目标（支持中文名或 key）；若不能直接到达，会先自动接受再流转。

写操作受 TAPD 工作流约束；非法流转会返回允许的下一步，agent 可据此调整。所有写操作都记录在客户端日志。

## 6. 安全与边界

- 仓库路径由用户显式配置，客户端不会自动猜测项目路径。
- prompt 明确要求不自行 `git commit` / `push`，但最终由 AI 与仓库权限决定，建议在专用分支/工作区使用。
- 权限确认由用户在 Agent tab / 胶囊里决定，不会自动批准。
- 输出按批解码，极端情况下批边界可能拆开多字节字符；日志文件保存原始字节，不受影响。

## 7. 人工验收

1. 设置 → Agent：填 `opencode`，点「检测版本」；为当前项目填仓库绝对路径；保存。
2. 缺陷详情 →「用 Agent 修复」：提示加入队列并切到 Agent tab。
3. 观察状态 `queued → preparing → running`，TUI 出现后自动提交 prompt。
4. 再入队第二个缺陷：显示排队；第一个完成（server idle）后自动启动，而不是等终端退出。
5. 在 `opencode` 中触发一次需要批准的操作（如 `permissions` 配置为 `ask`）：胶囊显示「Agent 待审核」，在 tab 里允许/拒绝后任务继续。
6. 历史子页确认日志、退出码与「打开缺陷」跳转；测试中断/重试与重启恢复。

如需不依赖 opencode 做 PTY 冒烟测试，可将 binaryPath 临时指向 `fixtures/fake-agent.sh`（会打印 READY 并回显输入），测试完恢复为 opencode。
