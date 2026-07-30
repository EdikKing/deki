# Deki Plan 模式使用指南

本文介绍如何在 Deki 中使用 Plan 模式进行只读分析、生成结构化计划、要求修订、批准执行和在执行偏离时重新规划。

底层 Plan Schema、状态机和演进路线见[多 Agent、后台任务与 Plan 模式完整规划](./multi-agent-background-tasks-plan-mode.md)。

## 什么是 Plan 模式

Plan 模式用于在修改项目之前完成可审阅的工程规划：

```text
描述目标
  → 只读调查
  → 结构化 Plan
  → 用户审阅
  ├── 要求修改 → 新 revision → 再次审阅
  ├── 放弃
  └── 批准并执行
          → 逐步执行
          → 验证
          → 完成或 Replan
```

Plan 不是聊天回复中的普通 Markdown 列表，而是持久化领域对象。它拥有：

- 稳定 Plan ID。
- revision 版本。
- 目标、假设和约束。
- 有依赖关系的步骤。
- 候选文件、验证方式和风险级别。
- 独立的批准状态。
- 执行 Task 和每个步骤的运行状态。
- Replan 原因和证据。

## 当前实现状态

当前版本支持：

- 在项目会话中切换“执行 / 规划”模式。
- 由 Tool Gateway 强制 Plan 模式只读。
- 在关联对话中生成、审阅和执行 Plan。
- 保存结构化 Plan 和 revision。
- 查看目标、假设、约束、步骤、依赖、候选文件、验证和风险。
- 要求 Agent 根据反馈生成修订。
- 比较 revision 的步骤和字段差异。
- 批准最新 revision 并创建执行 Task。
- 将执行进度同步回 Plan Step。
- 暂停、恢复和重试计划执行。
- 对执行偏离或受阻步骤发起 Replan。
- 放弃未完成的 Plan。
- 在 Plan Step 下查看关联 Worker。

当前暂不支持：

- 用户直接在 UI 中逐字段编辑 Plan。
- 单独批准某个步骤或只批准低风险步骤。
- 完整成本估算和费用预算。
- 应用退出后由 daemon 持续执行。

启用默认关闭的“实验性 Plan DAG”后，多个无依赖步骤可以并行执行。Implementer
必须声明写入范围和验证目标；执行器会自动插入 Reviewer，并在同一写入批次产生多个
Commit 时插入 Integrator。关闭开关仍走原有串行 Plan Agent 流程。

## Plan 模式和执行模式

| 能力 | Plan / 规划 | Act / 执行 |
| --- | --- | --- |
| 读取和搜索项目 | 允许 | 允许 |
| 明确只读的 Shell | 按权限允许 | 按权限允许 |
| 修改、创建或删除文件 | 强制禁止 | 按权限策略 |
| 安装依赖 | 强制禁止 | 通常需要审批 |
| Git 写操作 | 强制禁止 | 通常需要审批 |
| 修改型 MCP Tool | 强制禁止 | 按 Tool 策略 |
| 提交结构化 Plan | 允许 | 不适用 |
| 真正实施目标 | 需要批准后进入执行 Task | 可以直接执行 |

即使当前权限模式是“完全访问”，Plan 模式仍应保持只读。只读边界由 Tool Gateway 强制，不只依赖提示词。

## 什么时候应该使用

推荐使用 Plan 模式：

- 改动涉及多个 package、进程或技术层。
- 需要先理解陌生项目。
- 涉及数据库迁移、公共 API 或配置兼容。
- 涉及权限、Shell、MCP、Secret 或 IPC 安全边界。
- 任务目标明确，但实施路径存在多个选择。
- 希望在任何写入发生前确认文件范围和验证方案。
- 需要与其他人分享或审阅实施计划。
- 预计执行过程中可能使用多个 Worker。

可以直接使用执行模式：

- 修复明确的一行拼写错误。
- 修改范围已知且容易恢复。
- 只需要读取和回答问题，不需要持久化计划。
- 任务非常小，计划成本明显高于实施成本。

Plan 模式不是安全沙箱。它能禁止 Deki Tool 的写操作，但读取的项目内容仍可能被发送给所选模型 Provider。

## 使用前准备

1. 打开项目会话；Plan 模式不能用于普通会话。
2. 信任当前工作区。
3. 配置可用模型。
4. 确认项目路径、分支和未提交修改。
5. 检查项目 Skill 和 MCP Server 是否可信。
6. 如果批准后会执行写入，启用 Git Checkpoint。
7. 在 Prompt 中提供目标、约束、非目标和验收标准。

## 生成第一版 Plan

### 操作步骤

