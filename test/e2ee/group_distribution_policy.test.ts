import assert from "assert";
import { GroupManager } from "../../src/signal/managers/GroupManager";
import { SenderKeyRecord } from "../../src/signal/models/SenderKeyRecord";
import { SenderKeyState } from "../../src/signal/models/SenderKeyState";

test("group distribution is only retried for the first sender-key message", () => {
  const manager = new GroupManager({}, "sender", "device") as any;
  const record = {
    getState: () => ({ keyId: 7 }),
  };

  assert.equal(manager.shouldRetrySenderKeyDistribution(record, { key_id: 7, msg_index: 0 }), true);
  assert.equal(manager.shouldRetrySenderKeyDistribution(record, { key_id: 7, msg_index: 1 }), false);
  assert.equal(manager.shouldRetrySenderKeyDistribution(record, { key_id: 7, msg_index: 20 }), false);
});

test("concurrent duplicate sender-key envelope uploads are coalesced", async () => {
  let uploadCount = 0;
  const parent = {
    uploadGroupSenderKeyEnvelopes: async () => {
      uploadCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  };
  const manager = new GroupManager(parent, "sender", "device") as any;
  const distribution = {
    key_id: 7,
    member_hash: "members-v1",
    distribution: {
      ciphertexts: [
        { uid: "alice", device_id: "web", enc: "aes-256-gcm", body: "ciphertext" },
      ],
    },
  };

  await Promise.all([
    manager.uploadDistributionEnvelopes("g1", distribution),
    manager.uploadDistributionEnvelopes("g1", distribution),
  ]);

  assert.equal(uploadCount, 1);
});

test("concurrent failed sender-key envelope upload waiters reject without duplicate uploads", async () => {
  let uploadCount = 0;
  const parent = {
    uploadGroupSenderKeyEnvelopes: async () => {
      uploadCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error("temporary overload");
    },
  };
  const manager = new GroupManager(parent, "sender", "device") as any;
  const originalWarn = console.warn;
  console.warn = () => undefined;
  const distribution = {
    key_id: 7,
    member_hash: "members-v1",
    distribution: {
      ciphertexts: [
        { uid: "alice", device_id: "web", enc: "aes-256-gcm", body: "ciphertext" },
      ],
    },
  };

  try {
    await assert.rejects(() => Promise.all([
      manager.uploadDistributionEnvelopes("g1", distribution),
      manager.uploadDistributionEnvelopes("g1", distribution),
    ]), /temporary overload/);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(uploadCount, 1);
});

test("prepared sender-key distribution prevents first message from rebuilding envelopes", async () => {
  const parent = {
    uploadGroupSenderKeyEnvelopes: async () => undefined,
    encryptGroupPayload: async (_messageKey: string, msgIndex: number) => ({
      iv: `iv-${msgIndex}`,
      body: `body-${msgIndex}`,
      mac: `mac-${msgIndex}`,
      tag: `tag-${msgIndex}`,
      enc: "aes-256-gcm",
    }),
    signGroupPayload: async () => "signature",
  };
  const manager = new GroupManager(parent, "sender", "device") as any;
  manager.senderKeyDistributionRetryWindow = 1;
  manager.senderKeyDistributionInterval = 0;

  const members = [{ uid: "alice", devices: [{ device_id: "web" }] }];
  const memberHash = manager.calculateMemberUidHashFromMembers(members);
  const record = new SenderKeyRecord({
    memberHash,
    states: [
      new SenderKeyState({
        keyId: 7,
        senderKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        chainKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        signingPubKey: "pub",
        signingPrivKey: "priv",
        messageIndex: 0,
        skipped: {},
        kdfVersion: "v2",
      }),
    ],
  });
  let buildCount = 0;
  manager.loadSenderKeyRecord = async () => record;
  manager.saveSenderKeyRecord = async () => undefined;
  manager.createSenderKeyRecord = async () => record;
  manager.uploadPendingRepairEnvelopes = async () => 0;
  manager.buildDistributionPayloadForRecord = async () => {
    buildCount += 1;
    return {
      key_id: 7,
      member_hash: memberHash,
      distribution: {
        type: "signal_multi",
        ciphertexts: [{ uid: "alice", device_id: "web", enc: "aes-256-gcm", body: "ciphertext" }],
      },
    };
  };

  await manager.prepareGroupSend("g1", members, memberHash);
  await manager.encryptGroupMessage("g1", "hello", members, memberHash);

  assert.equal(buildCount, 1);
});

test("prepared sender-key marker skips retry-window distribution build", async () => {
  const parent = {
    uploadGroupSenderKeyEnvelopes: async () => undefined,
    encryptGroupPayload: async (_messageKey: string, msgIndex: number) => ({
      iv: `iv-${msgIndex}`,
      body: `body-${msgIndex}`,
      mac: `mac-${msgIndex}`,
      tag: `tag-${msgIndex}`,
      enc: "aes-256-gcm",
    }),
    signGroupPayload: async () => "signature",
  };
  const manager = new GroupManager(parent, "sender", "device") as any;
  manager.senderKeyDistributionRetryWindow = 1;
  manager.senderKeyDistributionInterval = 0;

  const members = [{ uid: "alice", devices: [{ device_id: "web" }] }];
  const memberHash = manager.calculateMemberUidHashFromMembers(members);
  const record = new SenderKeyRecord({
    memberHash,
    states: [
      new SenderKeyState({
        keyId: 7,
        senderKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        chainKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        signingPubKey: "pub",
        signingPrivKey: "priv",
        messageIndex: 0,
        skipped: {},
        kdfVersion: "v2",
      }),
    ],
  });
  let buildCount = 0;
  manager.loadSenderKeyRecord = async () => record;
  manager.saveSenderKeyRecord = async () => undefined;
  manager.uploadPendingRepairEnvelopes = async () => 0;
  manager.buildDistributionPayloadForRecord = async () => {
    buildCount += 1;
    return {
      key_id: 7,
      member_hash: memberHash,
      distribution: {
        type: "signal_multi",
        ciphertexts: [{ uid: "alice", device_id: "web", enc: "aes-256-gcm", body: "ciphertext" }],
      },
    };
  };

  manager.markSenderKeyDistributionPrepared("g1", record, members, memberHash);
  await manager.encryptGroupMessage("g1", "hello", members, memberHash);

  assert.equal(buildCount, 0);
});

test("prepared sender-key marker skips retry-window rebuild when device set shape changes", async () => {
  const parent = {
    uploadGroupSenderKeyEnvelopes: async () => undefined,
    encryptGroupPayload: async (_messageKey: string, msgIndex: number) => ({
      iv: `iv-${msgIndex}`,
      body: `body-${msgIndex}`,
      mac: `mac-${msgIndex}`,
      tag: `tag-${msgIndex}`,
      enc: "aes-256-gcm",
    }),
    signGroupPayload: async () => "signature",
  };
  const manager = new GroupManager(parent, "sender", "device") as any;
  manager.senderKeyDistributionRetryWindow = 1;
  manager.senderKeyDistributionInterval = 0;

  const preparedMembers = [{ uid: "alice", devices: [{ device_id: "web" }] }];
  const memberHash = manager.calculateMemberUidHashFromMembers(preparedMembers);
  const record = new SenderKeyRecord({
    memberHash,
    states: [
      new SenderKeyState({
        keyId: 7,
        senderKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        chainKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        signingPubKey: "pub",
        signingPrivKey: "priv",
        messageIndex: 0,
        skipped: {},
        kdfVersion: "v2",
      }),
    ],
  });
  const sendMembers = [{ uid: "alice", devices: [{ device_id: "web" }, { device_id: "app" }] }];
  let buildCount = 0;
  manager.loadSenderKeyRecord = async () => record;
  manager.saveSenderKeyRecord = async () => undefined;
  manager.uploadPendingRepairEnvelopes = async () => 0;
  manager.buildDistributionPayloadForRecord = async () => {
    buildCount += 1;
    return {
      key_id: 7,
      member_hash: memberHash,
      distribution: {
        type: "signal_multi",
        ciphertexts: [{ uid: "alice", device_id: "web", enc: "aes-256-gcm", body: "ciphertext" }],
      },
    };
  };

  manager.markSenderKeyDistributionPrepared("g1", record, preparedMembers, memberHash);
  await manager.encryptGroupMessage("g1", "hello", sendMembers, memberHash);

  assert.equal(buildCount, 0);
});

test("prepared sender-key marker keeps a long enough ttl for slow prewarm", () => {
  const manager = new GroupManager({}, "sender", "device") as any;
  const cache = manager.getSenderKeyDistributionPreparedCache();
  assert.equal((cache as any).ttlMs >= 5 * 60 * 1000, true);
});

test("device-only member changes do not rotate sender key", async () => {
  const parent = {
    uploadGroupSenderKeyEnvelopes: async () => undefined,
    encryptGroupPayload: async (_messageKey: string, msgIndex: number) => ({
      iv: `iv-${msgIndex}`,
      body: `body-${msgIndex}`,
      mac: `mac-${msgIndex}`,
      tag: `tag-${msgIndex}`,
      enc: "aes-256-gcm",
    }),
    signGroupPayload: async () => "signature",
  };
  const manager = new GroupManager(parent, "sender", "device") as any;
  manager.senderKeyDistributionRetryWindow = 0;
  manager.senderKeyDistributionInterval = 0;

  const originalMembers = [{ uid: "alice", devices: [{ device_id: "web" }] }];
  const record = new SenderKeyRecord({
    memberHash: manager.calculateMemberUidHashFromMembers(originalMembers),
    states: [
      new SenderKeyState({
        keyId: 7,
        senderKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        chainKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        signingPubKey: "pub",
        signingPrivKey: "priv",
        messageIndex: 1,
        skipped: {},
        kdfVersion: "v2",
      }),
    ],
  });
  const changedDevices = [{ uid: "alice", devices: [{ device_id: "web" }, { device_id: "app" }] }];
  let createCount = 0;
  let buildCount = 0;
  manager.loadSenderKeyRecord = async () => record;
  manager.saveSenderKeyRecord = async () => undefined;
  manager.createSenderKeyRecord = async () => {
    createCount += 1;
    return record;
  };
  manager.uploadPendingRepairEnvelopes = async () => 0;
  manager.buildDistributionPayloadForRecord = async () => {
    buildCount += 1;
    return {
      key_id: 7,
      member_hash: record.memberHash,
      distribution: {
        type: "signal_multi",
        ciphertexts: [{ uid: "alice", device_id: "app", enc: "aes-256-gcm", body: "ciphertext" }],
      },
    };
  };

  await manager.encryptGroupMessage("g1", "hello", changedDevices, "device-hash-changed");

  assert.equal(createCount, 0);
  assert.equal(buildCount, 0);
});

test("user member changes rotate sender key", async () => {
  const parent = {
    uploadGroupSenderKeyEnvelopes: async () => undefined,
    encryptGroupPayload: async (_messageKey: string, msgIndex: number) => ({
      iv: `iv-${msgIndex}`,
      body: `body-${msgIndex}`,
      mac: `mac-${msgIndex}`,
      tag: `tag-${msgIndex}`,
      enc: "aes-256-gcm",
    }),
    signGroupPayload: async () => "signature",
  };
  const manager = new GroupManager(parent, "sender", "device") as any;
  const originalMembers = [{ uid: "alice", devices: [{ device_id: "web" }] }];
  const record = new SenderKeyRecord({
    memberHash: manager.calculateMemberUidHashFromMembers(originalMembers),
    states: [
      new SenderKeyState({
        keyId: 7,
        senderKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        chainKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        signingPubKey: "pub",
        signingPrivKey: "priv",
        messageIndex: 1,
        skipped: {},
        kdfVersion: "v2",
      }),
    ],
  });
  const rotatedRecord = new SenderKeyRecord({
    memberHash: "",
    states: [
      new SenderKeyState({
        keyId: 8,
        senderKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
        chainKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
        signingPubKey: "pub2",
        signingPrivKey: "priv2",
        messageIndex: 0,
        skipped: {},
        kdfVersion: "v2",
      }),
    ],
  });
  const changedUsers = [
    { uid: "alice", devices: [{ device_id: "web" }] },
    { uid: "bob", devices: [{ device_id: "web" }] },
  ];
  let createCount = 0;
  manager.loadSenderKeyRecord = async () => record;
  manager.saveSenderKeyRecord = async () => undefined;
  manager.createSenderKeyRecord = async (_groupId: string, memberHash: string) => {
    createCount += 1;
    rotatedRecord.memberHash = memberHash;
    return rotatedRecord;
  };
  manager.uploadPendingRepairEnvelopes = async () => 0;
  manager.buildDistributionPayloadForRecord = async () => ({
    key_id: 8,
    member_hash: rotatedRecord.memberHash,
    distribution: { type: "signal_multi", ciphertexts: [] },
  });

  await manager.encryptGroupMessage("g1", "hello", changedUsers, "device-hash-changed");

  assert.equal(createCount, 1);
});

test("explicit group distribution upload returns compact payload without inline envelopes", async () => {
  let uploaded: any = null;
  const parent = {
    encryptGroupDistributionForDevice: async (uid: string, plain: string, devices: string[]) => {
      const targetDevices = Array.isArray(devices) && devices.length > 0 ? devices : ["web"];
      return targetDevices.map((deviceId) => ({
        uid,
        device_id: deviceId,
        enc: "aes-256-gcm",
        body: `encrypted:${plain}:${deviceId}`,
      }));
    },
    uploadGroupSenderKeyEnvelopes: async (payload: any) => {
      uploaded = payload;
    },
  };
  const manager = new GroupManager(parent, "sender", "device") as any;
  const record = {
    getState: () => ({
      keyId: 7,
      senderKey: "sender-key",
      signingPubKey: "signing-key",
      kdfVersion: "v2",
    }),
  };
  manager.loadSenderKeyRecord = async () => record;
  manager.createSenderKeyRecord = async () => record;
  manager.saveSenderKeyRecord = async () => undefined;
  manager.normalizeMemberHash = () => "members-v1";

  const encrypted = await manager.encryptGroupDistribution(
    "g1",
    [{ uid: "alice", devices: ["web", "app"] }],
    "members-v1",
    true,
  );
  const body = JSON.parse(encrypted.body);

  assert.equal(body.type, "signal_group_distribution");
  assert.equal(body.distribution, undefined);
  assert.equal(uploaded.version, 2);
  assert.equal(uploaded.envelopes, undefined);
  assert.equal(uploaded.items.length, 2);
  assert.deepEqual(uploaded.items.map((item: any[]) => item.slice(0, 2)), [
    ["alice", "web"],
    ["alice", "app"],
  ]);
  const firstEnvelope = JSON.parse(uploaded.items[0][2]);
  assert.equal(firstEnvelope.uid, "alice");
  assert.equal(firstEnvelope.device_id, "web");
  assert.equal(firstEnvelope.enc, "aes-256-gcm");
  assert.equal(firstEnvelope.is_ecies, true);
});

test("sender-key envelope upload keeps all recipients in one compact bundle", async () => {
  const uploads: any[] = [];
  const parent = {
    uploadGroupSenderKeyEnvelopes: async (payload: any) => {
      uploads.push(payload);
    },
  };
  const manager = new GroupManager(parent, "sender", "device") as any;
  const ciphertexts = Array.from({ length: 250 }, (_, index) => ({
    uid: `user-${index}`,
    device_id: `device-${index}`,
    enc: "aes-256-gcm",
    body: `ciphertext-${index}`,
  }));

  await manager.uploadDistributionEnvelopes("g1", {
    key_id: 11,
    member_hash: "members-v1",
    distribution: { ciphertexts },
  });

  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].items.length, 250);
  assert.ok(uploads.every((item) => item.version === 2));
  assert.ok(uploads.every((item) => item.envelopes === undefined));

  const compactSize = JSON.stringify(uploads[0]).length;
  const legacySize = JSON.stringify({
    group_id: "g1",
    sender_uid: "sender",
    sender_device_id: "device",
    key_id: 11,
    envelopes: ciphertexts.map((item) => ({
      recipient_uid: item.uid,
      recipient_device_id: item.device_id,
      envelope: JSON.stringify({ ...item, is_ecies: true }),
    })),
  }).length;
  assert.ok(compactSize < legacySize * 0.75, `compact=${compactSize} legacy=${legacySize}`);
});

