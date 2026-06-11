export type NormalizedKeyBundle = {
  uid: string
  deviceId: string
  identityKey: string
  registrationId?: number
  signedPrekey?: {
    keyId: number
    publicKey: string
    signature: string
  }
  prekey?: {
    keyId: number
    publicKey: string
  }
  protocolVersion?: number
}

function pick(obj: any, keys: string[]) {
  if (!obj || typeof obj !== "object") {
    return undefined
  }
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && (obj as any)[k] !== undefined && (obj as any)[k] !== null) {
      return (obj as any)[k]
    }
  }
  return undefined
}

function toNumber(value: any) {
  if (typeof value === "number") return value
  if (typeof value === "string" && value !== "") {
    const n = parseInt(value, 10)
    if (!isNaN(n)) return n
  }
  return undefined
}

export class KeyBundleDirectory {
  apiClient: any
  isSuccessResponse: (resp: any) => boolean
  getResponseData: (resp: any) => any
  cache: Map<string, { bundles: NormalizedKeyBundle[]; fetchedAt: number }>
  inFlight: Map<string, Promise<NormalizedKeyBundle[]>>
  cacheTtlMs: number

  constructor(apiClient: any, isSuccessResponse: (resp: any) => boolean, getResponseData: (resp: any) => any) {
    this.apiClient = apiClient
    this.isSuccessResponse = isSuccessResponse
    this.getResponseData = getResponseData
    this.cache = new Map()
    this.inFlight = new Map()
    this.cacheTtlMs = 30 * 1000
  }

  normalize(raw: any): NormalizedKeyBundle | null {
    if (!raw || typeof raw !== "object") {
      return null
    }
    const uid = String(pick(raw, ["UID", "uid", "UserID", "user_id", "userId"]) || "")
    const deviceId = String(pick(raw, ["DeviceID", "device_id", "deviceId", "id"]) || "")
    const identityKey = String(pick(raw, ["IdentityKey", "identity_key", "identityKey"]) || "")
    if (!uid || !deviceId || !identityKey) {
      return null
    }
    const signedRaw: any = pick(raw, ["SignedPrekey", "SignedPreKey", "signed_prekey", "signedPrekey"])
    const prekeyRaw: any = pick(raw, ["Prekey", "PreKey", "prekey", "preKey"])
    const signedKeyId = toNumber(pick(signedRaw, ["KeyID", "key_id", "keyId"]))
    const signedPublicKey = pick(signedRaw, ["PublicKey", "public_key", "publicKey"])
    const signedSignature = pick(signedRaw, ["Signature", "signature"])
    const preKeyId = toNumber(pick(prekeyRaw, ["KeyID", "key_id", "keyId"]))
    const prePublicKey = pick(prekeyRaw, ["PublicKey", "public_key", "publicKey"])
    const registrationId = toNumber(pick(raw, ["RegistrationID", "registration_id", "registrationId"]))
    const protocolVersion = toNumber(pick(raw, ["ProtocolVersion", "protocol_version", "protocolVersion"]))

    return {
      uid,
      deviceId,
      identityKey,
      registrationId,
      signedPrekey: signedKeyId !== undefined && signedPublicKey && signedSignature
        ? { keyId: signedKeyId, publicKey: String(signedPublicKey), signature: String(signedSignature) }
        : undefined,
      prekey: preKeyId !== undefined && prePublicKey
        ? { keyId: preKeyId, publicKey: String(prePublicKey) }
        : undefined,
      protocolVersion,
    }
  }

  async getUserKeyBundles(uid: string, forceRefresh?: boolean): Promise<NormalizedKeyBundle[]> {
    if (!this.apiClient || typeof this.apiClient.get !== "function") {
      console.warn("[KeyBundleDirectory] invalid apiClient for getUserKeyBundles", {
        hasClient: !!this.apiClient,
        hasGet: !!(this.apiClient && (this.apiClient as any).get),
      })
      return []
    }
    if (!uid) {
      console.warn("[KeyBundleDirectory] getUserKeyBundles called with empty uid")
      return []
    }
    const now = Date.now()
    if (!forceRefresh) {
      const cached = this.cache.get(uid)
      if (cached && now - cached.fetchedAt < this.cacheTtlMs) {
        return cached.bundles
      }
      const inflight = this.inFlight.get(uid)
      if (inflight) {
        return await inflight
      }
    }
    const reqPromise = (async () => {
      const resp = await this.apiClient.get(`/cluster/e2e/keys/${uid}`)
      console.log("getUserKeyBundles resp:", resp)
      if (!this.isSuccessResponse(resp)) {
        throw new Error(`Failed to get key bundles: ${resp && ((resp as any).msg ?? (resp as any).code)}`)
      }
      const data: any = this.getResponseData(resp)
      const list = Array.isArray(data) ? data : (data && Array.isArray(data.bundles) ? data.bundles : [])
      const bundles: NormalizedKeyBundle[] = []
      for (const item of list) {
        const normalized = this.normalize(item)
        if (normalized) {
          bundles.push(normalized)
        }
      }
      this.cache.set(uid, { bundles, fetchedAt: Date.now() })
      return bundles
    })()
    this.inFlight.set(uid, reqPromise)
    try {
      return await reqPromise
    } finally {
      this.inFlight.delete(uid)
    }
  }

  async getDeviceKeyBundle(uid: string, deviceId: any, forceRefresh?: boolean): Promise<NormalizedKeyBundle | null> {
    const did = deviceId !== undefined && deviceId !== null ? String(deviceId) : ""
    if (!uid || !did) {
      return null
    }
    const bundles = await this.getUserKeyBundles(uid, forceRefresh)
    for (const b of bundles) {
      if (String(b.deviceId) === did) {
        return b
      }
    }
    return null
  }
}
