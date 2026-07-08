import assert from "assert";
import { Message, CMDContent } from "../src/model";
import { RecvPacket, Setting } from "../src/proto";

function utf8Bytes(value: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value);
  }
  const encoded = unescape(encodeURIComponent(value));
  const bytes = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i += 1) {
    bytes[i] = encoded.charCodeAt(i);
  }
  return bytes;
}

test("message decodes large command payloads without stack overflow", () => {
  const packet = new RecvPacket();
  packet.reddot = false;
  packet.dup = false;
  packet.noPersist = false;
  packet.syncOnce = false;
  packet.setting = new Setting();
  packet.messageID = "large-cmd";
  packet.messageSeq = 1;
  packet.clientMsgNo = "large-cmd-client";
  packet.fromUID = "system";
  packet.channelID = "____system____cmd";
  packet.channelType = 1;
  packet.timestamp = 1;
  packet.payload = utf8Bytes(JSON.stringify({
    type: 99,
    cmd: "onlineStatus",
    param: {
      uid: "friend-1",
      online: 1,
      padding: "x".repeat(256 * 1024),
    },
  }));

  const message = new Message(packet);
  assert.equal(message.contentType, 99);
  assert.ok(message.content instanceof CMDContent);
  assert.equal((message.content as CMDContent).cmd, "onlineStatus");
  assert.equal((message.content as CMDContent).param.uid, "friend-1");
});
