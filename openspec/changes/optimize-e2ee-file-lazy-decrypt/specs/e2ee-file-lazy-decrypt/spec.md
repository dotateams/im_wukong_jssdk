# E2EE 普通文件懒解密需求

## ADDED Requirements

### Requirement: 普通文件不得在消息接收或历史拉取阶段解密原文件

当 E2EE 消息体中的媒体内容是普通文件且没有缩略图时，SDK MUST 只恢复文件元数据和 E2EE 媒体信封，不得在 `restoreContent` 阶段下载或解密 `original`。

#### Scenario: 实时收到 E2EE 普通文件消息

- **Given** 当前频道已开启 E2EE
- **And** 接收端通过 WebSocket 收到一条普通文件消息
- **When** SDK 解密消息体并恢复消息内容
- **Then** SDK MUST 返回原始文件消息类型
- **And** 返回内容 MUST 包含文件名、大小和 `e2eeMedia.original`
- **And** SDK MUST NOT 在该阶段请求 `original.url`
- **And** 返回内容中的 `url` MUST 为空或不可直接下载

#### Scenario: 拉取历史 E2EE 普通文件消息

- **Given** 历史消息中包含 E2EE 普通文件消息
- **When** SDK 执行历史消息解密
- **Then** SDK MUST 只恢复文件元数据
- **And** SDK MUST NOT 因展示历史消息而下载大文件密文

### Requirement: 用户主动下载时才解密普通文件原文

普通文件原文 MUST 通过 `loadMediaOriginal` 懒加载。调用方主动请求下载时，SDK 才能下载密文、校验 `sha256`、用 `key` 和 `nonce` 解密，并返回本地 Blob URL。

#### Scenario: 用户点击下载 E2EE 普通文件

- **Given** 文件消息包含 `e2eeMedia.original`
- **And** 文件内容尚未生成本地 Blob URL
- **When** 调用方执行 `loadMediaOriginal(content)`
- **Then** SDK MUST 下载 `original.url` 指向的密文文件
- **And** SDK MUST 校验密文哈希
- **And** SDK MUST 在本地解密文件
- **And** SDK MUST 返回 `blob:` URL

#### Scenario: 同一页面重复下载同一个文件

- **Given** 文件消息已经通过 `loadMediaOriginal` 成功生成 `originalBlobUrl`
- **When** 调用方再次执行 `loadMediaOriginal(content)`
- **Then** SDK MUST 直接返回缓存的 `originalBlobUrl`
- **And** SDK MUST NOT 重复请求 `original.url`

### Requirement: 图片和 GIF 的缩略图展示策略不得退化

对于存在 `thumb` 的 E2EE 媒体消息，SDK MUST 保持当前缩略图优先展示策略，消息展示阶段只解密缩略图，原文仍在用户查看原图或播放原始资源时懒加载。

#### Scenario: 拉取历史 E2EE 图片消息

- **Given** 历史消息中包含 E2EE 图片
- **And** 该消息包含 `thumb` 和 `original`
- **When** SDK 恢复消息内容
- **Then** SDK MUST 下载并解密 `thumb`
- **And** SDK MUST NOT 在展示阶段下载 `original`

### Requirement: 解密后的普通文件不得持久化缓存

SDK MUST NOT 将解密后的普通文件 Blob 或明文字节写入 IndexedDB、SQLite、localStorage 或其他持久化存储。

#### Scenario: 下载 E2EE 普通文件后刷新页面

- **Given** 用户已经下载过一个 E2EE 普通文件
- **When** 用户刷新浏览器页面
- **Then** SDK MAY 丢失内存中的 `originalBlobUrl`
- **And** 再次下载时 MUST 重新通过密文文件和 E2EE 元数据解密
