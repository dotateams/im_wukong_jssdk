# 设计：群 E2EE 新消息 sender key 自动修复闭环

## 问题根因

群 E2EE 的 sender key 是发送设备级别的。接收端出现“只解不开某个人的消息”时，本质是缺少这个 `sender_uid + sender_device_id + key_id` 对应的 sender key 状态。

当前链路的问题不是缺少单个接口，而是多个环节之间不够闭环：

- envelope lookup 失败后容易被短期缓存挡住，导致后续新消息不再强制查最新 envelope。
- repair request 提交后，接收端没有稳定地把失败消息挂起并在补 key 后原地重试。
- 发送端 pending repair 主要依赖下一次发送路径处理，实时催促和批量补发不够强。
- 发送端的设备目录缓存如果旧了，可能继续漏掉某个新设备。

## 接收端解密失败处理

接收端在解密 `signal_group` 失败时，应按错误分类：

- `Missing sender key`：没有该发送设备的 sender key，立即进入恢复链路。
- `Missing message key`：有 sender key 但链条缺口，先强制 envelope lookup；如果新 state 可用则重试。
- `OperationError`：如果发生在 group distribution/envelope 解密阶段，按可恢复处理；如果 envelope 明确不是给当前设备的，则提交 repair request。
- 403/非群成员：不可恢复，直接 fail-closed。

可恢复的新消息不得直接落成“历史消息缺少群密钥”。应创建 `PendingDecryptItem`：

- `groupId`
- `senderUid`
- `senderDeviceId`
- `keyId`
- `messageId/clientMsgNo/messageSeq`
- `cipherObject`
- `firstSeenAt`
- `attempts`

队列按 recovery key 分组。同一 recovery key 只触发一个恢复任务，后续同 key 消息只追加队列。

## 恢复流程

1. 接收端收到新消息并解密失败。
2. 将消息放入待解密队列，UI 显示临时解密中状态。
3. 强制调用 envelope lookup，绕过短期 missing cache。
4. lookup 200：
   - 解开 envelope。
   - 保存 sender key record。
   - 按 messageSeq/clientMsgNo 顺序重试队列。
   - 成功后原地更新 UI 和本地明文缓存。
5. lookup 404 或可恢复失败：
   - 提交 repair request。
   - 队列继续保留，等待补发或下一轮退避重试。
6. 收到 `signal_group_distribution`、`e2ee_redistribute_request` 相关补发、或下一次 envelope lookup 成功后，自动重试队列。
7. 超过 TTL 或最大次数后，才标记为无法解密；历史消息和新消息文案要区分。

## 发送端补发流程

发送端需要在以下场景处理 pending repair：

- 收到服务端 `e2ee_redistribute_request`。
- 自己准备发送加密群消息前。
- 群设备目录版本变化后。
- SDK 初始化后发现本地有可用 sender key record 且收到过 repair 催促。

处理方式：

1. 查询 `/v1/e2e/group_sender_keys/repair_requests/pending`。
2. 将返回的 repair requests 按 `recipient_uid + recipient_device_id` 去重。
3. 只为这些缺 key 设备生成 envelope，不做全群重分发。
4. 批量调用 `/v1/e2e/group_sender_keys/envelopes` 上传。
5. 上传成功后，本地清理对应 repair pending 缓存；服务端删除对应 repair request。

## 性能设计

- 接收端队列默认建议：
  - 单群最多 200 条待解密消息。
  - 全局最多 2000 条待解密消息。
  - TTL 5 分钟。
- 同一 recovery key 的 lookup 使用 promise 复用，禁止并发风暴。
- repair request 去重窗口 30-60 秒。
- 发送端每次 pending repair 最多处理 500 个目标设备；超过部分进入后台批次，避免阻塞当前发送。
- pending repair 查询应支持分页或 has_more，防止 limit=100 导致大批缺 key 设备需要很多轮普通发消息才能修完。
- 发送路径允许先处理一小批 repair，剩余 repair 后台继续，不让用户首条消息长时间卡住。

## 缓存失效策略

- 发生 group device version 变化时，失效该群设备目录缓存和 repair pending 缓存。
- envelope lookup 404 在新设备 grace 窗口内不得写入永久 missing cache。
- 收到 repair 催促时必须清掉该群该发送设备的 repair pending 去重缓存。
- identity 修复或设备重新注册后，清理 sender key envelope missing/force lookup/repair request 缓存。

## UI/上层回调

SDK 应向 Web 暴露消息恢复状态，至少能区分：

- `decrypting`：正在等待密钥或重试。
- `recovered`：已恢复并产生明文。
- `failed`：超过上限或不可恢复。

Web 端根据消息标识原地更新，不追加重复消息。

