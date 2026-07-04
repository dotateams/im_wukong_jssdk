# e2ee-media-forwarding 规格

## ADDED Requirements

### Requirement: E2EE 媒体文件必须支持密文复用转发

SDK SHALL support forwarding an E2EE media message by reusing the encrypted media object and creating a new message for the target channel.

#### Scenario: 小文件和大文件使用相同转发模型

- **GIVEN** 源消息是可解密的 E2EE 媒体消息
- **AND** 该媒体可能是单文件、分片文件、小文件或大文件
- **WHEN** 用户转发到 E2EE 目标频道
- **THEN** SDK SHALL reuse the existing encrypted object or encrypted chunks
- **AND** SDK SHALL only rewrap the media key envelope for the target channel
- **AND** SDK SHALL NOT choose a different security model based on file size

#### Scenario: 加密群转发 E2EE 文件到另一个加密群

- **GIVEN** 源消息是可解密的 E2EE 文件消息
- **AND** 目标频道是 E2EE 加密群
- **WHEN** 用户转发该文件
- **THEN** SDK SHALL reuse the encrypted file URL or chunk manifest
- **AND** SDK SHALL generate a new media key envelope for the target group
- **AND** SDK SHALL NOT re-upload the encrypted file chunks

### Requirement: 每个媒体文件必须使用独立 mediaKey

E2EE media encryption SHALL use a per-media random `mediaKey` independent from the channel message key.

#### Scenario: 文件被多次转发

- **GIVEN** 同一份 E2EE 文件被转发到多个 E2EE 频道
- **WHEN** 目标频道成员下载文件
- **THEN** 每个频道 SHALL use its own `mediaKeyEnvelope`
- **AND** the encrypted file body MAY be shared
- **AND** plaintext `mediaKey` SHALL NOT be stored on the server

### Requirement: 目标频道信封必须重新生成

SDK SHALL rewrap `mediaKey` for every target E2EE channel.

#### Scenario: 加密私聊转加密群

- **GIVEN** 源消息来自 E2EE 私聊
- **AND** 目标频道是 E2EE 群
- **WHEN** 用户转发媒体消息
- **THEN** SDK SHALL unwrap the private-chat envelope locally
- **AND** SDK SHALL wrap the same `mediaKey` with the target group E2EE key
- **AND** the target group message SHALL NOT contain the source private-chat envelope

### Requirement: 分片 E2EE 文件必须复用 manifest

Chunked E2EE files SHALL be forwarded by reusing encrypted chunks and manifest metadata.

#### Scenario: 转发 512MB 分片文件

- **GIVEN** 源消息包含 `e2eeMedia.version = 2` 的 chunk manifest
- **WHEN** 用户转发到目标 E2EE 频道
- **THEN** SDK SHALL preserve chunk paths, chunk hashes, chunk IVs, file size, file MD5 and chunk count
- **AND** SDK SHALL only replace the `mediaKeyEnvelope`
- **AND** SDK SHALL NOT download and re-upload all chunks

### Requirement: 源媒体不可解密时不得快速转发

SDK SHALL reject fast forwarding when the current device cannot unwrap the source media key.

#### Scenario: 当前设备缺少源信封密钥

- **GIVEN** 源媒体消息存在 `mediaKeyEnvelope`
- **AND** 当前设备无法解开该 envelope
- **WHEN** 用户尝试快速转发
- **THEN** SDK SHALL return a typed error
- **AND** Web SHALL show a clear message that the encrypted file cannot be forwarded on this device

### Requirement: 加密频道转普通频道必须优先复用明文文件

When forwarding from an E2EE channel to a normal channel, SDK/Web SHALL check whether a normal plaintext file object with the same MD5 already exists before uploading.

#### Scenario: MD5 命中已有普通文件

