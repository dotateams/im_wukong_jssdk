## 设计说明

### 范围边界

本变更只调整私聊频道 `ChannelTypePerson` 的 E2EE 媒体元数据明文缓存。SDK 在缓存解密后的媒体内容时，会把当前消息所在的频道传给 E2EE 缓存策略，由策略决定是否把 restored media 转换成 `MessageEncryptedMedia` 元数据后写入本地 plaintext cache。

群聊 `ChannelTypeGroup` 不使用这条私聊媒体元数据缓存路径。群聊 sender key、群 envelope、群历史消息恢复、群缩略图缓存逻辑保持原行为。

### 数据流

1. 私聊图片首次实时收到或首次拉取历史时，Signal 解密得到 `MessageEncryptedMedia`。
2. SDK 恢复为图片内容，并按原有媒体逻辑恢复缩略图。
3. `ChatManager.cacheE2EEPlaintext` 看到该消息是私聊 restored media 后，将展示内容转换成稳定的 `MessageEncryptedMedia` 元数据写入 plaintext cache。
4. 后续刷新页面、切换会话再回来时，SDK 先从 plaintext cache 恢复 `MessageEncryptedMedia` 元数据，再恢复图片内容。
5. 这条路径避免再次消费私聊 Signal message key。
6. 群聊媒体即使恢复成功，也不会写入这条 plaintext media metadata cache，后续仍走群聊原有解密路径。

### 缓存策略

- 新增/调整缓存对象：私聊 restored media 的 `MessageEncryptedMedia` 元数据。
- 频道范围：仅私聊。
- 缩略图缓存：保持原有全频道 best-effort 行为，不在本变更中收窄。
- 原图/文件：不持久缓存，仍由 `loadOriginal` 在用户点击时处理。

### 测试策略

- 私聊测试：收到图片后第二次恢复命中媒体元数据缓存，不重复消费 Signal message key，也不重复 fetch 缩略图密文。
- 群聊保护测试：群聊媒体恢复两次时 decrypt 路径仍执行两次，证明没有进入私聊 plaintext media metadata cache；同时缩略图 fetch 仍只发生一次，证明群聊原有缩略图缓存没有被关闭。
- 保留现有媒体恢复、文件懒解密、私聊 Signal key 不重复消费测试。
