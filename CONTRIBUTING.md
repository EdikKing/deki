# Contributing to Deki

感谢你参与 Deki。

## 开发流程

1. 使用 `.nvmrc` 中的 Node.js 版本和 `package.json` 指定的 pnpm。
2. 从 `main` 创建短生命周期分支。
3. 为行为变更补充测试和文档。
4. 提交前运行 `pnpm lint && pnpm typecheck && pnpm test && pnpm build`。

## Developer Certificate of Origin

项目使用 DCO，不要求 CLA。每个提交都必须包含签署行：

```text
Signed-off-by: Your Name <your.email@example.com>
```

可使用 `git commit -s` 自动添加。签署表示你有权按项目许可证贡献该代码，具体条款见 <https://developercertificate.org/>。

## 安全边界

涉及文件写入、Shell、MCP 子进程、Secret、IPC 或记忆召回的修改，需要在 PR 中说明威胁模型和失败方式。不得在测试、日志或 issue 中提交真实凭据和私有代码。
