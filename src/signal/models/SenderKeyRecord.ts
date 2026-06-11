import { SenderKeyState } from "./SenderKeyState"

export class SenderKeyRecord {
  memberHash: string
  states: SenderKeyState[]
  createdAt: number
  updatedAt: number

  constructor({ memberHash, states, createdAt, updatedAt }: any) {
    this.memberHash = memberHash || ""
    this.states = Array.isArray(states) ? states : []
    this.createdAt = createdAt || Date.now()
    this.updatedAt = updatedAt || Date.now()
  }

  static fromStorage(obj: any) {
    if (!obj) {
      return null
    }
    if (Array.isArray(obj.states) && obj.states.length > 0) {
      const states = obj.states.map((item: any) => SenderKeyState.fromStorage(item)).filter(Boolean)
      if (states.length === 0) {
        return null
      }
      return new SenderKeyRecord({
        memberHash: obj.member_hash || "",
        states,
        createdAt: obj.created_at || Date.now(),
        updatedAt: obj.updated_at || Date.now(),
      })
    }
    if (obj.sender_key || obj.key) {
      const legacy = {
        key_id: obj.key_id || Date.now(),
        sender_key: obj.sender_key || obj.key,
        chain_key: obj.chain_key || obj.sender_key || obj.key,
        msg_index: obj.msg_index || 0,
        skipped: obj.skipped || {},
        signing_pub_key: obj.signing_pub_key,
        signing_priv_key: obj.signing_priv_key,
      }
      const state = SenderKeyState.fromStorage(legacy)
      return new SenderKeyRecord({
        memberHash: obj.member_hash || "",
        states: state ? [state] : [],
        createdAt: obj.created_at || Date.now(),
        updatedAt: obj.updated_at || Date.now(),
      })
    }
    return null
  }

  serialize() {
    return {
      member_hash: this.memberHash || "",
      states: this.states.map(state => state.serialize()),
      created_at: this.createdAt,
      updated_at: this.updatedAt,
    }
  }

  touch(): void {
    this.updatedAt = Date.now()
  }

  getState() {
    return this.states.length > 0 ? this.states[0] : null
  }

  getStateByKeyId(keyId: any) {
    if (!keyId) {
      return null
    }
    return this.states.find(state => state && state.keyId === keyId) || null
  }

  addState(state: SenderKeyState) {
    if (!state) {
      return
    }
    this.states = this.states.filter(item => item && item.keyId !== state.keyId)
    this.states.unshift(state)
    if (this.states.length > 5) {
      this.states = this.states.slice(0, 5)
    }
  }
}

