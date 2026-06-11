## ADDED Requirements

### Requirement: E2EE Initialization

The SDK shall expose an E2EE initialization flow that the web app can run after login and before connecting to WuKongIM.

#### Scenario: Initialize current device

- **WHEN** the web app supplies uid, token/API adapter, stable device ID, device name, and platform metadata
- **THEN** the SDK initializes local E2EE storage for that uid/device
- **AND** the SDK registers or refreshes the device public key bundle with WuKongIM

#### Scenario: Initialization fails

- **WHEN** local crypto or key registration fails
- **THEN** the SDK reports an initialization error
- **AND** E2EE-enabled channels do not silently send plaintext user messages

### Requirement: Channel-Based Encryption Gate

The SDK shall encrypt only when channel metadata enables E2EE.

#### Scenario: E2EE disabled channel

- **WHEN** a message is sent to a channel whose `isE2e` is explicitly false
- **THEN** the SDK sends the existing plaintext payload format

#### Scenario: E2EE metadata unknown

- **WHEN** a message is sent and the SDK cannot determine whether the channel is E2EE-enabled
- **THEN** the SDK or host app refreshes channel metadata before sending, using the send-preflight path when required for a new person chat
- **AND** if metadata still cannot be resolved, the SDK blocks the send instead of sending plaintext

#### Scenario: E2EE enabled channel

- **WHEN** a first-stage user-authored message is sent to a person or group channel whose `isE2e` is true
- **THEN** the SDK wraps the encoded original content in `MessageSignalContent`
- **AND** the outgoing message content type is `signalMessage`

#### Scenario: Server uses `is_e2e`

- **WHEN** the host app maps server channel metadata into SDK models
- **THEN** the SDK accepts the normalized value derived from `is_e2e`
- **AND** the SDK treats that value as the E2EE enabled-state gate

### Requirement: Single-Chat Multi-Device Encryption

The SDK shall encrypt person-channel messages for active recipient devices and sender companion devices.

#### Scenario: Send person message

- **WHEN** a first-stage message is sent to an E2EE-enabled person channel
- **THEN** the SDK fetches active recipient devices and key bundles
- **AND** the SDK fetches the sender's other active sync devices when available
- **AND** the SDK creates a single `signal_multi` envelope containing per-device ciphertexts
- **AND** the chat message is still sent as one WuKongIM message
- **AND** the plaintext original content is not sent to WuKongIM

### Requirement: Per-Device Key Isolation

The SDK shall use independent E2EE key material per logged-in device.

#### Scenario: Device registers keys

- **WHEN** a Web, App, or PC device initializes E2EE
- **THEN** the device generates or loads key material scoped to its own `uid` and `device_id`
- **AND** the SDK does not reuse a shared account-level private key across devices

#### Scenario: Device is removed or becomes non-capable

- **WHEN** a device is removed, disabled, or no longer considered active by the server
- **THEN** future device lookups omit that device
- **AND** new person-message envelopes and group sender-key distributions do not target it

### Requirement: Group Sender-Key Encryption

The SDK shall encrypt group-channel messages with sender keys.

#### Scenario: Send group message

- **WHEN** a first-stage message is sent to an E2EE-enabled group channel
- **THEN** the SDK encrypts it into a `signal_group` envelope using the sender key for that group/sender device
- **AND** the plaintext original content is not sent to WuKongIM

#### Scenario: New group key needed

- **WHEN** a sender key is missing or group membership changed
- **THEN** the SDK distributes the required sender key material to active member devices using CMD messages

### Requirement: Decrypt Before Notify

The SDK shall decrypt supported E2EE messages before application listeners receive them.

#### Scenario: Receive decryptable signal message

- **WHEN** a `MessageSignalContent` can be decrypted
- **THEN** the SDK replaces it with the decoded original message content
- **AND** message listeners receive the original content type

#### Scenario: Missing sender key

- **WHEN** a group message cannot be decrypted because sender-key material is missing
- **THEN** the SDK exposes a recoverable encrypted-message failure state
- **AND** the SDK sends a bounded missing-key request

### Requirement: Existing History Migration Compatibility

The SDK shall support mixed historical channels during production migration.

#### Scenario: Receive plaintext history in enabled channel

- **WHEN** a channel is E2EE-enabled and the SDK receives an older plaintext message from before activation
- **THEN** the SDK renders the original plaintext message normally
- **AND** this compatibility does not allow new plaintext sends for that enabled channel

#### Scenario: New device sees old E2EE message

- **WHEN** a newly registered device receives or syncs an E2EE message sent before that device had session or sender-key material
- **THEN** the SDK may show the encrypted-message fallback
- **AND** the SDK does not request historical private sessions or sender keys to decrypt that old message

### Requirement: Internal Package Release

The SDK shall be publishable as an internal package consumed by TangSengDaoDaoWeb.

#### Scenario: Build internal package

- **WHEN** the SDK release build runs
- **THEN** it produces package artifacts for the internal package registry or package alias
- **AND** the artifact preserves import compatibility for `wukongimjssdk`

#### Scenario: Avoid public package resolution

- **WHEN** TangSengDaoDaoWeb installs dependencies
- **THEN** package resolution points to the internal E2EE SDK artifact
- **AND** it does not resolve to the public `wukongimjssdk@1.2.11`

### Requirement: First-Stage File Exclusion

The SDK shall not enable file/media E2EE in the first stage.

#### Scenario: Send file or media message

- **WHEN** a file/media message is sent in first-stage rollout
- **THEN** the SDK uses the existing upload/send behavior
- **AND** no incomplete file E2EE path is enabled by default
