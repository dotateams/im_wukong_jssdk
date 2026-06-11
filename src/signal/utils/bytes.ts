export function randomBytes(length: number) {
  const arr = new Uint8Array(length)
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(arr)
    return arr
  }
  for (let i = 0; i < length; i++) {
    arr[i] = Math.floor(Math.random() * 256)
  }
  return arr
}

export function stringToArrayBuffer(str: string) {
  const encoder = new TextEncoder()
  return encoder.encode(str).buffer
}

export function arrayBufferToString(buffer: any) {
  const decoder = new TextDecoder()
  return decoder.decode(new Uint8Array(buffer))
}

