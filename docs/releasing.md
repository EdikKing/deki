# Releasing

Deki 的正式版本由 `.github/workflows/release.yml` 在 SemVer Tag 上构建。三个操作系统必须在各自的原生 GitHub Actions Runner 上成功，Release 才会创建。

## 正式产物

| 平台 | 架构 | 产物 | 签名与校验 |
| --- | --- | --- | --- |
| macOS | Universal（Intel + Apple Silicon） | DMG、ZIP | Developer ID 签名、Hardened Runtime、公证、Staple |
| Windows | x64 | NSIS 安装器、Portable EXE | Authenticode SHA-256、RFC 3161 时间戳 |
| Linux | x64 | AppImage、DEB | SHA-256、GitHub Artifact Attestation |

electron-builder 同时生成 `latest-mac.yml`、`latest.yml`、`latest-linux.yml` 和 blockmap。应用内的 `electron-updater` 使用同一个 GitHub Releases 发布源：Stable 对应 `latest`，Beta 对应 `beta` 预发布通道。

发布汇总 Job 还会附加：

- `SHA256SUMS.txt`：所有安装器、更新元数据、blockmap 和 SBOM 的 SHA-256。
- `Deki-<version>.cdx.json`：CycloneDX JSON SBOM。
- GitHub Artifact Attestation：可用 `gh attestation verify <file> --repo <owner>/<repo>` 验证构建来源。
- `THIRD_PARTY_LICENSES.md`：打进每个应用包的锁文件依赖许可证清单。

## Repository Secrets

在 GitHub Repository 或受保护的 Release Environment 中配置以下 Secrets。工作流不会在缺失凭据时降级为未签名正式包。

### macOS

- `MAC_CSC_LINK`：Developer ID Application `.p12` 的 Base64、HTTPS URL 或文件形式。
- `MAC_CSC_KEY_PASSWORD`：`.p12` 密码。
- `APPLE_API_KEY_BASE64`：App Store Connect API `.p8` 文件内容的 Base64。
- `APPLE_API_KEY_ID`：API Key ID。
- `APPLE_API_ISSUER`：API Issuer ID。

公证使用 App Store Connect API Key，不需要把 Apple ID 密码交给 CI。

### Windows

- `WIN_CSC_LINK`：代码签名 `.pfx`/`.p12` 的 Base64、HTTPS URL 或文件形式。
- `WIN_CSC_KEY_PASSWORD`：证书密码。

生产证书应使用受信任 CA 签发的 OV/EV Code Signing 证书。构建后工作流会对 NSIS 和 Portable EXE 运行 `Get-AuthenticodeSignature`，任何非 `Valid` 状态都会阻止发布。

## 发布步骤

1. 更新 `CHANGELOG.md`。
2. 将以下版本保持一致：
   - 根 `package.json`
   - `apps/desktop/package.json`
   - `apps/cli/package.json`
   - `packages/shared/src/index.ts` 中的 `DEKI_VERSION`
3. 本地执行完整验证：

   ```bash
   pnpm install --frozen-lockfile
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm build
   ```

4. 创建并推送签名 Tag：

   ```bash
   git tag -s v1.2.3 -m "Deki 1.2.3"
   git push origin v1.2.3
   ```

预发布 Tag 使用完整 SemVer，例如 `v1.3.0-beta.1`。Tag 与版本不一致时，`release:validate` 会在任何安装器开始构建前失败。

所有产物从 Tag 指向的同一提交构建。三个平台产物先作为短期 Workflow Artifacts 汇总；只有签名、公证、更新元数据、SBOM、校验和与 Attestation 全部成功后，工作流才创建公开 GitHub Release。失败或取消的运行不会创建部分 Release。

## 本地打包

`pnpm package` 为当前操作系统生成真正的安装器，但本地没有发布证书时会是未签名开发产物，不得对外分发。

```bash
pnpm package          # 当前平台的正式格式
pnpm package:dir      # 仅目录包，用于快速验证和 CI
pnpm package:mac      # DMG + ZIP，Universal
pnpm package:win      # NSIS + Portable，x64
pnpm package:linux    # AppImage + DEB，x64
```

跨平台安装器必须在对应原生操作系统上构建；不要从单一机器交叉生成正式 Release。
