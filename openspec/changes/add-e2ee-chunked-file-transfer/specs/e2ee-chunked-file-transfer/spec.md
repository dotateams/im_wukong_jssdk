# E2EE Chunked File Transfer

## ADDED Requirements

### Requirement: Chunked encrypted file manifest

The client SDK MUST represent large encrypted files with a versioned manifest instead of a single encrypted media part.

#### Scenario: New chunked file message

- **GIVEN** a user sends a file in an E2EE channel
- **WHEN** the file is encrypted using chunked transfer
- **THEN** the message payload contains `e2eeMedia.version = 2`
- **AND** the payload includes total size, chunk size, file name, MIME type, total chunk count, and ordered encrypted chunk descriptors
- **AND** each chunk descriptor includes chunk index, encrypted object path, encrypted size, nonce, and ciphertext hash

#### Scenario: Old encrypted file message remains readable

- **GIVEN** an existing E2EE file message with no version or version 1
- **WHEN** a new client opens the message
- **THEN** the client continues to use the existing single-part decrypt path

### Requirement: Client-side chunk encryption

The SDK MUST encrypt file chunks on the client before upload.

#### Scenario: Chunk encryption

- **GIVEN** a plaintext file selected by the user
- **WHEN** the SDK prepares an E2EE file upload
- **THEN** the SDK slices the file into fixed-size chunks
- **AND** encrypts each chunk independently using AES-GCM
- **AND** generates per-chunk integrity metadata before upload

#### Scenario: Server cannot decrypt chunks

- **GIVEN** an encrypted chunk is uploaded
- **WHEN** the server stores the chunk
- **THEN** the server stores only ciphertext and opaque metadata
- **AND** does not receive plaintext chunk keys or plaintext file content

### Requirement: Resumable upload

The system MUST resume interrupted E2EE file uploads without re-uploading completed chunks.

#### Scenario: Resume after page refresh

- **GIVEN** a file upload has completed some chunks
- **AND** the browser page is refreshed
- **WHEN** the user retries the same upload session on the same device
- **THEN** the client queries server-side uploaded chunk state
- **AND** skips chunks already accepted by the server
- **AND** continues from missing chunks

#### Scenario: Duplicate chunk upload

- **GIVEN** a chunk has already been uploaded successfully
- **WHEN** the client uploads the same chunk again
- **THEN** the server treats the operation as idempotent if metadata matches
- **AND** rejects the upload if hash, size, or session metadata conflicts

### Requirement: Chunked download and decrypt

The client MUST download and decrypt chunked E2EE files incrementally.

#### Scenario: Download large encrypted file

- **GIVEN** a user clicks a version 2 E2EE file
- **WHEN** the client downloads the file
- **THEN** chunks are fetched in order or with bounded concurrency
- **AND** each chunk is hash-verified before decrypt
- **AND** decrypted bytes are written incrementally to the target file
- **AND** the full plaintext file is not held in browser memory as a single Blob

#### Scenario: Chunk verification fails

- **GIVEN** a downloaded encrypted chunk hash does not match manifest metadata
- **WHEN** verification fails
- **THEN** the client stops the download
- **AND** reports file integrity failure
- **AND** does not write corrupted plaintext as a successful file

### Requirement: Upload session lifecycle

The server MUST maintain resumable upload session state for E2EE chunked files.

#### Scenario: Create upload session

- **GIVEN** an authenticated user is sending a file to a channel
- **WHEN** the client creates an upload session
- **THEN** the server returns a session id, allowed chunk size, max file size, and uploaded chunk state
- **AND** verifies the user is allowed to send to the channel

#### Scenario: Complete upload session

- **GIVEN** all chunks have been uploaded and verified
- **WHEN** the client completes the upload session
- **THEN** the server marks the session complete
- **AND** returns enough data for the client to send the final E2EE manifest message

#### Scenario: Cleanup abandoned session

- **GIVEN** an upload session is not completed within its TTL
- **WHEN** cleanup runs
- **THEN** the server marks the session expired
- **AND** removes or schedules deletion of orphan encrypted chunk objects

### Requirement: User-facing progress and recovery

The Web client MUST expose clear upload and download progress for chunked E2EE files.

#### Scenario: Upload progress

- **GIVEN** a user sends a large E2EE file
- **WHEN** chunks are uploaded
- **THEN** the file card shows total upload progress based on accepted encrypted chunks
- **AND** failures show retry guidance instead of generic system error

#### Scenario: Download progress

- **GIVEN** a user downloads a large E2EE file
- **WHEN** chunks are downloaded and decrypted
- **THEN** the UI shows download/decrypt progress
- **AND** the UI remains responsive