1. 在 Composer 中点击“规划”。
2. 确认输入框上方显示“Plan 模式只读取和分析项目，不会修改文件”。
3. 输入目标和约束。
4. 点击主发送按钮，在当前对话中生成。
5. Agent 使用只读 Tool 调查项目。
6. Agent 通过专用 Plan Tool 提交结构化结果。
7. Plan 面板显示“待审阅”和 `Plan v1`。

### 推荐 Prompt 模板

```text
目标：

背景：

必须满足：
- （填写）
- （填写）

不要做：
- （填写）
- （填写）

请重点调查：
- 现有实现和调用链；
- 配置、数据和兼容性；
- 权限与失败恢复；
- 现有测试和可执行验证。

计划要求：
- 每一步有稳定 ID、明确产出和依赖；
- 列出候选文件；
- 标记 low / medium / high 风险；
- 每一步至少包含一个可执行验证；
- 能并行的步骤明确标记；
- 不确定的信息写入 assumptions；
- 批准前不要修改文件。

验收标准：
- （填写）
- （填写）
```

目标越具体，Plan 越容易审阅。不要只写“重构这个模块”而没有行为约束。

## Plan 的内容

每个 revision 包含：

### 假设

尚未完全验证、但计划暂时依赖的事实，例如：

```text
- 当前 SQLite 数据库只由单个 Deki 主进程写入。
- 旧版配置需要继续兼容至少一个版本。
```

批准前应重点检查高影响假设。错误假设通常是后续 Replan 的主要原因。

### 约束

执行期间必须保持不变的边界，例如：

```text
- 不改变现有 IPC 公共方法名称。
- 不新增生产依赖。
- 不把 API Key 返回给 Renderer。
```

### 步骤

每个步骤包含：

| 字段 | 说明 |
| --- | --- |
| `id` | revision 间尽量保持稳定的步骤标识 |
| `title` | 简短标题 |
| `description` | 要做什么以及预期产出 |
| `dependencies` | 必须先完成的步骤 ID |
| `candidateFiles` | 预计读取或修改的文件 |
| `validation` | 至少一项验证方式 |
| `risk` | `low`、`medium` 或 `high` |
| `parallelizable` | 是否可以与无依赖步骤并行 |
| `assignedProfile` | 可选的建议 Agent Profile |

步骤依赖必须构成无环图。启用实验性的 Plan DAG 后，执行器会并行推进无依赖且标记为可并行的步骤；关闭该开关时仍使用原有串行执行流程。

## 示例：为认证测试失败制定计划

### 用户输入

```text
分析登录相关测试失败的原因，并制定修复计划。批准前不要修改代码。

范围：
- apps/desktop 的登录 UI；
- packages/auth；
- tests/auth 和相关 fixture。

约束：
- 不新增依赖；
- 不改变公开登录 API；
- 不降低 token 或 session 校验；
- 所有修改必须有自动化验证。

计划需要：
- 区分实现错误、测试 fixture 错误和时间相关不稳定；
- 列出候选文件；
- 标记安全风险；
- 如果适合，安排 Explorer 和 Tester 并行调查；
- 包含最小测试和完整回归验证。
```

### 可能生成的结构

下面只是说明 Plan 面板的结构，不代表真实项目结论：

```text
Plan v1

假设
- 失败可以在本机稳定复现。
- 当前测试使用可控时钟。

约束
- 不改变公开认证 API。
- 不降低 token 验证强度。

step-1 调查失败路径 [medium]
  候选文件：packages/auth/src/session.ts, tests/auth/session.test.ts
  验证：记录失败断言、调用链和直接文件证据

step-2 并行验证实现与测试 [medium]
  依赖：step-1
  Worker：Explorer + Tester
  验证：Worker Result 包含文件证据和测试 Artifact

step-3 实施最小修复 [high]
  依赖：step-2
  候选文件：由调查结果确定
  验证：目标测试通过且 Diff 不扩大 API

step-4 回归与审查 [medium]
  依赖：step-3
  验证：typecheck、认证测试、Reviewer 风险检查
```

### 审阅重点

- “可控时钟”是否已经被代码证据确认。
- `step-3` 的候选文件是否过于模糊。
- 安全相关步骤是否为高风险。
- 测试命令是否真实存在于 `package.json`。
- 依赖顺序是否允许在根因不明时提前修改代码。
- Plan 是否遗漏迁移、文档或回滚。

## 如何审阅 Plan

建议逐项检查：

### 目标

- 是否解决了用户真正的问题。
- 是否包含了不必要的范围扩大。
- 成功标准是否可以验证。

### 假设和约束

- 每个关键假设是否有证据。
- 错误时会造成多大返工。
- 安全和兼容约束是否明确。

### 步骤和依赖

- 每一步是否有单一、明确产出。
- 是否存在循环依赖。
- 是否在调查完成前安排写入。
- 并行步骤是否真的互不依赖。

