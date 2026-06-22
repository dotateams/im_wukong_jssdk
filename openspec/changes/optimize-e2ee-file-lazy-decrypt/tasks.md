## 实施任务

- [x] 为普通文件懒解密新增 SDK 回归测试，确认 `restoreContent` 不触发原文件 fetch。
- [x] 调整 `E2EEMediaCrypto.restoreContent`，普通文件只恢复元数据和 `e2eeMedia`。
- [x] 保持图片/GIF 缩略图优先解密逻辑不变。
- [x] 为 `loadOriginal` 点击下载路径补充缓存与失败测试。
- [x] 更新 Web 文件卡片，点击 E2EE 文件时调用 `loadMediaOriginal` 后再下载。
- [x] 为 Web 文件下载懒解密补充测试。
- [x] 重建 SDK 并更新 Web vendor 包。
- [x] 运行 SDK 测试、Web 文件测试和 Web 构建。