test("large sender-key envelope upload stages bounded parts before one commit", async () => {
  const parts: any[] = [];
  const commits: any[] = [];
  let legacyUploads = 0;
  let active = 0;
  let maxActive = 0;
  const parent = {
    generateUUID: () => "1234567890123456",
    uploadGroupSenderKeyEnvelopes: async () => {
      legacyUploads += 1;
    },
    uploadGroupSenderKeyEnvelopePart: async (payload: any) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 3));
      parts.push(payload);
      active -= 1;
      return { completed: false };
    },
    commitGroupSenderKeyEnvelopeUpload: async (payload: any) => {
      assert.equal(active, 0);
      assert.equal(parts.length, 13);
      commits.push(payload);
      return { completed: true };
    },
  };
  const manager = new GroupManager(parent, "sender", "device") as any;
  manager.senderKeyEnvelopeUploadBatchSize = 100;
  manager.senderKeyEnvelopeUploadConcurrency = 3;
  manager.senderKeyEnvelopeUploadMaxAttempts = 1;
  const ciphertexts = Array.from({ length: 1201 }, (_, index) => ({
    uid: `user-${index}`,
    device_id: `device-${index}`,
    body: `ciphertext-${index}`,
  }));

  await manager.uploadDistributionEnvelopes("g1", {
    key_id: 12,
    distribution: { ciphertexts },
  });

  assert.equal(legacyUploads, 0);
  assert.equal(commits.length, 1);
  assert.equal(maxActive, 3);
  const ordered = parts.slice().sort((a, b) => a.part_index - b.part_index);
  assert.deepEqual(ordered.map((item) => item.items.length), [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 1]);
  assert.ok(ordered.every((item) => item.version === 3));
  assert.ok(ordered.every((item) => item.part_count === 13 && item.recipient_count === 1201));
  assert.equal(commits[0].upload_id, ordered[0].upload_id);
  assert.equal(commits[0].part_count, 13);
  assert.equal(commits[0].recipient_count, 1201);
});

