# 设计说明：SDK 加密群历史与发送性能优化

## 发送慢的关键路径

加密群发送通常经过：

1. Web 调用 `chatManager.sendWithOptions`。
2. SDK 判断频道是否 E2EE。
3. E2EE adapter 获取群成员设备。
4. 计算或使用服务端返回的 memberHash。
5. GroupManager 加载本地 sender key record。
6. 若 record 缺失或 memberHash 变化，创建 sender key record。
7. 使用 sender key 加密消息。
8. 如需分发，构建每个成员设备的 sender-key envelope。
9. 批量上传 envelopes。
10. 保存 sender key record 并发送 WuKongIM 消息。

大群里最重的是第 3、8、9 步。优化重点是不在点击发送时才做这些准备，并避免重复准备。

## SDK 优化方案

### 1. 明确预热 API 语义

SDK SHOULD 提供或增强 `prewarmChannel(channel)`：

- 只针对 E2EE 群生效。
- 预热群成员设备缓存。
- 预计算 memberHash。
- 预加载本地 sender key record。
- 如果本地没有 sender key，可提前创建 record，但不应上传无意义 envelopes，除非 Web 明确调用发送准备。

SDK SHOULD 额外提供 `prepareGroupSend(channel)` 或等价能力：

- 用于用户输入前/发送前准备 sender-key envelopes。
- 可被 Web 在输入框 focus 时调用。
- 同一群同一成员 hash 的准备请求必须并发去重。

### 2. 群成员设备缓存

SDK SHOULD 对群成员设备列表做长期缓存，并通过 memberHash/deviceVersion 或成员变动事件控制失效：

- cache key 包含 groupId 和 memberHash/deviceVersion。
- 缓存内容包含成员 uid、device_id、device e2ee 支持状态、identity 信息或取 key 所需字段。
- 缓存默认不设置固定时间过期；收到群成员变动、memberHash 变化、deviceVersion 变化、服务端返回设备不完整或发送失败指向设备 key 缺失时必须失效。
- 如果服务端无法提供可靠的 memberHash 或 deviceVersion，SDK 才允许启用短 TTL 作为兜底，避免永久使用无法校验的新旧设备列表。
- 缓存必须有上限，避免大群过多占用内存。

### 3. sender-key envelope 构建并发

SDK SHOULD 将 envelope 构建拆成有界并发：

- 不能对 300 到 1200 人大群做无界 Promise.all。
- SDK 默认并发建议 10；Web 可传入配置覆盖，第一版 Web 建议默认 20。
- 压测脚本需要覆盖 5、10、20、30、50，最终按首次发送耗时、CPU 卡顿和失败率选择生产默认值。
- 单个成员设备失败应记录失败信息；如果是必要接收设备失败，整体发送仍应 fail closed。

### 4. 上传去重和失败缓存

SDK 已有 sender-key envelope 上传去重和缺 key lookup 负缓存，本次 SHOULD 继续强化：

- 同一群、同一 sender device、同一 keyId、同一 memberHash、同一 recipientsHash 的 envelope 上传必须合并。
- 永久失败的 envelope lookup 在短期内不得重复请求。
- transient 失败可以有限重试，但不能阻塞 UI 太久。

### 5. 历史解密批处理支持

SDK SHOULD 提供批量解密辅助能力或保证 `decryptMessageIfNeeded` 可被 Web 有限并发调用：

- 同一 sender key envelope lookup 必须复用 promise。
- 历史消息按 messageSeq 顺序处理时，不应因为异步并发改变最终展示顺序。
- `Missing message key` 应优先尝试本地 sender key 重推导，再查服务端 envelope。

### 6. 性能指标

SDK SHOULD 在 debug 模式下输出结构化性能日志：

- `group_members_cache_hit`
- `group_members_fetch_ms`
- `member_hash_ms`
- `sender_key_record_load_ms`
- `sender_key_envelope_build_ms`
- `sender_key_envelope_upload_ms`
- `group_encrypt_total_ms`
- `sender_key_envelope_lookup_ms`

日志不得包含明文、sender key、session key、media key。

## 风险与约束

- 缓存成员设备可能在成员变动后短时间过期，因此必须以 memberHash 或服务端版本约束。
- 预创建 sender key 会增加少量本地存储，但可明显减少首次发送耗时。sender-key envelopes 必须在第一条消息发送前完成上传，失败则发送失败，不得明文降级。
- envelope 构建并发过高会造成 CPU 抖动，过低会影响大群首发速度，需要压测调参。
