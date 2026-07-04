# 设计说明：E2EE 媒体文件快速转发

## 核心原则

E2EE 媒体文件转发不能直接复用源消息的加密消息体，也不能因为文件大小或是否分片而走不同安全模型。正确边界是：

- 密文文件本体可以复用。
- 大文件、小文件、分片文件、非分片文件都按同一套“复用密文文件 + 重包 mediaKey 信封”处理。
- 文件明文密钥 `mediaKey` 不能明文离开客户端。
- `mediaKeyEnvelope` 必须按目标频道重新生成。
- 新转发消息必须是目标频道的一条新消息，拥有新的消息 ID、发送者、时间和目标频道 E2EE 封装。

## 数据模型

### 媒体文件本体

媒体文件本体继续保存在 MinIO 或现有文件存储中，内容始终为密文：

```text
object_path: chat/2/{channel_id}/{file_id}-original.e2ee
thumb_path:  chat/2/{channel_id}/{file_id}-thumb.e2ee
chunks:      chat/2/{channel_id}/{file_id}/chunks/{index}.e2ee
```

快速转发时，`object_path` 可以继续指向源密文对象，也可以由服务端建立新的引用路径，但服务端不能解密文件。

### 媒体密钥

每个媒体文件拥有独立随机 `mediaKey`：

```text
mediaKey = random(32 bytes)
```

文件、缩略图、分片加密可直接使用 `mediaKey`，也可通过 HKDF 派生：

```text
fileKey = HKDF(mediaKey, "file")
thumbKey = HKDF(mediaKey, "thumb")
chunkKey[index] = HKDF(mediaKey, "chunk:" + index)
```

### 媒体信封

消息内容中保存目标频道可解开的信封：

```json
{
  "media_key_envelope": {
    "version": 1,
    "alg": "aes-256-gcm",
    "scope": "channel",
    "channel_id": "目标频道ID",
    "channel_type": 2,
    "sender_device_id": "发送设备ID",
    "ciphertext": "...",
    "iv": "...",
    "aad": "..."
  }
}
```

信封明文只包含解密媒体需要的最小材料：

```json
{
  "media_key": "...",
  "file_digest": "...",
  "file_md5": "...",
  "created_at": 1780000000
}
```

### 原始文件 MD5

媒体元数据必须携带**明文原始文件的 MD5**（`file_md5`），用途是加密频道转普通频道时按 MD5 查询可复用的普通明文对象，避免下载解密重传。

- 加密上传时，SDK 在读取明文文件本体阶段顺带计算 MD5，写入单文件元数据或分片 manifest。
- MD5 基于**明文文件整体**计算，不是密文、不是分片密文。
- 该字段不参与文件本体加密，仅作为普通频道秒传/复用查询键。
- 若某条源消息元数据缺失 `file_md5`（例如结构异常），转发到普通频道时降级为本地解密后计算，再执行复用查询，不得直接跳过复用检查。

### 缩略图部件

缩略图（thumb）与文件本体使用同一套“复用密文对象 + 重包信封”规则：

- 转发到 E2EE 频道时，复用原缩略图密文对象及其 `url`、`hash`、`iv`、`size`，只随文件本体一起在目标频道信封中重包缩略图密钥材料，不重新上传缩略图。
- 转发到普通频道时，不携带任何 E2EE 缩略图信封；普通频道消息按普通媒体逻辑自行生成缩略图。
- 缩略图不得因“只考虑 original 和 chunks”而在实现中被遗漏。

## 转发流程

### 加密频道转加密频道

1. 用户选择源 E2EE 媒体消息并点击转发。
2. SDK 判断源消息是否支持快速转发。
3. SDK 解开源消息 `mediaKeyEnvelope`，得到 `mediaKey`。
4. SDK 构造新的媒体消息内容，复用文件 URL、缩略图 URL、分片 manifest、hash、MD5 和大小。
5. SDK 使用目标频道 E2EE 密钥重新封装 `mediaKey`。
6. Web 发送新消息。
7. 目标频道成员收到消息后，用目标频道密钥解开新信封，再下载同一份密文文件并解密。

### 加密频道转普通频道