### 文件和风险

- 候选文件是否与实际调用链一致。
- 是否遗漏测试、Schema、迁移或文档。
- 公共 API、权限、数据迁移是否标为高风险。

### 验证

- 每一步至少有一项验证。
- 验证命令是否存在且范围合理。
- 是否包含失败路径和回归测试。
- 是否需要人工检查 Diff 或安全审查。

## 要求修改

如果 Plan 不满足要求：

1. 点击“要求修改”。
2. 输入具体反馈。
3. Deki 创建新的规划 Task。
4. Agent 在只读模式下补充调查并提交新 revision。
5. Plan 面板展示版本差异。

有效反馈示例：

```text
请生成 v2：
- 保留 step-1 和 step-2 的稳定 ID；
- 增加配置迁移和旧数据兼容步骤；
- 把 API Key 从 Main Process 进入 Renderer 的风险标为 high；
- 每个写入步骤补充对应测试文件；
- 不新增生产依赖；
- 说明 Windows 平台的验证方式。
```

不够有效的反馈：

```text
再详细一点。
```

应尽量指出受影响步骤、缺失证据、错误假设或新增约束。

### 版本差异

Plan 面板支持选择基准版本和对比版本，显示：

- 新增、删除和修改的步骤。
- 步骤重排。
- 假设和约束变化。
- title、description、dependencies、candidateFiles、validation、risk、parallelizable 等字段变化。

只能批准最新 revision，不能批准过期版本。

## 批准并执行

当 Plan 状态为“待审阅”，且规划 Task 已成功完成时：

1. 点击“批准并执行”。
2. 当前最新 revision 被记录为 approved revision。
3. Orchestrator 创建或恢复 `plan-execution` Task。
4. Plan 状态进入 `approved`，开始运行后进入 `executing`。
5. Agent 按依赖顺序更新 Plan Step。
6. 文件写入、Shell、MCP 和 Git 仍受原有权限策略控制。
7. 当前对话中的 Plan 卡片实时显示步骤、Run、审批、Worker、验证和 Artifact。
8. 所有必要步骤和验证完成后，Plan 进入 `completed`。

批准 Plan 不等于批准其中所有危险 Tool。比如 Plan 写明需要安装依赖或执行 Git 写操作，真正执行到该 Tool 时仍会按权限策略询问。

## 执行期间的步骤状态

| 状态 | 含义 |
| --- | --- |
| `pending` | 等待依赖或尚未开始 |
| `running` | 当前正在执行 |
| `completed` | 已完成，并可附带摘要和证据 |
| `blocked` | 假设失效、验证失败或需要扩大范围 |
| `skipped` | 明确不需要执行 |

实验性 Plan DAG 允许同一 revision 有多个正式步骤处于 `running`，并受全局并发、Plan 并发、写集 wave 和预算共同限制。非并行步骤仍作为拓扑屏障。

预算面板同时显示已使用量和活动节点尚未消耗的预留量。达到 70%/90% 时路由器会按配置
降级模型和输出上限；硬预算耗尽时取消活动节点并以 `budget` 原因阻塞 Plan。Reviewer 和
Integrator 不会因为预算紧张被跳过。

Integrator 只会自动处理完全位于声明 `writeSet` 内的低/中风险普通 UTF-8 文本冲突。
exclusive 路径、高风险步骤、二进制、子模块、符号链接、越界或其他不安全冲突会保存
stage 与检查证据，并安全阻塞 Plan。此时应从 Plan 面板发起 Replan，不要直接应用产物。

## 暂停、恢复和重试

当前对话中的 Plan 卡片可以控制执行 Task：

- “暂停执行”：停止当前 Run，并保存可恢复状态。
- “恢复执行”：从 `paused` 或 `interrupted` 创建新的 Run。
- “重试执行”：对 `failed` Task 创建新的 attempt。
- “打开会话”：回到关联聊天上下文。

恢复前应检查工作区是否发生外部变化，尤其是分支切换、手动编辑和未知副作用。

## 什么时候应该 Replan

以下情况不应让 Agent 悄悄扩大执行范围：

- 需要修改 Plan 未列出的高风险模块。
- 需要新增或升级依赖。
- 需要改变公共 API。
- 数据或配置迁移方案发生变化。
- 原计划验证命令无法执行。
- 原有假设被代码或测试证明错误。
- 发现安全问题，需要改变实现策略。
- 当前步骤受阻，不能在原约束内完成。

操作步骤：

1. 暂停当前执行 Task；Plan 面板在执行中或步骤受阻时也会提供“重新规划”。
2. 点击“重新规划”。
3. 输入原因；Deki 会关联当前 running 或 blocked 步骤。
4. Agent 在只读模式下创建新 revision。
5. 查看 Replan 原因、受影响步骤和版本差异。
6. 重新批准最新 revision。
7. 执行 Task 继续，但不会自动重复已确认完成的步骤。

