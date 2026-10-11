# 架构与协议 v2（0.1.1 候选版）

## 信任与范围

可信本地宿主 → stdio MCP SDK → 对话 owner → 统一 TaskScheduler → per-task Node worker → Windows Job helper → DSH headless。worker 是任务生命周期附属进程，不是 daemon。身份与权限分别处理：thread metadata 路由不等于认证；owner 检查防逻辑串话，但不是隔离同一 OS 用户的任意文件读取。

保留 overlay/headless 路线；不迁移 ACP、不重构 DSH SDK、不修改安装 ASAR。

## 状态目录

~~~text
state/
  v2-c-<SHA256 完整大小写敏感身份>/
    owner.json
    tasks.json                  # owner、接受顺序、当前 verified session
    reports.ndjson              # bridge 权威完整报告日志（per-task seq）
    reports.ndjson.events/             # 稳定事件去重标记
    .execution.lock/            # 跨 bridge 的对话串行
    .execution-quarantine.json  # 可疑进程树未确认退出时保留
    sessions/                   # 该对话所有任务共享的 DSH JSONL 会话
    tasks/<task-id>/
      task.json / result.json
      overlay.yml
      inbox.json                # v2 owner 描述符，不再是双向混合日志
      events.ndjson / dsh.stderr.log
      reports/report-<pid>-<uuid>.ndjson   # 独立多写者报告分片
      steering.ndjson                     # 只追加，单调 seq + messageId
      steering.state.json                 # sender seq/字节 checkpoint
      steering.messages/                  # sender 稳定 ID 索引
      steering.receipts.ndjson            # received/confirmed 审计
      steering.confirmed/                 # 确认消息 ID
      steering.ack.json                   # 连续确认 cursor + byteOffset
      control.json / cancel-ack.json
      main-agent.json / policy.json / policy-events.ndjson  # 已 flush 的实际权限证明
      session.json
      storages/
  _locks/workspaces/             # 跨 MCP 实例的写边界注册与 claim
~~~

源路径由 lib/paths.js 定义；带 owner 的 index、task、report、channel 与 checkpoint 均检查所有权。旧状态复制迁移必须先证明 index、各 task、session 关系和历史报告一致；未知原件保留。任务 ID 编码禁止点路径、Windows 设备名和尾部点别名。

## 调度器

1. 接受时规范化真实工作区、记录 createdAt/deadline，写 queued 记录及 channel，建立 abort controller。
2. 本进程 conversation 链和跨进程 execution lock 串行该对话。
3. 写任务获得跨进程真实路径边界锁，按接受顺序排队；read-only 不占写锁。父子目录冲突，full-access 与所有写任务冲突。
4. 真正执行时读取最近已验证 session；工作区不一致/不可信恢复直接失败，不退回重跑 prompt。准备 profile、overlay 和日志。
5. 守护组件确认受管进程创建后记录 running 和 PID；DSH agent/created 权限持久化证明到达后及时保存 main session。
6. 结束时统一写终态一次，释放控制器、计时器、订阅与正常锁。终态 completed/failed/timeout/cancelled/interrupted 不可互相覆盖。

截止时间包括排队、provisioning 与执行。前台 wait 和状态 wait 独立最多 30 秒；既有未读报告不等待；返回前重读 task。completed 的持续时间使用 finishedAt 而不是随查询继续增长。

控制取消来自工具、MCP 前台请求 signal、task control 文件、超时、transport EOF 或 bridge 退出。前台返回后台句柄后即解除原请求取消关联。关闭 connection 停全部任务，不仅停止 MCP Promise。

## Windows 生命周期与故障

C# helper 用 KILL_ON_JOB_CLOSE。CreateProcess 的 JOB_LIST 属性将子进程在创建时原子加入 job，带 suspended，检查 IsProcessInJob 后 resume。只继承显式 stdio 句柄，不继承 job 句柄；拒绝不支持该能力的系统，绝不降级到裸 spawn。

取消先写 control.json，等待 DSH 插件 agent.cancel / whenIdle / sessions.flush，再 TerminateJobObject。helper stdin EOF、强制结束 bridge/worker 或关闭 helper 的 job 句柄均触发 OS 级清理。主进程退出后也清理残留后代，QueryInformationJobObject 确认 activeProcesses=0，再报告 treeExited。

helper 创建 DSH 前测试状态目录写入；低 token/目录权限失败返回 GUARDIAN_STATE_NOT_WRITABLE、launchRefused、treeExited:true，未调用 DSH。provisioning 同样先测其目标写目录。普通 pipe/IPC/spawn/日志错误明确传播；不会把未确认退出写为 cancelled。高流量 IPC 采用 1 MiB 高水位/256 KiB 低水位背压，最后消息排空再断开。

若无法证明子树退出，task=interrupted，保留对话执行隔离与跨工作区写 claim。存活/未知 PID 会阻止后续执行或重叠写；只有所有登记 PID 被验证死亡才自动回收。没有 PID 的 active 崩溃 claim 不会因 bridge PID 死亡被静默删除。PID 重用会保守阻塞，人工核验后处理，宁可拒绝也不冒险并发。

