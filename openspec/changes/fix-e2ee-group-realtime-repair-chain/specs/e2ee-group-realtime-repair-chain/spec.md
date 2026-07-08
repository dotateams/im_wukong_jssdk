# Capability: e2ee-group-realtime-repair-chain

## ADDED Requirements

### Requirement: Recoverable realtime group decrypt failures

SDK MUST treat realtime group decrypt failures caused by missing sender key state as recoverable until a bounded retry policy is exhausted.

#### Scenario: Missing sender key on new realtime group message

- **WHEN** a new `signal_group` message fails with `Missing sender key`
- **THEN** SDK MUST enqueue the message for pending decryption
- **AND** SDK MUST force lookup the sender key envelope for the current device
- **AND** SDK MUST NOT immediately classify the message as historical unrecoverable.

#### Scenario: Envelope lookup succeeds after failure

- **WHEN** envelope lookup returns a valid envelope for the current device
- **THEN** SDK MUST decrypt the envelope
- **AND** persist the sender key record
- **AND** retry queued messages for the same recovery key in receive order.

#### Scenario: Envelope lookup is not ready

- **WHEN** envelope lookup returns 404 or another configured recoverable not-ready error
- **THEN** SDK MUST submit a repair request
- **AND** keep queued realtime messages until TTL or retry limit is exhausted.

### Requirement: Bounded pending decrypt queue

SDK MUST bound pending decrypt memory and network retries.

#### Scenario: Duplicate failures for same sender key

- **WHEN** multiple messages fail for the same `group_id + sender_uid + sender_device_id + key_id + recipient_device_id`
- **THEN** SDK MUST reuse one in-flight recovery promise
- **AND** MUST NOT issue parallel envelope lookup storms.

#### Scenario: Queue exceeds limits

- **WHEN** a per-group or global queue limit is exceeded
- **THEN** SDK MUST drop or fail the oldest pending items deterministically
- **AND** MUST log enough context for diagnosis.

### Requirement: Sender-side repair processing

SDK MUST process pending repair requests without requiring a manual page refresh.

#### Scenario: Sender receives redistribute request

- **WHEN** SDK receives `e2ee_redistribute_request`
- **THEN** SDK MUST invalidate repair pending dedupe for that group and sender device
- **AND** query pending repair requests
- **AND** upload envelopes only for the requested recipient devices.

#### Scenario: Sender sends while pending repair exists

- **WHEN** sender prepares to send a group E2EE message
- **THEN** SDK SHOULD process a bounded batch of pending repair requests
- **AND** MUST continue remaining work asynchronously when the batch exceeds the send-path budget.

