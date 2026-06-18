import assert from "assert";
import Encoder from "../src/encoder";

test("encoder writes large byte arrays without stack overflow", () => {
  const encoder = new Encoder();
  const bytes = new Array(256 * 1024).fill(97);

  encoder.writeBytes(bytes);

  assert.equal(encoder.toUint8Array().length, bytes.length);
});

test("encoder writes large strings without stack overflow", () => {
  const encoder = new Encoder();
  const value = "a".repeat(32 * 1024);

  encoder.writeString(value);

  assert.equal(encoder.toUint8Array().length, value.length + 2);
});