- **GIVEN** 源消息是 E2EE 文件
- **AND** 目标频道是普通频道
- **AND** 服务端存在相同 MD5 的普通明文文件对象
- **WHEN** 用户转发该文件
- **THEN** Web SHALL reuse the normal plaintext file object
- **AND** Web SHALL send a normal file message
- **AND** Web SHALL NOT send `mediaKeyEnvelope` to the normal channel

#### Scenario: MD5 未命中普通文件

- **GIVEN** 源消息是 E2EE 文件
- **AND** 目标频道是普通频道
- **AND** 服务端不存在相同 MD5 的普通明文文件对象
- **WHEN** 用户转发该文件
- **THEN** SDK SHALL decrypt the encrypted media locally
- **AND** Web SHALL upload it as a normal plaintext-channel file
- **AND** Web SHALL send a normal file message without E2EE envelope

### Requirement: E2EE 媒体清理必须覆盖分片信息和对象

Cleanup jobs SHALL remove expired unfinished E2EE upload metadata and encrypted objects consistently.

#### Scenario: 清理过期未完成分片上传

- **GIVEN** 一个 E2EE 分片上传 session 已过期且未完成
- **WHEN** 清理任务执行
- **THEN** server SHALL remove the upload session record
- **AND** server SHALL remove related chunk metadata records
- **AND** server SHALL remove uploaded encrypted chunk objects when they are not referenced
- **AND** server SHALL retry later if object deletion fails

#### Scenario: 快速转发后的密文对象仍被引用

- **GIVEN** 一个 E2EE 密文文件被多个转发消息引用
- **WHEN** 源消息或源频道触发文件清理
- **THEN** server SHALL NOT delete the encrypted object while any valid message or object reference exists

### Requirement: 服务端不得接触明文 mediaKey

Server APIs supporting E2EE media forwarding SHALL store only encrypted media objects, object references and encrypted envelopes.

#### Scenario: 创建密文对象引用

- **GIVEN** 客户端转发 E2EE 文件到目标频道
- **WHEN** 服务端创建对象引用或授权目标消息下载
- **THEN** 服务端 SHALL NOT require plaintext `mediaKey`
- **AND** 服务端 SHALL validate requester and target channel permissions
- **AND** 服务端 SHALL NOT decrypt or re-encrypt the media body

### Requirement: 媒体元数据必须携带原始文件 MD5

E2EE media metadata SHALL carry the plaintext original-file MD5 so that forwarding to a normal channel can look up a reusable plaintext object without decrypting.

#### Scenario: 加密上传时写入明文 MD5

- **GIVEN** 用户在 E2EE 频道上传媒体文件
- **WHEN** SDK 加密文件本体
- **THEN** SDK SHALL compute the MD5 of the plaintext original file
- **AND** SDK SHALL store that MD5 in the media metadata (single-file and chunked manifest 都必须包含)
- **AND** the plaintext file bytes SHALL NOT be uploaded or leave the client

#### Scenario: 转发时元数据缺失 MD5 的降级

- **GIVEN** 源 E2EE 媒体元数据没有明文 MD5
- **WHEN** 用户转发到普通频道
- **THEN** SDK SHALL decrypt the source ciphertext locally to compute the MD5
- **AND** SDK SHALL then perform the normal-channel reuse-or-upload flow with that MD5
- **AND** SDK SHALL NOT skip the MD5 reuse check merely because the field was absent

### Requirement: 缩略图必须与文件本体使用同一套复用与重包规则

Thumbnails of E2EE media SHALL be forwarded using the same reuse-and-rewrap model as the file body, never re-encrypted or re-uploaded on fast forward.

#### Scenario: 转发带缩略图的 E2EE 图片或视频

- **GIVEN** 源 E2EE 媒体消息包含缩略图部件
- **WHEN** 用户快速转发到 E2EE 目标频道
- **THEN** SDK SHALL reuse the existing encrypted thumbnail object and its metadata (url、hash、iv、size)
- **AND** SDK SHALL rewrap the thumbnail key material under the target-channel envelope together with the file body
- **AND** SDK SHALL NOT re-upload the thumbnail

