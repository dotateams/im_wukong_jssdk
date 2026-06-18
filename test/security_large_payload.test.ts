import assert from "assert";
import { SecurityManager } from "../src/security";

test("security encryption handles large byte payloads without stack overflow", () => {
  const payload = new Uint8Array(256 * 1024);
  payload.fill("a".charCodeAt(0));

  const encrypted = SecurityManager.shared().encryption2(payload);

  assert.equal(typeof encrypted, "string");
  assert.ok(encrypted.length > 0);
});
