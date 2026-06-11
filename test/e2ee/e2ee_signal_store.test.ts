import * as assert from "assert";
import { SignalProtocolStore } from "../../src/signal/storage/SignalProtocolStore";

declare const test: (name: string, fn: () => void | Promise<void>) => void;

test("e2ee_signal_store loads signed prekeys with numeric string aliases", async () => {
    const store: any = new SignalProtocolStore("alice", "web-1");
    const values = new Map<any, any>([[1, { pubKey: "signed-pub" }]]);
    store._get = async (_storeName: string, key: any) => values.get(key);

    const signedPreKey = await store.loadSignedPreKey("1");

    assert.deepEqual(signedPreKey, { pubKey: "signed-pub" });
});

test("e2ee_signal_store loads signed prekeys with protobuf long aliases", async () => {
    const store: any = new SignalProtocolStore("alice", "web-1");
    const values = new Map<any, any>([[1, { pubKey: "signed-pub" }]]);
    store._get = async (_storeName: string, key: any) => values.get(key);

    const signedPreKey = await store.loadSignedPreKey({
        toNumber: () => 1,
        toString: () => "1",
    });

    assert.deepEqual(signedPreKey, { pubKey: "signed-pub" });
});

test("e2ee_signal_store loads prekeys with numeric string aliases", async () => {
    const store: any = new SignalProtocolStore("alice", "web-1");
    const values = new Map<any, any>([[101, { pubKey: "prekey-pub" }]]);
    store._get = async (_storeName: string, key: any) => values.get(key);

    const preKey = await store.loadPreKey("101");

    assert.deepEqual(preKey, { pubKey: "prekey-pub" });
});
