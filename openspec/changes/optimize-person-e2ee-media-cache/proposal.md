## 背景

私聊 E2EE 图片在实时打开会话时可以显示，但刷新页面、切换会话后再回来，或会话未打开时收到图片后再进入，可能需要重新恢复媒体内容。私聊 Signal 消息的 message key 具有一次性消费特征，重复走 Signal 解密会出现 `MessageCounterError: Message key not found`。

上一轮已经通过缓存稳定的 `MessageEncryptedMedia` 元数据避免重复消费 Signal key。本次继续收紧边界：该媒体元数据明文缓存只服务私聊，不改变群聊现有缩略图缓存、sender key、envelope 和群历史恢复逻辑。

## 目标

- 仅优化私聊频道的 E2EE 媒体元数据缓存和恢复逻辑。
- 私聊图片/GIF/自定义表情等媒体，首次成功恢复后缓存稳定的 `MessageEncryptedMedia` 元数据，后续刷新或切换会话时不重复消费 Signal message key。
- 缩略图缓存保持 SDK 原有行为：所有频道仍按已有 best-effort 策略复用缩略图缓存。
- 原图、大文件、视频原始内容仍保持点击查看或下载时再解密。
- 群聊 E2EE 媒体恢复、缩略图缓存、sender key、envelope、群历史解密逻辑保持不变。

## 非目标

- 不改变群聊消息解密、群媒体恢复、群缩略图缓存、群 key 分发和重试逻辑。
- 不把私聊原图、视频、文件明文默认持久化。
- 不改变服务端媒体存储格式。
- 不新增迁移脚本，不批量重写历史消息。

## 方案

新增私聊媒体元数据缓存边界，将 `MessageEncryptedMedia` 明文缓存限定在 `ChannelTypePerson`：

- `ChatManager.cacheE2EEPlaintext` 将当前消息 channel 传入 E2EE 缓存策略。
- `E2EEManager.cacheablePlaintextContent` 只在私聊 restored media 场景把展示内容转换回 `MessageEncryptedMedia` 元数据。
- 群聊 restored media 不写入这条 plaintext cache，避免绕过群聊原有 decrypt 路径。
- `E2EEMediaCrypto` 的缩略图缓存不按频道关闭，保持变更前的全频道 best-effort 行为。
- 原图和文件继续只保存内存态 `blob:` URL；刷新后失效，需要用户再次点击时重新解密。

## 风险与处理

- 私聊媒体 metadata cache 损坏：读取失败时删除缓存并回退到 Signal 解密。
- 浏览器 localStorage 容量有限：只缓存媒体元数据和已有缩略图缓存，不缓存原图和文件明文字节。
- 群聊路径通过测试保护：群聊媒体不进入私聊 plaintext cache，但缩略图缓存仍保持原行为。