#### Scenario: 转发到普通频道时的缩略图

- **GIVEN** 源 E2EE 媒体消息包含缩略图
- **WHEN** 用户转发到普通频道
- **THEN** Web SHALL NOT carry any E2EE thumbnail envelope into the normal channel
- **AND** Web SHALL let the normal-channel message regenerate its own thumbnail as normal media does

### Requirement: 快速转发能力判定必须显式且可校验

SDK SHALL expose a deterministic `canForwardE2EEMedia()` decision whose inputs are explicitly defined, so callers get a consistent answer before attempting a fast forward.

#### Scenario: 判定所需字段齐全

- **GIVEN** 一条候选转发的媒体消息
- **WHEN** SDK 评估 `canForwardE2EEMedia()`
- **THEN** SDK SHALL return true only when 当前设备可解开源 `mediaKeyEnvelope`
- **AND** 源媒体存在可复用的密文对象引用（single `object` 或 chunked `manifest`）
- **AND** 目标频道为 E2EE 时目标频道 E2EE 密钥可用（或可被准备流程就绪）
- **AND** SDK SHALL return false with a typed reason 当上述任一条件不满足

#### Scenario: 判定结果驱动 UI

- **GIVEN** `canForwardE2EEMedia()` 返回 false
- **WHEN** 用户在转发入口选择该媒体消息
- **THEN** Web SHALL 依据 typed reason 给出对应提示或降级路径
- **AND** Web SHALL NOT 静默失败或发出无法解密的消息

### Requirement: 合并转发内嵌 E2EE 媒体必须与单条转发一致

Merge-forward (合并转发) SHALL apply the same E2EE media forwarding rules to每一条内嵌媒体消息 as single-message forwarding.

#### Scenario: 合并转发包含 E2EE 媒体到 E2EE 频道

- **GIVEN** 一个合并转发集合中包含 E2EE 媒体消息
- **AND** 目标频道是 E2EE 频道
- **WHEN** 用户执行合并转发
- **THEN** SDK SHALL reuse each media 的密文对象并按目标频道重包信封
- **AND** SDK SHALL NOT re-upload any media body inside the merge set

#### Scenario: 合并转发中存在不可快速转发的媒体

- **GIVEN** 合并转发集合中某条 E2EE 媒体在当前设备不可解
- **WHEN** 用户执行合并转发
- **THEN** SDK SHALL surface a typed error identifying the offending item
- **AND** Web SHALL 明确提示该合并转发中的加密文件无法在当前设备转发，而非静默丢弃或发出损坏引用

### Requirement: 密文对象引用创建必须幂等且并发安全

Encrypted-object reference creation SHALL be idempotent and safe under concurrent forwards of the same media to one or more channels.

#### Scenario: 同一文件并发转发到多个频道

- **GIVEN** 用户多选逐条或同时把同一份 E2EE 文件转发到多个目标频道
- **WHEN** 服务端并发收到多个对象引用创建请求
- **THEN** server SHALL create at most one reference record per (object, target message) 且重复请求返回既有引用
- **AND** server SHALL keep reference counting correct under concurrency（不重复计数、不漏计数）
- **AND** server SHALL NOT duplicate the underlying MinIO object

### Requirement: 加密转普通的临时明文对象必须可清理

When forwarding from an E2EE channel to a normal channel requires local decrypt-and-reupload, any interim plaintext object produced by a cancelled or failed forward SHALL be cleanable.

#### Scenario: 解密重传中途取消或失败

- **GIVEN** 加密转普通频道走本地解密后重新上传明文文件
- **AND** 该过程在完成前被取消或失败
- **WHEN** 清理任务执行
- **THEN** server SHALL remove any orphan plaintext object that no message references
- **AND** client SHALL NOT leave a half-sent normal file message referencing a missing object
- **AND** cleanup SHALL retry later if object deletion fails
