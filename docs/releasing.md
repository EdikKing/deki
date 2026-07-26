# Releasing

阶段 0 不发布正式版本。

未来发布流程将包括：

1. 三平台 CI 全部通过。
2. 更新 CHANGELOG 和版本号。
3. 在对应平台原生构建安装包。
4. macOS 签名与公证、Windows 代码签名。
5. 生成校验和、SBOM 和依赖许可证清单。
6. 创建签名 Git Tag 和 GitHub Release。

任何发布产物都必须从干净、可复现的提交构建；不得包含 API Key、会话、记忆库或项目代码。
