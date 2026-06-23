import CryptoJS from 'crypto-js'

export class SenderKeyState {
  keyId: any
  senderKey: any
  chainKey: any
  signingPubKey: any
  signingPrivKey: any
  messageIndex: number
  skipped: any
  kdfVersion: string

  constructor({
    keyId,
    senderKey,
    chainKey,
    signingPubKey,
    signingPrivKey,
    messageIndex,
    skipped,
    kdfVersion,
  }: any) {
    this.keyId = keyId
    this.senderKey = senderKey
    this.chainKey = chainKey
    this.signingPubKey = signingPubKey
    this.signingPrivKey = signingPrivKey
    this.messageIndex = messageIndex || 0
    this.skipped = skipped || {}
    this.kdfVersion = kdfVersion || "v1"
  }

  static fromDistribution(message: any) {
    return new SenderKeyState({
      keyId: message.keyId,
      senderKey: message.senderKey,
      chainKey: message.senderKey,
      signingPubKey: message.signingPubKey,
      signingPrivKey: null,
      messageIndex: 0,
      skipped: {},
      kdfVersion: message.kdfVersion || "v1",
    })
  }

  static fromStorage(obj: any) {
    if (!obj) {
      return null
    }
    return new SenderKeyState({
      keyId: obj.key_id,
      senderKey: obj.sender_key,
      chainKey: obj.chain_key || obj.sender_key,
      signingPubKey: obj.signing_pub_key,
      signingPrivKey: obj.signing_priv_key,
      messageIndex: obj.msg_index || 0,
      skipped: obj.skipped || {},
      kdfVersion: obj.kdf_ver || "v1",
    })
  }

  serialize() {
    return {
      key_id: this.keyId,
      sender_key: this.senderKey,
      chain_key: this.chainKey,
      msg_index: this.messageIndex || 0,
      skipped: this.skipped || {},
      signing_pub_key: this.signingPubKey,
      signing_priv_key: this.signingPrivKey,
      kdf_ver: this.kdfVersion || "v1",
    }
  }

  nextMessageKeyForSending() {
    const msgIndex = this.messageIndex || 0
    const derived = this.deriveMessageKey(this.chainKey || this.senderKey)
    this.chainKey = derived.nextChainKey
    this.messageIndex = msgIndex + 1
    return { messageKey: derived.messageKey, msgIndex }
  }

  getMessageKeyForIndex(targetIndex: number) {
    const index = this.messageIndex || 0
    let chainKey = this.chainKey || this.senderKey
    let skipped = this.skipped || {}
    if (targetIndex < index) {
      const cached = skipped[targetIndex]
      if (!cached) {
        return { messageKey: this.deriveHistoricalMessageKey(targetIndex) }
      }
      delete skipped[targetIndex]
      this.skipped = skipped
      return { messageKey: cached }
    }
    let messageKey: any = null
    for (let i = index; i <= targetIndex; i++) {
      const derived = this.deriveMessageKey(chainKey)
      messageKey = derived.messageKey
      chainKey = derived.nextChainKey
      if (i < targetIndex) {
        skipped[i] = messageKey
        skipped = this.trimSkippedKeys(skipped)
      }
    }
    this.chainKey = chainKey
    this.messageIndex = targetIndex + 1
    this.skipped = skipped
    return { messageKey }
  }

  deriveHistoricalMessageKey(targetIndex: number) {
    let chainKey = this.senderKey
    let messageKey: any = null
    for (let i = 0; i <= targetIndex; i++) {
      const derived = this.deriveMessageKey(chainKey)
      messageKey = derived.messageKey
      chainKey = derived.nextChainKey
    }
    if (!messageKey) {
      throw new Error("Missing message key")
    }
    return messageKey
  }

  deriveMessageKey(chainKeyBase64: string) {
    const keyWord = CryptoJS.enc.Base64.parse(chainKeyBase64)
    let derivedMessageKey: string
    let derivedNextChainKey: string
    if (this.kdfVersion === "v2") {
      const salt = CryptoJS.enc.Utf8.parse("wukong_group_kdf_v2")
      const prk = CryptoJS.HmacSHA256(keyWord, salt)
      const okm = this.hkdfExpand(prk, "sender_key", 64)
      derivedMessageKey = CryptoJS.enc.Base64.stringify(CryptoJS.lib.WordArray.create(okm.words.slice(0, 8), 32))
      derivedNextChainKey = CryptoJS.enc.Base64.stringify(CryptoJS.lib.WordArray.create(okm.words.slice(8, 16), 32))
      return { messageKey: derivedMessageKey, nextChainKey: derivedNextChainKey }
    }
    derivedMessageKey = CryptoJS.HmacSHA256("msg", keyWord).toString(CryptoJS.enc.Base64)
    derivedNextChainKey = CryptoJS.HmacSHA256("chain", keyWord).toString(CryptoJS.enc.Base64)
    return { messageKey: derivedMessageKey, nextChainKey: derivedNextChainKey }
  }

  hkdfExpand(prkWord: any, info: any, lengthBytes: number) {
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

  trimSkippedKeys(skipped: any) {
    const keys = Object.keys(skipped)
    if (keys.length <= 50) {
      return skipped
    }
    const sorted = keys.map(k => Number(k)).filter(n => !Number.isNaN(n)).sort((a, b) => a - b)
    const removeCount = sorted.length - 50
    for (let i = 0; i < removeCount; i++) {
      delete skipped[sorted[i]]
    }
    return skipped
  }
}
