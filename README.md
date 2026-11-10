<div align="center">

<img src="assets/icon.png" width="96" alt="TAPD Client" />

# TAPD Client

**你的工作从未如此轻松。**

缺陷、需求、通知和 AI 修复，全在同一个窗口里完成。<br />
TAPD，终于像一个真正的桌面客户端。

<p>
  <a href="https://github.com/wwog/tapd_client/releases/latest">
    <img src="https://img.shields.io/badge/%E4%B8%8B%E8%BD%BD-macOS%20arm64-0A84FF?style=for-the-badge&logo=apple&logoColor=white" alt="下载 macOS arm64 版" />
  </a>
  <a href="docs/MCP.md">
    <img src="https://img.shields.io/badge/MCP-12%20tools-34C759?style=for-the-badge" alt="MCP 12 tools" />
  </a>
  <a href="CHANGELOG.md">
    <img src="https://img.shields.io/github/v/release/wwog/tapd_client?style=for-the-badge&label=version&color=1F2937" alt="版本" />
  </a>
</p>

<img src="assets/screenshots/login.png" width="100%" alt="TAPD Client 登录页：企业微信扫码" />

<sub>扫码登录 · 登录态只留在本机</sub>

</div>

## 打开它，然后少开一个浏览器

**不用再开浏览器。**  
企业微信扫一下就进；登录态只留在本机 WebView，过期自动回到扫码页。

**缺陷一眼看完。**  
我的 / 全部、状态、优先级、严重程度、关键词都在一行；详情从右侧滑出，和列表并排。

**新 Bug 会先找到你。**  
新建、转派、重新打开，顶部胶囊直接弹出；处理、查看、忽略，不用切窗口。

**修 Bug 也能排队。**  
交给 opencode 串行执行，权限在客户端里批，日志随时看，终端一键恢复。

**复杂改动，先看一眼。**<br />
Agent 拿不准时停下来等你审核：通过就提交，不想现在处理就储藏改动、暂停队列，代码不会丢。

**把 TAPD 交给 AI。**  
MCP 一键接入 opencode / ZCode / Claude Code / Cursor / Codex，12 个工具；写操作可关，调用可审计。

**AI 也能反过来提醒你。**<br />
任务完成、失败、需要确认，AI 在顶部胶囊弹一条；你点完，结果直接回到对话里。

**没网也不空屏。**  
项目、列表、详情先读本机 SQLite 快照，再后台刷新；上次看过的东西，打开就在。

## 还有这些小事，替你做掉了

- 附件、图片、视频在详情里直接预览，按默认应用打开。
- 处理人 / 开发人员直接下拉改，详情底部可评论、流转状态；不是自己的缺陷先认领。
- 新缺陷一键改派给自己，并流转到处理中。
- Markdown 导出：`bug.md` + `assets/` + `bug.json`，直接喂给 AI。
- 首启三步引导、脱敏诊断包、本地数据一键清理。
- 缺陷列表每 30 秒静默自动刷新，窗口不可见时暂停，回来立即补一次。
- 启动自动检查更新，之后每两小时一次，胶囊里显示下载进度。

## 三步，开始工作

1. **下载** [最新 macOS arm64 版](https://github.com/wwog/tapd_client/releases/latest)，拖进「应用程序」。
2. **扫码** 用企业微信扫一下，登录态留在本机。
3. **开工** 选项目、看缺陷、把该修的丢进 AI 队列。

> 首次打开若被 macOS 拦下，到「系统设置 → 隐私与安全性」允许一次即可。

## 深入了解

| 文档 | 内容 |
| --- | --- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 系统结构、模块地图、关键链路与设计取舍 |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | 开发命令、首次运行、本地数据位置 |
| [MCP.md](docs/MCP.md) | 12 个工具、AI 通知格式、Agent 审核、客户端接入、策略与审计 |
| [NOTIFICATIONS.md](docs/NOTIFICATIONS.md) | 通知范围、轮询、去重与 AI 卡片 |
| [AGENT.md](docs/AGENT.md) | 修复队列、审核与任务状态 |
| [RELEASE.md](docs/RELEASE.md) | 打包、签名与发版 |
| [PLAN.md](docs/PLAN.md) | 阶段计划与验收记录 |
| [spike.md](docs/spike.md) | TAPD 内部接口验证 |

## 参与开发

```bash
pnpm install
pnpm dev
```

更多命令与 CI 说明见 [DEVELOPMENT.md](docs/DEVELOPMENT.md)。

<div align="center">
<br />

### 你的工作从未如此轻松

[下载 TAPD Client](https://github.com/wwog/tapd_client/releases/latest)

macOS 11+ · Apple Silicon · 自动更新

</div>
