# 设计说明：SDK E2EE 本地明文缓存与 sender key 持久化

## 总体策略

SDK 继续以密文消息作为服务端可信来源。本地缓存只用于提升当前设备的历史展示速度和稳定性，不改变服务端存储模型。

解密流程调整为：

1. 收到或拉取密文消息。
2. 按账号、设备、频道、消息定位本地明文缓存。
3. 命中明文缓存时直接恢复 `MessageContent` 并展示。
4. 未命中时使用本地 sender key 解密密文。
5. 解密成功后写入本地明文缓存。
6. 解密失败且错误属于缺 key 或 key 失效时，再查询服务端 key envelope。
7. key 恢复成功后重试解密，并按顺序刷新待解密消息。
8. 仍失败时保留密文来源，展示无法解密提示。

## 本地明文缓存

SDK 需要提供统一的 E2EE plaintext cache 接口，用于保存和读取已经解密的消息内容。

缓存 key 必须至少包含：

- 当前登录 UID
- 当前设备 ID
- channelID
- channelType
- messageID 或 clientMsgNo
- 密文摘要或 keyId，用于避免消息内容变化后误用旧明文

缓存内容建议保存为：

- contentType
- 解密后的 `MessageContent.encodeJSON()` payload
- 原始密文摘要
- 写入时间
- 发送者 UID
- 发送者 deviceId

该缓存不设置过期时间。缓存读取失败、格式错误或密文摘要不一致时，必须删除该条缓存并回退到密文重新解密。

## sender key 持久化

群 sender key 必须长期持久化保存，不因刷新页面或重启浏览器而丢失。SDK 不应按时间主动过期 sender key。

当出现以下情况时，才允许重新向服务端查询 key envelope：

- 本地没有该群、发送者设备、keyId 对应的 sender key。
- 本地 sender key 存在，但解密当前消息返回 `Missing sender key`、`Missing message key` 或等价错误。
- 本地 sender key 记录损坏，无法反序列化或无法导入。

同一个恢复请求必须做并发去重，避免同一时间对相同 groupId、senderUid、senderDeviceId、keyId、recipientUid、recipientDeviceId 发起多次请求。服务端返回 403/404 时可以短时间负缓存，避免刷屏。

## 媒体缩略图缓存

图片、GIF、自定义表情等存在缩略图的 E2EE 媒体消息，SDK 应支持缓存解密后的缩略图 Blob 数据或可恢复数据。缓存 key 必须包含账号、设备、频道、消息和媒体 part hash。

刷新页面后：

1. 优先读取本地缩略图缓存。
2. 命中时生成新的 `blob:` URL 展示。
3. 未命中时下载密文缩略图、校验 hash、解密、写入缩略图缓存。

普通大文件原文不做长期缓存，仍然只在用户主动点击下载时通过 `loadMediaOriginal` 解密。

## 清理策略

SDK 需要暴露清理当前账号当前设备 E2EE 本地数据的能力，供 Web 在退出登录确认后调用。清理范围包括：

- 文本明文缓存
- 媒体缩略图缓存
- 本地 sender key 持久化记录
- E2EE 解密失败负缓存
- 与当前账号设备相关的 E2EE 临时恢复队列

清理失败时必须返回明确错误，Web 不应静默忽略。

## 风险控制

- 缓存只在本地使用，严禁通过 API 上传明文缓存。
- Debug 日志不得默认打印本地明文缓存内容。
- 缓存读写异常时，必须回退到密文解密流程，不能因为缓存失败导致普通收发不可用。

