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
