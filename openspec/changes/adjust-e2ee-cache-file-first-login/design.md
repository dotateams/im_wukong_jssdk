# 设计说明：SDK E2EE 缓存保留、私聊文件懒解密与首次登录同步标记

## 缓存保留策略

SDK 保持 E2EE 本地存储长期有效，包括：

- plaintext cache
- media thumbnail cache
- sender key
- Signal session
- 私聊 session
- group sender key
- envelope 负缓存和恢复队列

SDK 可以继续保留显式清理 API，用于将来“清除本机数据”或测试场景，但退出登录不应隐式调用。任何清理都必须由调用方明确触发。

## 私聊普通文件懒解密

普通文件的消息内容必须持久化完整 E2EE media metadata。刷新后 SDK 应只依赖消息内容和本地密钥，不依赖内存中的 `blob:` URL。

点击下载流程：

1. Web 将持久化后的 `MessageContent` 传给 SDK。
2. SDK 判断是否存在 `e2eeMedia.original` 或等价原文密文 part。
3. SDK 使用 part 中的密文 URL 下载密文。
4. SDK 校验 hash、iv、salt、alg 等参数。
5. SDK 使用私聊当前可用 session/key 解密原文。
6. SDK 返回新的本地 `blob:` URL、文件名和 MIME 信息。

失败时必须返回可区分错误：

- `missing_media_metadata`
- `missing_private_session`
- `ciphertext_fetch_failed`
- `media_integrity_failed`
- `media_decrypt_failed`

Web 可根据错误显示对应提示。

## 首次登录同步边界

SDK 不直接保存“首次登录是否跳过历史”的产品策略，但应保证：

- 调用方不请求历史时，SDK 不主动补拉历史。
- WebSocket 重连后的同步仍由现有重连流程触发。
- 如果 Web 明确调用历史同步接口，SDK 按原逻辑执行。

如果 SDK 内部存在自动 sync 触发点，需要允许 Web 传入或配置 `skipInitialHistorySync`，仅对登录初始化阶段生效，不影响重连和手动同步。

## 测试策略

- 调用退出相关流程后，SDK 本地 E2EE key/value 仍存在。
- 显式清理 API 仍可在测试中单独调用。
- 私聊 E2EE 普通文件在无旧 `blob:` URL 的情况下，能根据持久化消息元数据重新解密下载。
- 普通文件渲染阶段不触发原文下载。
- `skipInitialHistorySync` 只影响首次登录初始化，不影响重连同步。

