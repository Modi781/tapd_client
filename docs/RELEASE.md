# 打包与发版

发布物是 macOS **arm64**（Apple Silicon）dmg，其中 `tapd-mcp` sidecar 会被打进 `TAPD Client.app/Contents/MacOS/tapd-mcp`，用户无需单独安装 MCP 二进制。不再产出 universal / x86_64 包。

## 1. 分支流程（重要）

- **日常开发在 `main`**：从 `main` 拉分支/提交 PR，CI 通过后合并回 `main`。
- **`release` 只接受来自 `main` 的合并**，不直接开发、不直接提交：

```bash
git checkout main
git pull
git checkout release
git merge --ff-only main     # 有分叉时用 git merge main 并解冲突
git push origin release
```

- 推送 `release` 会触发 `release.yml`，产出 arm64 dmg artifact；确认无误后再打 tag 发 GitHub Release：

```bash
git tag v0.1.0
git push origin v0.1.0
```

> 若 `main` 上还有未合并的改动，先合并 `main`，不要反过来把 `release` 的提交挑回 `main`。

## 2. 本地打包

```bash
pnpm install
pnpm build        # 本机架构（Apple Silicon 即 arm64）：先构建 sidecar，再 tauri build
pnpm build:arm64  # 显式 arm64，与 CI 完全一致
```

`cargo check --workspace` / `cargo test --workspace` 也会触发 Tauri build script，而它要求 `binaries/` 下的 sidecar 存在；直接用 `pnpm check:rust` / `pnpm test:rust`（会自动先构建 debug sidecar），或先跑 `pnpm build:sidecar:debug`。

`binaries/` 下的文件名只含 target triple，不含 profile：`--debug` 会覆盖同一路径的 release 产物。所以不要绕过 `pnpm build` 直接执行 `pnpm -C apps/desktop tauri build`，否则可能把上一次 `pnpm dev` 留下的 debug sidecar 打进安装包。

产物：

```text
target/aarch64-apple-darwin/release/bundle/macos/TAPD Client.app
target/aarch64-apple-darwin/release/bundle/dmg/TAPD Client_<version>_<arch>.dmg
```

sidecar 的命名规则由 Tauri 决定，构建脚本会自动生成到 `apps/desktop/src-tauri/binaries/`（已在 `.gitignore` 中忽略）：

```text
tapd-mcp-aarch64-apple-darwin
```

## 3. CI

| 工作流 | 触发 | 内容 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | push `main`、PR、手动 | 前端类型检查、构建 debug sidecar、Rust check/test |
| `.github/workflows/release.yml` | push `release`、push `v*` tag、手动 | arm64 app + dmg，上传 artifact |

`release` 分支的每次推送都会跑一次完整打包，产物在 Actions 页面的 artifact 中，名为 `tapd-client-<version>-arm64-<run_number>`。推送 `v*` tag（例如 `v0.1.0`）时会额外创建 GitHub Release，附带 dmg 与 `SHA256SUMS.txt`。

> CI 报 `resource path binaries/tapd-mcp-aarch64-apple-darwin doesn't exist`：说明 `cargo check/test` 前没有生成 sidecar。`ci.yml` 已显式加入 “Build MCP sidecar (debug)” 步骤，本地则用 `pnpm check:rust` / `pnpm test:rust`。

手动触发：Actions → Release → Run workflow。

## 4. 发版步骤

1. 改版本号：`package.json`、`apps/desktop/package.json`、`apps/desktop/src-tauri/tauri.conf.json`（`Cargo.toml` 的 workspace version 同步）。
2. 本地验证：`pnpm typecheck && pnpm test:rust && pnpm build:arm64`。
3. 按第 1 节把 `main` 合并进 `release` 并推送，等 CI 打包通过。
4. 打 tag 并推送，生成 GitHub Release：

```bash
git tag v0.1.0
git push origin v0.1.0
```

## 5. 签名与公证（可选）

默认产物未签名，用户首次打开需要到「系统设置 → 隐私与安全性」允许。配置以下 repository secrets 后，`release.yml` 会自动启用签名（有 `APPLE_CERTIFICATE` 时）：

| Secret | 说明 |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application 证书的 base64 |
| `APPLE_CERTIFICATE_PASSWORD` | 证书导出密码 |
| `APPLE_SIGNING_IDENTITY` | 例如 `Developer ID Application: Example (TEAMID)` |
| `APPLE_ID` | 公证用 Apple ID（可选） |
| `APPLE_PASSWORD` | App 专用密码（可选） |
| `APPLE_TEAM_ID` | Team ID（可选） |

启用签名后，建议对首次产物做一次校验：`codesign --verify --deep --strict "TAPD Client.app"`，并用 `codesign -dv "TAPD Client.app/Contents/MacOS/tapd-mcp"` 确认 sidecar 也在签名范围内（Tauri 打包时会一并签名 `externalBin`）。

## 6. 常见问题

- **`"…/src-tauri/binaries/tapd-mcp-aarch64-apple-darwin" does not exist`**：还没构建 sidecar，运行 `pnpm build:sidecar` 或直接用 `pnpm build`（`pnpm check:rust` / `pnpm test:rust` 会自动构建 debug 版）。
- **arm64 构建报缺少 target**：`rustup target add aarch64-apple-darwin`；GitHub 的 `macos-26` runner 本身就是 arm64。
- **CI 安装依赖失败**：确认 `pnpm-lock.yaml` 已随提交更新（`pnpm install` 后提交）。