test("multipart sender-key upload falls back once when the first part endpoint is unsupported", async () => {
  const legacyUploads: any[] = [];
  let partCalls = 0;
  let commitCalls = 0;
  const parent = {
    uploadGroupSenderKeyEnvelopes: async (payload: any) => legacyUploads.push(payload),
    uploadGroupSenderKeyEnvelopePart: async () => {
      partCalls += 1;
      const error: any = new Error("404 not found");
      error.status = 404;
      throw error;
    },
    commitGroupSenderKeyEnvelopeUpload: async () => {
      commitCalls += 1;
    },
  };
  const manager = new GroupManager(parent, "sender", "device") as any;
  manager.senderKeyEnvelopeUploadBatchSize = 100;
  manager.senderKeyEnvelopeUploadMaxAttempts = 1;
  const ciphertexts = Array.from({ length: 250 }, (_, index) => ({
    uid: `user-${index}`,
    device_id: `device-${index}`,
    body: `ciphertext-${index}`,
  }));

  await manager.uploadDistributionEnvelopes("g1", {
    key_id: 13,
    distribution: { ciphertexts },
  });

  assert.equal(partCalls, 1);
  assert.equal(commitCalls, 0);
  assert.equal(legacyUploads.length, 1);
  assert.equal(legacyUploads[0].items.length, 250);
});

