# MCP 使用说明

TAPD Client 通过一个独立的 stdio sidecar（`tapd-mcp`）向 AI 客户端提供缺陷数据。sidecar 不直接访问 TAPD，而是把工具调用转发给正在运行的桌面客户端；会话、Cookie、过滤与导出都复用客户端。

## 1. 前提

- 桌面客户端已启动并完成 TAPD 登录。
- sidecar 与客户端使用同一个用户数据目录（`~/Library/Application Support/com.tapdclient.desktop`）。
- 客户端未运行时，sidecar 会尝试拉起已安装的 App；开发模式下请先运行 `pnpm dev`。

## 2. opencode 配置（v2.0.29 已验证）

在项目的 `opencode.json` 中加入（注意是 `mcp.servers`）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "tapd": {
        "type": "local",
        "command": ["/Users/user9527/projects/tapd_client/target/debug/tapd-mcp"]
      }
    }
  }
}
```

也可以直接用命令行注册到当前项目：

```bash
opencode mcp add tapd -- /Users/user9527/projects/tapd_client/target/debug/tapd-mcp
```

打包安装后的路径通常是：

```text
/Applications/TAPD Client.app/Contents/MacOS/tapd-mcp
```

验证：

```bash
opencode mcp list
# ✓ tapd  connected
```

> 注意：`opencode mcp list` 第一次执行时可能尚未加载项目配置，重跑一次即可；新增/修改工具后需要重启 opencode 让它重新拉取 `tools/list`。

## 3. 工具

共 9 个工具：6 个查询/导出 + 3 个修复后回写（评论、状态、状态查询）。

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `tapd_whoami` | 当前用户、公司、默认项目 | — |
| `tapd_list_projects` | 可访问项目列表 | — |
| `tapd_list_bugs` | 查询缺陷 | `workspace_id`、`owner`、`statuses`、`priorities`、`severities`、`keyword`、`only_unresolved`、`limit`、`page` |
| `tapd_list_my_bugs` | 我的未解决缺陷 | `workspace_id`、`limit`、`page` |
| `tapd_get_bug` | 完整详情（含 `embeddedMedia` 内嵌图片/视频、`changes` 变更记录） | `bug_id`（必填）、`workspace_id` |
| `tapd_export_bug_md` | 导出 MD 包 | `bug_id`（必填）、`workspace_id`、`workspace_name` |
| `tapd_get_bug_transitions` | 当前状态与允许的下一步 | `bug_id`（必填）、`workspace_id` |
| `tapd_add_bug_comment` | 追加评论（纯文本自动转富文本） | `bug_id`、`comment`（必填） |
| `tapd_update_bug_status` | 更新状态，可同时评论 | `bug_id`、`status`（key 或中文名）、`comment`、`fields` |

约定：

- `owner` 默认 `me`；可传 `all` 或精确 TAPD 昵称。
- `only_unresolved` 默认 `true`，仅在未显式传 `statuses` 时生效（`new` / `in_progress` / `reopened`）。
- `limit` 默认 20，最大 50；服务端最小页长 20，返回结果会在本地裁剪到 `limit`。
- `workspace_id` 省略时使用客户端上次选择的项目。
- 时间参数格式：`YYYY-MM-DD HH:MM:SS`。

示例调用（MCP 客户端内部）：

```json
{"tool": "tapd_list_bugs", "arguments": {"workspace_id": "45336192", "owner": "me", "limit": 10}}
{"tool": "tapd_get_bug", "arguments": {"workspace_id": "45336192", "bug_id": "1145336192001010606"}}
{"tool": "tapd_export_bug_md", "arguments": {"workspace_id": "45336192", "bug_id": "1145336192001010582"}}
{"tool": "tapd_get_bug_transitions", "arguments": {"bug_id": "1145336192001010582"}}
{"tool": "tapd_add_bug_comment", "arguments": {"bug_id": "1145336192001010582", "comment": "根因：草稿状态未写入 store。\n方案：补持久化并加回归测试。\n影响范围：会话详情草稿。"}}
{"tool": "tapd_update_bug_status", "arguments": {"bug_id": "1145336192001010582", "status": "已解决", "comment": "已修复并验证。"}}
```

写回规则：

- `status` 可传 key（`resolved`）或中文名（`已解决`）；中文会按项目状态别名映射。
- 若目标不能直接到达（例如 `new → 已解决`），客户端会自动先流转到处理中，再执行目标状态。
- `tapd_update_bug_status` 的 `comment` 会先追加评论，再进行状态流转；状态流转失败时评论仍保留，便于追溯。
- 如果需要填流转必填字段，可传 `fields` 数组，原样透传给 TAPD（通常留空）。

## 4. 导出产物

`tapd_export_bug_md` 返回：

```json
{
  "dir": "/Users/<you>/Documents/TAPDClient/exports/UU-45336192/<bug-id>-<slug>",
  "markdownPath": ".../bug.md",
  "assetCount": 1,
  "downloadedBytes": 2420002,
  "warnings": []
}
```

目录结构：

```
<bug-id>-<slug>/
├── bug.md        # 标题、基本信息、描述、资源（附件 + 内嵌）、变更记录、评论、自定义字段
├── bug.json      # 结构化数据
└── assets/       # 图片、视频、日志等原件
```

图片以内联 Markdown 引用，视频以链接引用；下载失败时保留 TAPD 原始 URL 并在 `warnings` 中说明。

## 5. 安全与边界

- sidecar 只能访问 `127.0.0.1` 上的客户端，使用每次启动轮换的 Bearer token（`runtime.json`，权限 0600）。
- Cookie 不写入文件、不返回给 AI；资源下载在客户端进程内完成。
- 写回仅开放「追加评论」和「更新状态」，不提供删除、改处理人、批量操作等工具。
- 写操作使用当前 TAPD 会话 Cookie + `dsc-token`，受 TAPD 工作流与权限约束；非法流转会被拒绝并把允许的下一步返回给 AI。
- 所有工具调用（含写操作）记录在客户端日志（数据目录 `logs/`），包含工具名、客户端、耗时与结果；写操作额外记录 bug id。

## 6. 常见问题

**`TAPD Client 未运行`**
启动桌面客户端，确认已登录，然后重试。开发模式需先 `pnpm dev`。

**`unauthorized`**
客户端重启后 token 会轮换。sidecar 会自动重读 `runtime.json` 并重试一次；仍失败时重启 AI 客户端。

**返回 0 条**
默认 `owner=me` 且只查未解决缺陷。可显式传 `"owner": "all"`、`"statuses": []`、`"only_unresolved": false` 验证权限与项目是否正确。

**`opencode mcp list` 显示未配置**
确认配置写在 `mcp.servers` 下（不是 `mcp.tapd`），并从项目根目录执行命令。
