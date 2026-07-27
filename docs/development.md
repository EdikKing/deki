# Development

## 安装

```bash
nvm install
nvm use
pnpm install --frozen-lockfile
```

Pi SDK 0.82.1 要求 Node.js 22.19.0 或更高；仓库固定为当前 LTS 24.18.0。pnpm 安装策略只允许 Electron、esbuild 和打包所需工具执行安装脚本。

## 运行

```bash
export OPENAI_API_KEY="..."
pnpm dev
```

默认进入不关联项目的普通会话。也可通过
`pnpm dev -- --workspace /absolute/project/path` 直接打开指定项目。

删除 `~/.deki/config.json` 中对应条目可重新触发工作区信任页。测试时不要使用包含真实 Secret 的项目。

## 质量检查

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:electron
pnpm build
pnpm package
```

`pnpm package` 生成当前平台的真实安装器到 `release/`；本地没有证书时仅用于开发验证。
`pnpm package:dir` 生成未签名目录包，适合快速检查。正式签名、公证和三平台发布流程见
[发布文档](releasing.md)。

`pnpm build` 同时构建 CLI 和 Electron。CLI 也可单独构建并运行：

```bash
pnpm cli:build
node apps/cli/dist/deki.js --help
```

## MCP Fixture

`tests/fixtures/mcp-server.mjs` 只用于自动化测试，提供 `echo`、`fail` 和 `slow`。产品不会自动发现或安装该 Server。