非 Windows 的进程组实现仅为实验性，尚未达到本轮 Windows 发布保障，不作为跨平台稳定性承诺。

## 指导：至少一次，不是“恰好一次”

- sender 在独立短锁中分配稳定 messageId 和递增 seq，fsync 追加 steering.ndjson，单独 checkpoint。
- main report/check_inbox 从独立 ACK byteOffset 增量读取最多 20 条；先持久化 received receipt，再返回包含稳定 ID 的工具结果。child 不能消费。
- 监听实际 tool/result；检查非错误结果含每条完整 [messageId] + text，而非只有 ID header（截断不能 ACK），sessions.flush 成功后，追加 confirmed receipt、逐 ID 确认标记，然后只推进连续确认 ACK。
- tool execute 返回并不直接 ACK。确认前崩溃可重投相同 ID；确认审计已写而 ACK 未写，也宁可重投，不跳过未持久化的结果。确认后稳定 seq/offset 不依赖日志重写位置。
- 半行/UTF-8 字节尾部保留在 reader 中，下一次补全才解析。未完成指导行禁止 sender 追加伪造“修复”以免损失指令；应修复原 sender 或人工恢复。

receipt 恢复增量小批扫描，忽略已 ACK 消息，只对 durable session.log 中存在的真实 tool/result 做补确认；pending map 有界。恢复不自动重放原用户任务。

## 报告

DSH report 的 canonical event ID 使用 agent/tool-call 标识，主/子代理由 session.header 的 parentSession/origin 判断，而不是 id===session.id。独立 writer 分片防止多进程覆盖。runner 按字节偏移读取，保留半行；stdout 中“report 的工具调用输入”不再当已提交报告重复入队，真实 stdout 进展用稳定 stream ID。

bridge 持锁检查 eventId，fsync 写权威完整记录、去重标记；restart 恢复序号、事件 ID 与 bounded hot cache。重复措辞、不同 agent、不同 data，只要 event ID 不同就保留；同一事件重传被去重。历史分页从磁盘流读取。完整文本/data 不按展示预算裁掉；截断只在响应视图发生，并附文件位置。

runner 不保留无限 reports 副本；report count 来自权威序号。DSH error/非正常 turn_end 的真实原因即使后续出现 final 且 exit=0 也不会被掩盖。

## 实际权限

overlay 只是部署默认值，不能信任它覆盖已有 session 的 permission projections。DSH 0.2.0-rc.2 的公开 setters + vetoable agent/created hook 是首轮兼容基线。

主代理：跨进程单一 main claim，拒绝额外嵌套 root 冒领指导；核验 cwd、设置本任务 mode/approval、检查 effective policy、flush session，再写 proof。子代理：证明已验证 parent，限制到 task 与 parent 的更严格上限，保持已有更严格限制与写边界。tools.guard 及 agent/pre-step 再次拒绝未经验证或升级权限的 agent。dispose 清理 live agent/ceiling 缓存。

没有证明、插件不能挂载、能力不匹配或 persistence 不可用即失败，不自动提权、改 full-access 或退回未验证旧 profile。

## 不可变 provisioning

解析 launcher、env、DSH_HOME 一次并贯穿安装和执行。显式覆盖无效即失败。profile 指纹覆盖 launcher 身份、插件内容与生成配置；新 profile 是 codex-bridge-<指纹>，vendored 源和实际 file: 安装副本都按内容校验。

跨 home 的 provisioning 锁串行首次安装。人工旧 profile 和篡改的已 ready 快照都不覆盖；只允许重新尝试明确 managed building 且配置未变的快照。活动任务继续用自己的不可变 snapshot，不被升级替换。

## MCP 展示与分页

四个 task 类工具声明 outputSchema 并返回 structuredContent；五个原工具不变。控制字段在文本首部，组合 JSON 总预算 64 KiB。按报告 seq 逐页推进，has_more 与 cursor 反映实际历史；过大单条也显式截断并推进，不能卡在同一 cursor。answer 与 data 的展示截断单独标记，完整原件保留。

终态写盘失败立即返回 STATE_WRITE_FAILED，并在本进程保留最多 128 份裁剪后的失败摘要供状态查询，不保留完整 prompt/answer。完整输出写盘也失败则 output_persisted:false，不声称磁盘原件可用；重启后仍按遗留非终态 interrupted 处理。

模型任务失败/超时/中断的调用 isError:true；dsh_status 查询正常时返回状态而不冒充查询失败。未知/跨 owner task 的工具错误是匿名、无泄漏的拒绝。

## 待真实验收

单元和无模型 Job 测试不是收费 headless 成功；真实 DSH API 探针不是 shell/模型链路授权证明；注入 metadata 的客户端不是实际 Codex 双聊天。完整 checklist 见 release-and-acceptance.md。本工作区 Low Integrity 写入预检失败是当前真实阻塞，不作为可用稳定部署通过。
