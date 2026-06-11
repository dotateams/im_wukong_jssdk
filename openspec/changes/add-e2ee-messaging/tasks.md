## 1. Package Baseline

- [ ] 1.1 Align `package-lock.json` root version with `package.json`.
- [ ] 1.2 Add E2EE dependencies required by the selected Signal implementation.
- [ ] 1.3 Keep package name `wukongimjssdk` and build outputs under `lib/`.
- [ ] 1.4 Add internal package publish configuration and versioning.
- [ ] 1.5 Add a package resolution check so Web cannot accidentally use the public npm package.

## 2. Models And Config

- [ ] 2.1 Add E2EE config and initialization facade to `WKConfig`/`WKSDK`.
- [ ] 2.2 Add `isE2e` to `ChannelInfo` and `Conversation`.
- [ ] 2.3 Add channel activation metadata such as `e2eEnabledAt`.
- [ ] 2.4 Extend `MessageSignalContent` with ciphertext metadata.
- [ ] 2.5 Add first-stage constants and exported types.
- [ ] 2.6 Normalize server `is_e2e` as the canonical enabled-state field.

## 3. Key And Session Management

- [ ] 3.1 Add local private key/session/sender-key storage.
- [ ] 3.2 Add device registration and prekey replenish logic.
- [ ] 3.3 Add remote device and key-bundle lookup logic.
- [ ] 3.4 Add group sender-key storage and maintenance logic.
- [ ] 3.5 Keep private identity/session material scoped to one uid/device_id pair; do not share account-level private keys across Web/App/PC.

## 4. Send And Receive Pipeline

- [ ] 4.1 Wrap `sendWithOptions()` with E2EE encryption for enabled person channels.
- [ ] 4.2 Wrap `sendWithOptions()` with E2EE encryption for enabled group channels.
- [ ] 4.3 Decrypt incoming `MessageSignalContent` before notifying message listeners.
- [ ] 4.4 Handle group sender-key distribution, missing-key request, and retry.
- [ ] 4.5 Keep CMD/system messages plaintext operational messages.
- [ ] 4.6 Block sends when E2EE is required but initialization, key lookup, or channel metadata cannot be resolved.
- [ ] 4.7 Preserve old plaintext history rendering without allowing new plaintext sends in enabled channels.
- [ ] 4.8 Enforce forward-only behavior for newly registered devices.
- [ ] 4.9 Include recipient active devices and sender companion devices in single-chat `signal_multi` envelopes.

## 5. Verification

- [ ] 5.1 Add unit tests for message envelope encode/decode.
- [ ] 5.2 Add tests for single-chat device selection and encrypt/decrypt flow.
- [ ] 5.3 Add tests for group sender-key distribution and missing-key recovery.
- [ ] 5.4 Run SDK build and type declaration generation.
- [ ] 5.5 Verify package publish/pack output.
- [ ] 5.6 Verify `TangSengDaoDaoWeb` can consume the internal package.
