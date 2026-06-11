## Why

TangSengDaoDaoWeb currently depends on `wukongimjssdk@1.2.11`. A local source copy exists at `im_wukong_jssdk`. Web E2EE should be implemented inside this SDK so the web app can keep using the normal WKSDK message API with minimal business-code changes.

## What Changes

- Add Web E2EE client protocol support to `im_wukong_jssdk`.
- Add initialization, key registration, local key storage, device lookup, single-chat encryption, group sender-key encryption, and decrypt-before-notify behavior.
- Extend SDK models and config with E2EE fields.
- Keep file/media E2EE disabled for the first stage.
- Publish the SDK as an internal package consumed by `TangSengDaoDaoWeb`, preserving import compatibility for `wukongimjssdk`.

## Capabilities

### New Capabilities

- `e2ee-web-sdk`: Web SDK E2EE implementation for first-stage single-chat and group-chat user messages.

### Modified Capabilities

- None.

## Impact

- Affected areas: `src/chat_manager.ts`, `src/model.ts`, `src/config.ts`, `src/index.ts`, new `src/signal` or `src/e2ee` modules, package dependencies, build output, internal package publishing.
- Related projects: `TangSengDaoDaoWeb`, `WuKongIM`, `TangSengDaoDaoServer`, `im-app-flutter`.
- First-stage scope excludes file/media E2EE and UI presentation changes.
