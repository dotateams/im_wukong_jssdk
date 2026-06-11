import CryptoJS from 'crypto-js'

export function arrayBufferToWordArray(buffer: any) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(0)
  const words: any[] = []
  for (let i = 0; i < bytes.length; i += 4) {
    const b0 = bytes[i] || 0
    const b1 = bytes[i + 1] || 0
    const b2 = bytes[i + 2] || 0
    const b3 = bytes[i + 3] || 0
    const word = (b0 * 0x1000000) + (b1 * 0x10000) + (b2 * 0x100) + b3
    words.push(word > 0x7fffffff ? word - 0x100000000 : word)
  }
  return CryptoJS.lib.WordArray.create(words, bytes.length)
}

export function wordArrayToUint8Array(wordArray: any) {
  const words = wordArray.words || []
  const sigBytes = wordArray.sigBytes || 0
  const u8 = new Uint8Array(sigBytes)
  let offset = 0
  for (let i = 0; i < words.length && offset < sigBytes; i++) {
    const word = words[i]
    const u32 = word < 0 ? word + 0x100000000 : word
    u8[offset++] = Math.floor(u32 / 0x1000000) % 256
    if (offset >= sigBytes) break
    u8[offset++] = Math.floor(u32 / 0x10000) % 256
    if (offset >= sigBytes) break
    u8[offset++] = Math.floor(u32 / 0x100) % 256
    if (offset >= sigBytes) break
    u8[offset++] = u32 % 256
  }
  return u8
}

export function hkdfExpandWord(prkWord: any, info: any, lengthBytes: number) {
  const infoWord = typeof info === "string" ? CryptoJS.enc.Utf8.parse(info) : info
  let t = CryptoJS.lib.WordArray.create()
  let okm = CryptoJS.lib.WordArray.create()
  let counter = 1
  while (okm.sigBytes < lengthBytes) {
    const counterWord = CryptoJS.lib.WordArray.create([counter * 0x1000000], 1)
    const input = t.clone().concat(infoWord).concat(counterWord)
    t = CryptoJS.HmacSHA256(input, prkWord)
    okm = okm.concat(t)
    counter += 1
  }
  okm.sigBytes = lengthBytes
  okm.clamp()
  return okm
}

export function hkdfSha256Bytes(ikmBuffer: any, saltText: any, infoText: any, lengthBytes: number) {
  const ikmWord = arrayBufferToWordArray(ikmBuffer)
  const saltWord = CryptoJS.enc.Utf8.parse(String(saltText || ""))
  const prk = CryptoJS.HmacSHA256(ikmWord, saltWord)
  const okm = hkdfExpandWord(prk, infoText, lengthBytes)
  return wordArrayToUint8Array(okm)
}