加密频道转普通频道允许转发，但不能把 E2EE 密文文件或 `mediaKeyEnvelope` 当作普通文件直接发送。

1. SDK 解开源 `mediaKeyEnvelope`，确认当前设备有权读取文件。
2. SDK/Web 读取源消息中的明文文件 MD5 或原始文件 digest。
3. Web 调用服务端普通文件 MD5 查询或秒传接口。
4. 如果明文对象存在，直接复用该普通文件 URL 和文件元数据发送普通文件消息。
5. 如果明文对象不存在，客户端下载源密文，使用 `mediaKey` 本地解密，按普通文件上传逻辑上传明文文件。
6. 目标普通频道收到普通文件消息，消息中不得携带 E2EE 信封。

### 普通频道转加密频道

普通文件没有 `mediaKeyEnvelope`，不能快速复用为 E2EE 文件：

1. SDK 或 Web 下载普通文件明文。
2. SDK 为目标频道生成新的 `mediaKey`。
3. 文件重新加密上传。
4. 发送新的 E2EE 媒体消息。

### 同一加密频道内转发

推荐仍然生成新消息，并重新生成当前频道 envelope。这样实现统一，便于审计和排查。由于文件本体不重新上传，性能影响很小。

### 合并转发（Mergeforward）

合并转发集合中如果内嵌 E2EE 媒体消息，每一条内嵌媒体必须走与单条转发**完全相同**的规则：

- 目标为 E2EE 频道：逐条复用密文对象并按目标频道重包信封，集合内任何媒体本体都不重新上传。
- 目标为普通频道：逐条按“MD5 命中复用 / 未命中解密重传”处理，且合并转发消息不携带 E2EE 信封。
- 集合中若存在当前设备不可解的 E2EE 媒体，SDK 返回带定位信息的 typed error，Web 明确提示“合并转发中的加密文件无法在当前设备转发”，不得静默丢弃该条或发出无法解密的引用。

## 单文件和分片文件处理

单文件和分片文件使用相同的转发原则：

- 转发到 E2EE 频道时，复用已有密文对象，不重新上传。
- 单文件复用原 `object_path`、hash、iv、size、MD5 等字段。
- 分片文件复用原 manifest、chunk paths、chunk hashes、chunk IVs、chunk size、chunk count、MD5 等字段。
- 两者都只替换目标频道的 `mediaKeyEnvelope`。
- 两者都必须保留原始文件 MD5，用于加密频道转普通频道时的明文对象复用查询。

## 服务端配合

如果当前文件下载权限只根据对象路径中的源 `channel_id/channel_type` 判断，需要新增更适合转发的授权方式：

- 方案 A：服务端允许通过消息内容中的对象引用下载密文文件，校验请求用户是否有目标消息所在频道的查看权限。
- 方案 B：转发时创建密文对象引用记录，把同一个 object 关联到目标频道，不复制 MinIO 文件。
- 方案 C：保持现有路径权限，若目标频道下载失败则客户端降级为重新上传。

推荐方案 B。它不会泄露明文，也不会复制大文件，只增加对象引用记录，权限边界最清楚。

采用方案 B 时，对象引用创建必须**幂等且并发安全**：

- 同一 (object, 目标消息) 至多创建一条引用记录，重复请求返回既有引用，不重复计数。
- 用户多选逐条或并发把同一文件转发到多个频道时，引用计数在并发下保持正确，不重复、不漏计。
- 引用创建只增加记录，不复制底层 MinIO 对象。
- 建议以 (object_id, target_message_id) 作为唯一键，靠数据库唯一约束或 upsert 保证并发去重。

## 清理策略

现有上传文件清理能力需要覆盖 E2EE 分片信息和文件对象，避免只清 session 不清 chunks、只清文件不清 manifest 引用。

清理范围：

- 未完成的 E2EE 分片上传 session。
- 未完成 session 下已上传的密文 chunk 对象。
- `file_e2ee_upload_chunk` 或等价分片记录。
- 已取消上传产生的临时密文对象。
- 加密频道转普通频道走“本地解密后重传”时，中途取消或失败产生的临时明文对象。
- 过期且没有任何消息或对象引用记录持有的 E2EE 密文文件。
- 过期且没有任何消息引用的普通明文秒传文件，沿用现有普通文件清理规则。