test("multipart sender-key upload does not use legacy fallback after staging has started", async () => {
  let legacyUploads = 0;
  let commitCalls = 0;
  const parent = {
    uploadGroupSenderKeyEnvelopes: async () => {
      legacyUploads += 1;
    },
    uploadGroupSenderKeyEnvelopePart: async (payload: any) => {
      if (payload.part_index === 1) {
        const error: any = new Error("temporary 503");
        error.status = 503;
        throw error;
      }
    },
    commitGroupSenderKeyEnvelopeUpload: async () => {
      commitCalls += 1;
    },
  };
  const manager = new GroupManager(parent, "sender", "device") as any;
  manager.senderKeyEnvelopeUploadBatchSize = 100;
  manager.senderKeyEnvelopeUploadConcurrency = 2;
  manager.senderKeyEnvelopeUploadMaxAttempts = 1;
  const ciphertexts = Array.from({ length: 201 }, (_, index) => ({
    uid: `user-${index}`,
    device_id: `device-${index}`,
    body: `ciphertext-${index}`,
  }));
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await assert.rejects(() => manager.uploadDistributionEnvelopes("g1", {
      key_id: 14,
      distribution: { ciphertexts },
    }), /temporary 503/);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(legacyUploads, 0);
  assert.equal(commitCalls, 0);
});

test("multipart sender-key upload does not fallback on a textual business error", async () => {
  const legacyUploads: any[] = [];
  const parent = {
    uploadGroupSenderKeyEnvelopes: async (payload: any) => legacyUploads.push(payload),
    uploadGroupSenderKeyEnvelopePart: async () => {
      throw new Error("group not found");
    },
    commitGroupSenderKeyEnvelopeUpload: async () => {},
  };
  const manager = new GroupManager(parent, "sender", "device") as any;
  manager.senderKeyEnvelopeUploadBatchSize = 100;
  manager.senderKeyEnvelopeUploadMaxAttempts = 1;
  const ciphertexts = Array.from({ length: 250 }, (_, index) => ({
    uid: `user-${index}`,
    device_id: `device-${index}`,
    body: `ciphertext-${index}`,
  }));

  await assert.rejects(
    () => manager.uploadDistributionEnvelopes("group-1", { key_id: 9, distribution: { ciphertexts } }),
    /group not found/,
  );
  assert.equal(legacyUploads.length, 0);
});
