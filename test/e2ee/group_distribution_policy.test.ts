import assert from "assert";
import { GroupManager } from "../../src/signal/managers/GroupManager";

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

test("concurrent failed sender-key envelope upload waiters do not throw", async () => {
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
    await Promise.all([
      manager.uploadDistributionEnvelopes("g1", distribution),
      manager.uploadDistributionEnvelopes("g1", distribution),
    ]);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(uploadCount, 1);
});
