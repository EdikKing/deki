# Security Policy

## 支持范围

项目尚未发布稳定版本。安全修复只针对 `main` 的最新代码。

## 报告漏洞

请勿公开提交包含利用细节、Token、私有仓库内容或个人数据的 issue。公开仓库建立前，请直接联系维护者；建立后将启用 GitHub Private Vulnerability Reporting，并在此更新入口。

报告应包含影响版本、复现步骤、预期影响和建议缓解方式。维护者会在确认收件后尽快给出初步评估。

## 阶段 0 安全边界

- Renderer 无 Node.js，开启 sandbox 与 context isolation。
- 未信任工作区不会加载项目 Skill 或启动 MCP。
- Agent 仅启用只读文件工具，不启用 Shell、写入和编辑。
- 模型凭据只来自进程环境，不落盘。
- `/remember` 会拒绝常见 Token、密码和私钥格式。