Replan 反馈示例：

```text
step-3 发现旧版 settings.json 没有 schemaVersion，原迁移假设失效。

请重新规划：
- 保留已经完成的只读调查；
- 阻塞当前写入步骤；
- 增加旧格式检测、备份和回滚；
- 补充损坏配置 fixture；
- 不改变 Renderer IPC；
- 给出迁移失败时的用户可见错误。
```

## 放弃 Plan

如果目标不再需要、范围变化过大或准备重新开始，可以点击“放弃”。

放弃后：

- Plan 进入 `abandoned`。
- 不会自动创建新的执行 Task。
- 已经发生的文件修改不会自动撤销。
- 历史 revision、事件和 Artifact 仍保留用于审计。

如果 Plan 已经执行过，应先检查 Diff 和 Git Checkpoint，再决定如何恢复工作区。

## 前台执行与内部调度

Plan 的规划、批准和执行都留在关联对话中：

- Plan 模式不显示后台提交入口，主进程也会拒绝后台 Plan 请求。
- 批准后输入区保持忙碌，Plan 卡片实时跟踪所有 DAG 节点。
- 工具审批、用户输入和应用到工作区的决定都在当前对话处理。
- 切换项目、会话或打开任务中心前，需要确认暂停正在执行的 Plan。

内部仍保留 Task、Run、Worker、DAG、断点和持久化记录，用于并发调度、审计与恢复；
这些记录不会计入后台任务列表或角标。旧版本创建的后台 Plan 仍可在任务中心访问。

## 与多 Agent 配合

Plan 执行可以把相互独立的只读调查交给 Worker：

- Explorer 收集实现证据。
- Tester 在临时副本运行受控验证。
- Reviewer 检查安全和回归风险。

Worker 请求会携带 Plan ID、revision 和 step ID，结果在 Plan Step 下显示。主 Agent 仍负责综合结论和推进步骤。

当前 Worker 不能修改真实工作区。详细使用方法见[多 Agent 使用指南](./multi-agent-usage.md)。

## Plan 模式的安全边界

Plan 模式允许：

- 工作区读取、列表、查找和搜索。
- 明确判定为只读的 Shell。
- 只读 MCP Tool。
- Plan 控制 Tool。
- 按权限策略允许的网络读取。

Plan 模式禁止：

- `edit`、`write`、`delete` 和 `move`。
- 依赖安装。
- Git commit、push、checkout 等写操作。
- 修改型 Shell。
- `mcp.write`。
- 不明确是否会产生副作用的 Tool。

如果 Agent 在 Plan 模式尝试写入，应被 Tool Gateway 拒绝，并在 Timeline 中留下失败记录。不要仅凭 Agent 声称“没有修改”判断安全，应同时检查 Tool Timeline 和 Git 状态。

## 常见问题

### 为什么“规划”按钮不可用？

Plan 模式只在受信任项目会话中启用。请先选择项目、确认信任并等待 Runtime 就绪。

### 为什么 Plan 一直不能批准？

只有最新 Plan 状态为 `ready`，并且对应规划 Task 已成功完成时才能批准。如果仍显示“正在完成规划”，请在当前对话的 Plan 卡片中检查审批、输入、暂停或失败状态。

### 批准后为什么还要求 Tool 审批？

批准的是工程计划，不是无限权限。实际写文件、安装依赖、执行 Shell、调用 MCP 或写入 Git 时，仍按当前权限策略判断。

### Plan 可以后台生成吗？

不可以。Plan 必须在关联对话中生成和执行，以便用户实时观察节点进展并及时暂停或打断。

### 可以直接编辑某个步骤吗？

当前 UI 通过“要求修改”让 Agent 创建新 revision，不支持逐字段手工编辑。反馈中应明确步骤 ID 和期望变化。

### Replan 会从头执行全部步骤吗？

不会以无条件重放为目标。Deki 会保留步骤状态和已有证据；新 revision 会尽量继承稳定步骤，但受影响步骤需要重新审阅和批准。

### Plan 模式等于 Sandbox 吗？

不等于。它强制限制 Deki Tool 的写能力，但不是 OS、容器或虚拟机 Sandbox，也不能改变云模型会接收项目上下文这一事实。

## 相关文档

- [多 Agent 使用指南](./multi-agent-usage.md)
- [后台任务使用指南](./background-tasks-usage.md)
- [多 Agent、后台任务与 Plan 模式完整规划](./multi-agent-background-tasks-plan-mode.md)
- [设置与权限](./settings-and-permissions.md)
- [架构说明](./architecture.md)
