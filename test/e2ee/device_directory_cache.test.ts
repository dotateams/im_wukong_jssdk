import * as assert from "assert";
import { DeviceDirectory } from "../../src/signal/managers/DeviceDirectory";

declare const test: (name: string, fn: () => void | Promise<void>) => void;

function installLocalStorage() {
  const original = (global as any).localStorage;
  const values = new Map<string, string>();
  (global as any).localStorage = {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  return {
    values,
    restore: () => {
      (global as any).localStorage = original;
    },
  };
}

function ok(resp: any) {
  return !resp || resp.code === undefined || resp.code === 0;
}

function data(resp: any) {
  return resp && Object.prototype.hasOwnProperty.call(resp, "data") ? resp.data : resp;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("device directory returns long-lived channel device cache without TTL expiry", async () => {
  let calls = 0;
  const directory = new DeviceDirectory({
    get: async () => {
      calls++;
      return { code: 0, data: [{ uid: "u1", e2e_devices: [{ device_id: "d1" }] }] };
    },
  }, ok, data, { uid: "alice", deviceId: "web-a" });
  (directory as any).channelDevicesVersionCheckIntervalMs = 0;

  const first = await directory.getChanelSubscribersDevices("group1", 2);
  const second = await directory.getChanelSubscribersDevices("group1", 2);

  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(second[0].devices, [{ device_id: "d1" }]);
});

test("device directory persists channel device cache by account device and channel", async () => {
  const storage = installLocalStorage();
  try {
    const firstDirectory = new DeviceDirectory({
      get: async () => ({ code: 0, data: [{ uid: "u1", devices: [{ device_id: "d1" }] }] }),
    }, ok, data, { uid: "alice", deviceId: "web-a" });

    await firstDirectory.getChanelSubscribersDevices("group1", 2);

    let calls = 0;
    const secondDirectory = new DeviceDirectory({
      get: async () => {
        calls++;
        return { code: 0, data: [{ uid: "u1", devices: [{ device_id: "d2" }] }] };
      },
    }, ok, data, { uid: "alice", deviceId: "web-a" });

    const cached = await secondDirectory.getChanelSubscribersDevices("group1", 2);

    assert.equal(calls, 0);
    assert.deepEqual(cached[0].devices, [{ device_id: "d1" }]);
  } finally {
    storage.restore();
  }
});

test("device directory returns stale cache immediately and refreshes channel devices in background", async () => {
  const refresh = deferred<any>();
  let fullCalls = 0;
  let versionCalls = 0;
  const directory = new DeviceDirectory({
    get: async (url: string) => {
      if (url.indexOf("/version") >= 0) {
        versionCalls++;
        return { code: 0, data: { member_version: 2, devices_version: 2 } };
      }
      fullCalls++;
      if (fullCalls === 1) {
        return { code: 0, data: { member_version: 1, devices_version: 1, devices: [{ uid: "u1", devices: [{ device_id: "old" }] }] } };
      }
      return refresh.promise;
    },
  }, ok, data, { uid: "alice", deviceId: "web-a" });
  (directory as any).channelDevicesVersionCheckIntervalMs = 0;

  await directory.getChanelSubscribersDevices("group1", 2);
  const cached = await directory.getChanelSubscribersDevices("group1", 2);

  assert.equal(fullCalls, 1);
  assert.equal(versionCalls, 0);
  assert.deepEqual(cached[0].devices, [{ device_id: "old" }]);

  const refreshPromise = directory.getChannelDevicesRefreshPromise("group1", 2);
  refresh.resolve({ code: 0, data: { member_version: 2, devices_version: 2, devices: [{ uid: "u1", devices: [{ device_id: "new" }] }] } });
  await refreshPromise;
  assert.equal(versionCalls, 1);
  assert.equal(fullCalls, 2);

  const fresh = await directory.getChanelSubscribersDevices("group1", 2);
  assert.deepEqual(fresh[0].devices, [{ device_id: "new" }]);
});

test("device directory deduplicates same-channel refresh requests", async () => {
  const request = deferred<any>();
  let calls = 0;
  const directory = new DeviceDirectory({
    get: async () => {
      calls++;
      return request.promise;
    },
  }, ok, data, { uid: "alice", deviceId: "web-a" });
  (directory as any).channelDevicesVersionCheckIntervalMs = 0;

  const a = directory.getChanelSubscribersDevices("group1", 2, true);
  const b = directory.getChanelSubscribersDevices("group1", 2, true);

  assert.equal(calls, 1);
  request.resolve({ code: 0, data: [{ uid: "u1", devices: [{ device_id: "d1" }] }] });

  const result = await Promise.all([a, b]);
  assert.deepEqual(result[0], result[1]);
});

test("device directory keeps cached devices when background version is unchanged", async () => {
  let fullCalls = 0;
  let versionCalls = 0;
  const directory = new DeviceDirectory({
    get: async (url: string) => {
      if (url.indexOf("/version") >= 0) {
        versionCalls++;
        return { code: 0, data: { member_version: 1, devices_version: 1 } };
      }
      fullCalls++;
      return { code: 0, data: { member_version: 1, devices_version: 1, devices: [{ uid: "u1", devices: [{ device_id: "d1" }] }] } };
    },
  }, ok, data, { uid: "alice", deviceId: "web-a" });
  (directory as any).channelDevicesVersionCheckIntervalMs = 0;

  await directory.getChanelSubscribersDevices("group1", 2);
  await directory.getChanelSubscribersDevices("group1", 2);
  await directory.getChannelDevicesRefreshPromise("group1", 2);

  assert.equal(versionCalls, 1);
  assert.equal(fullCalls, 1);
});

test("device directory invalidates memory persistent cache and in-flight channel refresh", async () => {
  const storage = installLocalStorage();
  try {
    const request = deferred<any>();
    let calls = 0;
    const directory = new DeviceDirectory({
      get: async () => {
        calls++;
        if (calls === 1) {
          return { code: 0, data: [{ uid: "u1", devices: [{ device_id: "old" }] }] };
        }
        return request.promise;
      },
    }, ok, data, { uid: "alice", deviceId: "web-a" });

    await directory.getChanelSubscribersDevices("group1", 2);
    const inflight = directory.getChanelSubscribersDevices("group1", 2, true);
    directory.invalidateChannelDevicesCache("group1", 2);
    request.resolve({ code: 0, data: [{ uid: "u1", devices: [{ device_id: "ignored" }] }] });
    await inflight;

    const next = await directory.getChanelSubscribersDevices("group1", 2);

    assert.equal(calls, 3);
    assert.deepEqual(next[0].devices, [{ device_id: "ignored" }]);
  } finally {
    storage.restore();
  }
});

test("awaitFreshness synchronously picks up a newly registered device on cache hit when version changed", async () => {
  let fullCalls = 0;
  let versionCalls = 0;
  const directory = new DeviceDirectory({
    get: async (url: string) => {
      if (url.indexOf("/version") >= 0) {
        versionCalls++;
        return { code: 0, data: { member_version: 1, devices_version: 2 } };
      }
      fullCalls++;
      if (fullCalls === 1) {
        return { code: 0, data: { member_version: 1, devices_version: 1, devices: [{ uid: "u1", devices: [{ device_id: "old", identity_key: "ik-old" }] }] } };
      }
      return { code: 0, data: { member_version: 1, devices_version: 2, devices: [{ uid: "u1", devices: [{ device_id: "old", identity_key: "ik-old" }, { device_id: "new", identity_key: "ik-new" }] }] } };
    },
  }, ok, data, { uid: "alice", deviceId: "web-a" });
  (directory as any).channelDevicesVersionCheckIntervalMs = 0;

  const first = await directory.getChanelSubscribersDevices("group1", 2);
  assert.deepEqual(first[0].devices.map((d: any) => d.device_id), ["old"]);

  const fresh = await directory.getChanelSubscribersDevices("group1", 2, false, { awaitFreshness: true });
  assert.equal(versionCalls, 1);
  assert.equal(fullCalls, 2);
  assert.deepEqual(fresh[0].devices.map((d: any) => d.device_id), ["old", "new"]);
});

test("awaitFreshness returns cached devices without full refetch when version unchanged", async () => {
  let fullCalls = 0;
  let versionCalls = 0;
  const directory = new DeviceDirectory({
    get: async (url: string) => {
      if (url.indexOf("/version") >= 0) {
        versionCalls++;
        return { code: 0, data: { member_version: 1, devices_version: 1 } };
      }
      fullCalls++;
      return { code: 0, data: { member_version: 1, devices_version: 1, devices: [{ uid: "u1", devices: [{ device_id: "d1" }] }] } };
    },
  }, ok, data, { uid: "alice", deviceId: "web-a" });
  (directory as any).channelDevicesVersionCheckIntervalMs = 0;

  await directory.getChanelSubscribersDevices("group1", 2);
  const fresh = await directory.getChanelSubscribersDevices("group1", 2, false, { awaitFreshness: true });

  assert.equal(versionCalls, 1);
  assert.equal(fullCalls, 1);
  assert.deepEqual(fresh[0].devices, [{ device_id: "d1" }]);
});

test("awaitFreshness throttles repeated channel device version checks until invalidated", async () => {
  let fullCalls = 0;
  let versionCalls = 0;
  const directory = new DeviceDirectory({
    get: async (url: string) => {
      if (url.indexOf("/version") >= 0) {
        versionCalls++;
        return { code: 0, data: { member_version: 1, devices_version: 1 } };
      }
      fullCalls++;
      return { code: 0, data: { member_version: 1, devices_version: 1, devices: [{ uid: "u1", devices: [{ device_id: `d${fullCalls}` }] }] } };
    },
  }, ok, data, { uid: "alice", deviceId: "web-a" });

  await directory.getChanelSubscribersDevices("group1", 2);
  await directory.getChanelSubscribersDevices("group1", 2, false, { awaitFreshness: true });
  await directory.getChanelSubscribersDevices("group1", 2, false, { awaitFreshness: true });
  await directory.getChanelSubscribersDevices("group1", 2, false, { awaitFreshness: true });

  assert.equal(versionCalls, 0);
  assert.equal(fullCalls, 1);

  directory.invalidateChannelDevicesCache("group1", 2);
  const refreshed = await directory.getChanelSubscribersDevices("group1", 2, false, { awaitFreshness: true });

  assert.equal(fullCalls, 2);
  assert.deepEqual(refreshed[0].devices, [{ device_id: "d2" }]);
});

test("awaitFreshness falls back to full device refresh when version probe fails", async () => {
  let fullCalls = 0;
  let versionCalls = 0;
  const directory = new DeviceDirectory({
    get: async (url: string) => {
      if (url.indexOf("/version") >= 0) {
        versionCalls++;
        return { code: 404, msg: "version endpoint unavailable" };
      }
      fullCalls++;
      if (fullCalls === 1) {
        return { code: 0, data: { member_version: 1, devices_version: 1, devices: [{ uid: "u1", devices: [{ device_id: "old" }] }] } };
      }
      return { code: 0, data: { member_version: 1, devices_version: 2, devices: [{ uid: "u1", devices: [{ device_id: "old" }, { device_id: "new" }] }] } };
    },
  }, ok, data, { uid: "alice", deviceId: "web-a" });
  (directory as any).channelDevicesVersionCheckIntervalMs = 0;

  await directory.getChanelSubscribersDevices("group1", 2);
  const fresh = await directory.getChanelSubscribersDevices("group1", 2, false, { awaitFreshness: true });

  assert.equal(versionCalls, 1);
  assert.equal(fullCalls, 2);
  assert.deepEqual(fresh[0].devices.map((device: any) => device.device_id), ["old", "new"]);
});
