import assert from "assert";
import { RecvPacket, SendPacket } from "../src/proto";

function largeAsciiPayload(size: number): Uint8Array {
  const payload = new Uint8Array(size);
  payload.fill("a".charCodeAt(0));
  return payload;
}

test("send packet verification handles large payloads without stack overflow", () => {
  const packet = new SendPacket();
  packet.clientSeq = 1;
  packet.clientMsgNo = "large-send";
  packet.channelID = "large-channel";
  packet.channelType = 2;

  const verification = packet.veritifyString(largeAsciiPayload(256 * 1024));

  assert.ok(verification.startsWith("1large-sendlarge-channel2"));
  assert.ok(verification.endsWith("aaa"));
});

test("recv packet verification handles large payloads without stack overflow", () => {
  const packet = new RecvPacket();
  packet.messageID = "10001";
  packet.messageSeq = 2;
  packet.clientMsgNo = "large-recv";
  packet.timestamp = 3;
  packet.fromUID = "from";
  packet.channelID = "large-channel";
  packet.channelType = 2;
  packet.payload = largeAsciiPayload(256 * 1024);

  assert.ok(packet.veritifyString.startsWith("100012large-recv3fromlarge-channel2"));
  assert.ok(packet.veritifyString.endsWith("aaa"));
});
