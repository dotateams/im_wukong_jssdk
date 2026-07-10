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

test("sender-key envelope upload uses compact batches", async () => {
  const uploads: any[] = [];
  const parent = {
    uploadGroupSenderKeyEnvelopes: async (payload: any) => {
      uploads.push(payload);
    },
  };
  const manager = new GroupManager(parent, "sender", "device") as any;
  manager.senderKeyEnvelopeUploadBatchSize = 100;
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

  assert.equal(uploads.length, 3);
  assert.deepEqual(uploads.map((item) => item.items.length), [100, 100, 50]);
  assert.ok(uploads.every((item) => item.version === 2));
  assert.ok(uploads.every((item) => item.envelopes === undefined));

  const compactSize = JSON.stringify(uploads[0]).length;
  const legacySize = JSON.stringify({
    group_id: "g1",
    sender_uid: "sender",
    sender_device_id: "device",
    key_id: 11,
    envelopes: ciphertexts.slice(0, 100).map((item) => ({
      recipient_uid: item.uid,
      recipient_device_id: item.device_id,
      envelope: JSON.stringify({ ...item, is_ecies: true }),
    })),
  }).length;
  assert.ok(compactSize < legacySize * 0.75, `compact=${compactSize} legacy=${legacySize}`);
});
