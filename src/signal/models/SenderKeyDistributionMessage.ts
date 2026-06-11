export class SenderKeyDistributionMessage {
  groupId: any
  senderUid: any
  senderDeviceId: any
  keyId: any
  senderKey: any
  signingPubKey: any
  memberHash: string
  kdfVersion: string

  constructor({
    groupId,
    senderUid,
    senderDeviceId,
    keyId,
    senderKey,
    signingPubKey,
    memberHash,
    kdfVersion,
  }: any) {
    this.groupId = groupId
    this.senderUid = senderUid
    this.senderDeviceId = senderDeviceId
    this.keyId = keyId
    this.senderKey = senderKey
    this.signingPubKey = signingPubKey
    this.memberHash = memberHash || ""
    this.kdfVersion = kdfVersion || "v1"
  }

  static fromString(raw: string) {
    if (!raw) {
      return null
    }
    const obj = JSON.parse(raw)
    if (!obj || obj.type !== "sender_key_distribution") {
      return null
    }
    return new SenderKeyDistributionMessage({
      groupId: obj.group_id,
      senderUid: obj.sender_uid,
      senderDeviceId: obj.sender_device_id,
      keyId: obj.key_id,
      senderKey: obj.sender_key,
      signingPubKey: obj.signing_pub_key,
      memberHash: obj.member_hash || "",
      kdfVersion: obj.kdf_ver || "v1",
    })
  }

  toString() {
    return JSON.stringify({
      type: "sender_key_distribution",
      group_id: this.groupId,
      sender_uid: this.senderUid,
      sender_device_id: this.senderDeviceId,
      key_id: this.keyId,
      sender_key: this.senderKey,
      signing_pub_key: this.signingPubKey,
      member_hash: this.memberHash || "",
      kdf_ver: this.kdfVersion || "v1",
    })
  }
}

