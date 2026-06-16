import * as assert from "assert";
import WKSDK from "../src";
import { Channel, ChannelTypeGroup, Subscriber } from "../src/model";

declare const test: (name: string, fn: () => void | Promise<void>) => void;

function subscriber(uid: string, version: number): Subscriber {
    const item = new Subscriber();
    item.uid = uid;
    item.name = uid;
    item.remark = uid;
    item.role = 0;
    item.version = version;
    item.isDeleted = false;
    item.status = 1;
    item.orgData = {};
    return item;
}

test("channel_manager syncSubscribes uses max cached version when subscribers are not ordered by version", async () => {
    const channel = new Channel(`group-${Date.now()}`, ChannelTypeGroup);
    const manager = WKSDK.shared().channelManager;
    manager.subscribeCacheMap.set(channel.getChannelKey(), [
        subscriber("owner", 20),
        subscriber("member", 10),
    ]);

    let requestedVersion = -1;
    const previousCallback = WKSDK.shared().config.provider.syncSubscribersCallback;
    WKSDK.shared().config.provider.syncSubscribersCallback = async (_channel, version) => {
        requestedVersion = version;
        return [subscriber("new-member", 21)];
    };

    try {
        await manager.syncSubscribes(channel);
    } finally {
        WKSDK.shared().config.provider.syncSubscribersCallback = previousCallback;
        manager.subscribeCacheMap.delete(channel.getChannelKey());
    }

    assert.equal(requestedVersion, 20);
});
