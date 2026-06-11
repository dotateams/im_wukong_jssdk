import { SenderKeyRecord } from "../models/SenderKeyRecord"

export class GroupCipher {
  manager: any
  record: SenderKeyRecord
  groupId: any
  senderUid: any

  constructor(manager: any, record: SenderKeyRecord, groupId: any, senderUid: any) {
    this.manager = manager
    this.record = record
    this.groupId = groupId
    this.senderUid = senderUid
  }

  async encrypt(plaintext: string) {
    const state: any = this.record.getState()
    if (!state) {
      throw new Error("Missing sender key")
    }
    const next = state.nextMessageKeyForSending()
    const encrypted = await this.manager.encryptGroupPayload(next.messageKey, next.msgIndex, plaintext, state.kdfVersion)
    const signature = await this.manager.signGroupPayload(
      state.signingPrivKey,
      this.groupId,
      this.senderUid,
      next.msgIndex,
      encrypted.iv,
      encrypted.body,
      encrypted.mac,
      encrypted.enc,
      encrypted.tag
    )
    return {
      state,
      payload: {
        type: "signal_group",
        group_id: this.groupId,
        sender_uid: this.senderUid,
        key_id: state.keyId,
        msg_index: next.msgIndex,
        iv: encrypted.iv,
        body: encrypted.body,
        mac: encrypted.mac,
        tag: encrypted.tag,
        enc: encrypted.enc,
        kdf_ver: state.kdfVersion,
        signature,
        signing_pub_key: state.signingPubKey,
      },
    }
  }

  async decrypt(obj: any) {
    const keyId = obj.key_id
    const state: any = this.record.getStateByKeyId(keyId)
    if (!state) {
      throw new Error("Missing sender key")
    }
    if (!state.signingPubKey && obj.signing_pub_key) {
      state.signingPubKey = obj.signing_pub_key
    }
    const msgIndex = obj.msg_index || 0
    let signingPubKey = state.signingPubKey || obj.signing_pub_key
    if (obj.signing_pub_key && state.signingPubKey && state.signingPubKey !== obj.signing_pub_key) {
      signingPubKey = obj.signing_pub_key
      state.signingPubKey = obj.signing_pub_key
    }
    const signatureOk = await this.manager.verifyGroupSignature(
      signingPubKey,
      this.groupId,
      this.senderUid,
      msgIndex,
      obj.iv,
      obj.body,
      obj.mac,
      obj.signature,
      obj.enc,
      obj.tag
    )
    if (!signatureOk) {
      throw new Error("Invalid group message signature")
    }
    if (!state.kdfVersion && obj.kdf_ver) {
      state.kdfVersion = obj.kdf_ver
    }
    const derived = state.getMessageKeyForIndex(msgIndex)
    return await this.manager.decryptGroupPayload(derived.messageKey, msgIndex, obj.iv, obj.body, obj.mac, obj.tag, obj.enc)
  }
}

