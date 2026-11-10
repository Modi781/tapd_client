# 打包与发版

发布物是 macOS universal dmg（arm64 + x86_64），其中 `tapd-mcp` sidecar 会被打进 `TAPD Client.app/Contents/MacOS/tapd-mcp`，用户无需单独安装 MCP 二进制。

## 1. 本地打包

```bash
pnpm install
pnpm build            # 本机架构；先构建 sidecar，再 tauri build
pnpm build:universal  # universal；需要 rustup target add x86_64-apple-darwin
```

产物：

```text
target/<target>/release/bundle/macos/TAPD Client.app
target/<target>/release/bundle/dmg/TAPD Client_<version>_<arch>.dmg
```

sidecar 的命名规则由 Tauri 决定，构建脚本会自动生成到 `apps/desktop/src-tauri/binaries/`（已在 `.gitignore` 中忽略）：

```text
tapd-mcp-aarch64-apple-darwin
tapd-mcp-x86_64-apple-darwin
tapd-mcp-universal-apple-darwin   # 由 lipo 合并，universal 打包使用
```

## 2. CI

| 工作流 | 触发 | 内容 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | push `main`、PR、手动 | 前端类型检查、Rust check/test、sidecar 构建 |
| `.github/workflows/release.yml` | push `release`、push `v*` tag、手动 | universal app + dmg，上传 artifact |

`release` 分支的每次推送都会跑一次完整打包，产物在 Actions 页面的 artifact 中，名为 `tapd-client-<version>-universal-<run_number>`。推送 `v*` tag（例如 `v0.1.0`）时会额外创建 GitHub Release，附带 dmg 与 `SHA256SUMS.txt`。

手动触发：Actions → Release → Run workflow。

## 3. 发版步骤

1. 改版本号：`package.json`、`apps/desktop/package.json`、`apps/desktop/src-tauri/tauri.conf.json`（`Cargo.toml` 的 workspace version 同步）。
2. 本地验证：`pnpm typecheck && pnpm test:rust && pnpm build:universal`。
3. 提交并推送 `release` 分支，等 CI 打包通过。
4. 打 tag 并推送，生成 GitHub Release：

```bash
git tag v0.1.0
git push origin v0.1.0
```

## 4. 签名与公证（可选）

默认产物未签名，用户首次打开需要到「系统设置 → 隐私与安全性」允许。配置以下 repository secrets 后，`release.yml` 会自动启用签名（有 `APPLE_CERTIFICATE` 时）：

| Secret | 说明 |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application 证书的 base64 |
| `APPLE_CERTIFICATE_PASSWORD` | 证书导出密码 |
| `APPLE_SIGNING_IDENTITY` | 例如 `Developer ID Application: Example (TEAMID)` |
| `APPLE_ID` | 公证用 Apple ID（可选） |
| `APPLE_PASSWORD` | App 专用密码（可选） |
| `APPLE_TEAM_ID` | Team ID（可选） |

## 5. 常见问题

- **`resource path binaries/tapd-mcp-... doesn't exist`**：还没构建 sidecar，运行 `pnpm build:sidecar` 或直接用 `pnpm build`。
- **universal 构建报缺少 target**：`rustup target add aarch64-apple-darwin x86_64-apple-darwin`。
- **CI 安装依赖失败**：确认 `pnpm-lock.yaml` 已随提交更新（`pnpm install` 后提交）。
