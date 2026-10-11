# dsh-mcp 0.1.2

通用本地 stdio MCP 服务，用 DSH Desktop 执行经授权的任务，保留原生会话、持久报告、指导确认、权限上限和受监督取消。各类可信本地 harness 均可使用标准 MCP；本版不依赖 Codex 插件、聊天身份或插件环境变量。

**Windows x64 预发布，DSH Desktop 唯一兼容基线为 0.2.0-rc.2。** 无 npm 发布。付费模型、具体客户端产品和非 Windows 平台尚未验收；协议测试使用标准 MCP SDK 客户端。

下载对应 GitHub prerelease 的自包含 ZIP，校验 SHA256SUMS 后解压到固定安装目录。包中包含 Node 24.19.0、锁定依赖、Windows Job Object guardian、第三方许可证、文件 manifest 和脱敏测试摘要。无需系统 Node；DSH Desktop 仍需独立安装。

在 PowerShell 的解压目录运行：

~~~powershell
.\runtime\node.exe .\bin\dsh-mcp.js config --format mcp-json
.\runtime\node.exe .\bin\dsh-mcp.js config --format server-json
.\runtime\node.exe .\bin\dsh-mcp.js config --format toml
.\runtime\node.exe .\bin\dsh-mcp.js diagnose
~~~

配置生成只输出配置，不修改客户端。输出含实际安装目录的绝对运行路径，可粘贴到 CC Switch 的独立 MCP 管理界面或其他客户端；需由客户端重新连接。移动安装目录后重新生成。客户端 RPC 期限应大于 30 秒等待窗口；如需要，客户端自己的 timeout 配置应按其文档设置。

启动、自检、配置生成都不会初始化 profile。**bootstrap 是独立显式操作**，会在 DSH_HOME 下创建新的不可变指纹 profile、安装 DSH 执行插件并可能访问网络：

~~~powershell
.\runtime\node.exe .\bin\dsh-mcp.js bootstrap
~~~

本次发布未在用户 DSH_HOME 执行 bootstrap。旧 profiles 保持原样；旧 Codex profile 不会自动变成新版 ready profile。没有授权的模型费用或 workspace 访问时不要调用 dsh_task。

| 工具 | 参数与用途 |
| --- | --- |
| dsh_task | prompt、绝对 workspace 必填；session_id 省略创建新会话，提供则显式续接已验证原生 DSH 会话 |
| dsh_status | task_id 必填；cursor 为单调报告序号，limit 默认 50/最大 200，wait_ms 最多 30000 |
| dsh_steer | task_id、message 必填；返回 message_id 表示持久排队，实际 ACK 须有 DSH 成功工具结果与持久化证明 |
| dsh_cancel | task_id 必填；只有受管进程树退出确认才返回 cancelled |
| dsh_self_check | 只读诊断配置、DSH、profile、状态和监督准备条件 |
| dsh_sessions | 无 session_id 列管理会话，提供则列该会话任务元数据；不透明 cursor、默认 50/最大 200；不返回聊天正文 |

新任务取得真实 DSH session ID 前返回 null。省略 session_id 总是新建，不会续接最近会话。new_session 已弃用：true 不得与 session_id 同用，false 必须提供 session_id。status、steer、cancel 不再选择最近任务；这些是明确的升级接口变化。

DSH_MCP_NAMESPACE 默认 local。相同部署命名空间的可信主控共享管理记录；不同命名空间不能查询彼此任务、报告或会话。命名空间是配置隔离，**不是认证或每个聊天的自动隔离**。客户端 metadata 和名称不决定所有权。持久数据默认位于新的 dsh-mcp 数据目录，可用 DSH_MCP_STATE 指定；DSH_HOME 维持其原义。

同一 DSH 原生会话串行，不同会话可并发，写任务还受真实 workspace 的跨进程写锁限制。前台最多 30 秒后 detach；任务 deadline 包含排队、准备与执行。MCP EOF 停本连接提交的任务，不停止其他进程的任务。退出未知时隔离会话与工作区，不自动清锁、重放或提高权限。

报告读取保存 task_id 和 cursor，逐页推进直到终态且 has_more=false。工具查询成功不等于任务成功；检查 state/error。64 KiB 限额涵盖文本与结构化输出，超长完整内容保存在管理目录。

旧命令 codex-dsh-mcp 作为薄入口保留，仅在 stderr 警告。旧数据不会自动读取；显式迁移步骤见 [升级与迁移](docs/public/upgrade-0.1.2.md)。完整配置与安全范围见 [部署说明](docs/public/configuration.md) 和 [架构](docs/architecture.md)。

源码开发使用 Node 24.19.0：npm ci、npm run build:native、npm test、npm run validate:package、npm run check:guardian。npm run check:dsh-contract 需要安装 DSH Desktop，仅用隔离临时目录核验真实 SDK，无模型请求。npm run build:release 要求干净已提交源码及对应官方 Node LICENSE。

[验证范围](docs/public/v0.1.2-verification.md) · [发行说明](docs/releases/v0.1.2.md)。机器原始证据、收费账本、真实会话、旧候选和 credentials 均不进入源码或发布包。历史四次收费验收仍为 **0/4**，不自动消费、不重置、不能绑定新版候选复用。MIT；原署名和代码贡献者声明保留。