清理要求：

- 已被历史消息引用的密文对象不能删除。
- 已被快速转发新消息引用的密文对象不能因为源消息删除或源频道清理而误删。
- 如果采用对象引用表，只有引用计数为 0 或没有任何有效引用时，才允许删除底层 MinIO 对象。
- 分片 manifest 和 chunk 记录需要一起清理，不能留下孤儿分片。
- 删除对象失败时保留记录并下次重试，不影响在线消息收发。

## SDK 接口建议

```ts
canForwardE2EEMedia(content): boolean

prepareE2EEMediaForward(options: {
  sourceContent: MessageContent
  targetChannelID: string
  targetChannelType: number
  targetIsE2EE: boolean
}): Promise<MessageContent>
```

`canForwardE2EEMedia(content)` 的判定必须确定且可校验，返回 true 当且仅当：

- 当前设备可解开源 `mediaKeyEnvelope`（拥有源频道解封所需密钥材料）；
- 源媒体存在可复用的密文对象引用：单文件有 `object`（url/hash/iv/size），或分片有完整 `manifest`（chunk paths/hashes/ivs/count/size）；
- 目标频道为 E2EE 时，目标频道 E2EE 密钥可用或可被准备流程就绪。

任一条件不满足时返回 false，并给出 typed reason（如 `envelope-unreadable`、`missing-object`、`target-key-unavailable`），供 UI 做对应提示或降级，不得静默失败。

返回的新 `MessageContent` 必须：

- 不复用源消息实例。
- 不携带源频道 message key、sender key 或源频道 envelope。
- 保留文件展示字段：文件名、大小、MIME、宽高、时长、缩略图、manifest、MD5。
- 对目标 E2EE 频道生成新的 `mediaKeyEnvelope`。
- 对普通频道生成普通文件消息，不能携带 E2EE 信封。

## 错误处理

- 源消息无法解开 `mediaKeyEnvelope`：提示“该加密文件无法在当前设备转发”。
- 目标频道 E2EE 密钥不可用：先触发目标频道密钥准备流程，失败后提示“目标会话加密密钥未就绪”。
- 服务端密文对象引用创建失败：降级为重新上传，或提示用户稍后重试。
- 普通频道 MD5 查询失败：降级为本地解密后重新上传；如果重新上传也失败，提示“文件转发失败，请稍后重试”。
- 清理任务删除对象失败：保留记录并下次重试，不影响在线消息收发。

## 测试策略

- 小文件 E2EE 图片从加密群转发到另一个加密群，不重新上传文件，目标可解密。
- 分片 E2EE 大文件从加密群转发到另一个加密群，不重新上传 chunks，目标可下载解密。
- 同一加密群内转发 E2EE 文件，生成新消息，文件可下载。
- 加密私聊转加密群，重新生成群信封，群成员可解密。
- 加密群转加密私聊，重新生成私聊信封，对方可解密。
- 加密频道转普通频道，MD5 命中时复用明文文件，未命中时本地解密后上传。
- 加密频道转普通频道，源元数据缺失 `file_md5` 时降级为本地解密计算 MD5 再复用查询。
- 带缩略图的 E2EE 图片/视频转发到 E2EE 频道，缩略图复用不重新上传；转发到普通频道不携带 E2EE 缩略图信封。
- 合并转发包含 E2EE 媒体到 E2EE 频道，逐条复用不重传；集合中含不可解媒体时给出定位明确的错误。
- 同一文件并发转发到多个频道，服务端引用记录幂等、引用计数正确、不复制 MinIO 对象。
- `canForwardE2EEMedia()` 在缺 envelope / 缺对象 / 目标密钥不可用时分别返回带 typed reason 的 false。
- 加密转普通中途取消或失败后，临时明文对象被清理，不残留孤儿对象或悬挂消息引用。
- 过期未完成分片上传清理后，session、chunk 记录、临时对象均被清理。
- 源设备缺少 `mediaKey` 时转发失败并给出明确提示。
