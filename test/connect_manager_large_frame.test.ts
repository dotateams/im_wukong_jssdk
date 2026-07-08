import assert from "assert";
import { ConnectManager } from "../src/connect_manager";

test("connect manager appends large websocket frames without stack overflow", () => {
  const manager: any = new ConnectManager();
  const bodyLength = 512 * 1024;
  const receivedBodyLength = 256 * 1024;
  const lengthBytes: number[] = [];
  let value = bodyLength;
  do {
    let digit = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) {
      digit |= 0x80;
    }
    lengthBytes.push(digit);
  } while (value > 0);
  const largeFrame = new Uint8Array(1 + lengthBytes.length + receivedBodyLength);
  largeFrame[0] = 0x30;
  largeFrame.set(lengthBytes, 1);
  largeFrame.fill(0x61, 1 + lengthBytes.length);

  manager.unpacket(largeFrame, () => {
    throw new Error("incomplete frame should not emit packets");
  });

  assert.equal(manager.lockReconnect, false);
  assert.equal(manager.tempBufferData.length, largeFrame.length);
});
