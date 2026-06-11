export function toBase64(buffer: any) {
  let bytes: any
  if (buffer instanceof ArrayBuffer) {
    bytes = new Uint8Array(buffer)
  } else if (buffer instanceof Uint8Array) {
    bytes = buffer
  } else if (typeof buffer === "string") {
    const len = buffer.length
    bytes = new Uint8Array(len)
    for (let i = 0; i < len; i++) {
      bytes[i] = buffer.charCodeAt(i) % 256
    }
  } else {
    return ""
  }
  return btoa(String.fromCharCode.apply(null, bytes))
}

export function fromBase64(str: any) {
  if (!str) {
    return new ArrayBuffer(0)
  }
  let normalized = String(str).trim().replace(/\s+/g, "").replace(/-/g, '+').replace(/_/g, '/')
  const padding = normalized.length % 4
  if (padding === 2) {
    normalized += '=='
  } else if (padding === 3) {
    normalized += '='
  } else if (padding !== 0) {
    normalized += '==='
  }
  try {
    const binary = atob(normalized)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes.buffer
  } catch (e) {
    if (typeof Buffer !== "undefined") {
      try {
        const buf = Buffer.from(normalized, "base64")
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      } catch (e2) {
        e2 = null
      }
    }
    e = null
    throw new Error("Invalid base64 ciphertext")
  }
}

