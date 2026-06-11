## Context

The demo SDK is a later fork with E2EE code, but production Web is on `wukongimjssdk@1.2.11`. The new local `im_wukong_jssdk` directory matches the production dependency boundary and should become the Web E2EE SDK source. `TangSengDaoDaoWeb` should only wire this SDK in and pass login/channel metadata.

## Goals / Non-Goals

**Goals:**

- Preserve the public package name `wukongimjssdk`.
- Produce an internal package artifact that TangSengDaoDaoWeb can consume as a separate project.
- Allow existing send APIs to encrypt automatically when the channel is E2EE-enabled.
- Decrypt incoming E2EE messages before application listeners receive them.
- Support single-chat multi-device encryption and group sender-key encryption.
- Store private keys and local sessions only in browser local storage/IndexedDB.
- Provide exports needed by the web app to initialize and observe E2EE state.

**Non-Goals:**

- Move TangSengDaoDao business UI into the SDK.
- Encrypt file/media payloads in the first stage.
- Make Web and Flutter share one language implementation.
- Change WuKongIM transport protocol beyond sending normal message payloads.

## Decisions

- E2EE is implemented as SDK middleware around `ChatManager.sendWithOptions()` and `ChatManager.onPacket()`.
- `WKConfig` gains E2EE initialization state, including uid, stable device ID, API client adapter, device metadata, and feature flag.
- `ChannelInfo.isE2e`, `ChannelInfo.e2eEnabledAt`, and `Conversation.isE2e` are SDK-level normalized fields. The web app maps server `is_e2e` and activation metadata into these fields.
- The server contract field remains `is_e2e`; the SDK may expose camel-case `isE2e` internally.
- `MessageSignalContent` stores `ciphertext`, `message_type`, `real_content_type`, and `sender_device_id`.
- Single-chat encrypted payloads use a `signal_multi` envelope with per-device ciphertexts for the recipient's active devices and the sender's other active sync devices.
- Group encrypted payloads use a `signal_group` envelope. Sender-key distribution and missing-key recovery use CMD messages.
- The SDK exposes a small E2EE facade so the web app can call initialization without knowing internal crypto classes.
- The SDK sends plaintext only when channel metadata explicitly says E2EE is disabled. Missing or stale metadata must trigger refresh; unresolved metadata blocks send instead of guessing plaintext.
- The SDK does not decide whether new person chats default to E2EE. It follows the business server's `is_e2e` channel metadata after the host app resolves send preflight or manual-enable policy.
- Existing plaintext history is receive-compatible. The SDK can render old plaintext messages in an enabled channel, but all new first-stage user-authored sends after activation must use E2EE.
- New devices are forward-only. The SDK must not request or replay historical sessions/sender keys for messages sent before that device was registered.
- Each device owns independent identity/prekey/session material. Web, App, and PC clients must not share one account-level private key.
- Release packaging is separate from Web. Development may use a local path, but production Web consumes a versioned internal package through the package manager.
- `package-lock.json` must be aligned with `package.json` before implementation completes because it currently carries a mismatched root version.

## Risks / Trade-offs

- The demo SDK contains file E2EE code that is not first-stage ready. Mitigation: migrate only text/general message E2EE paths and leave file E2EE disabled.
- Browser crypto compatibility can vary. Mitigation: add initialization failure states and build/test checks for supported browsers.
- Group sender-key distribution can be expensive in large groups. Mitigation: use paginated group-device lookup and bounded concurrency.
- Private package publishing can accidentally resolve to the public `wukongimjssdk` package. Mitigation: lock the registry/alias and verify the resolved package source in Web CI.
