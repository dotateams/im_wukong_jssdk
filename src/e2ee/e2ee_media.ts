import { MessageContentType } from "../const"
import {
    Channel,
    MediaMessageContent,
    MessageContent,
    MessageContentManager,
    MessageEncryptedMedia,
} from "../model"
import type { E2EEApiClient, E2EEMediaProvider } from "./e2ee_types"

type MediaPart = {
    url: string
    key: string
    nonce: string
    sha256: string
    width?: number
    height?: number
    mime?: string
    size?: number
}

export class E2EEMediaCrypto {
    private apiClient?: E2EEApiClient
    private provider?: E2EEMediaProvider

    constructor(options: { apiClient?: E2EEApiClient; provider?: E2EEMediaProvider } = {}) {
        this.apiClient = options.apiClient
        this.provider = options.provider
    }

    public canEncrypt(content: MessageContent): boolean {
        return content instanceof MediaMessageContent && !!(content as MediaMessageContent).file
    }

    public isEncryptedMedia(content: MessageContent | any): boolean {
        return content instanceof MessageEncryptedMedia ||
            (content && content.contentType === MessageContentType.encryptedMedia)
    }

    public isRestoredMedia(content: MessageContent | any): boolean {
        return !!(content && content.e2eeMedia)
    }

    public async encryptContent(content: MediaMessageContent, channel: Channel): Promise<MessageEncryptedMedia> {
        const sourceFile = content.file
        if (!sourceFile) {
            throw new Error("E2EE media file is required")
        }
        const mediaKind = this.resolveMediaKind(content, sourceFile)
        const originalBlob = sourceFile as any as Blob
        const originalEncrypted = await this.encryptBlob(originalBlob)
        const originalUrl = await this.uploadEncryptedBlob(originalEncrypted.blob, channel, "original", content.contentType, this.fileNameOf(sourceFile), originalBlob.type)
        const originalPart: MediaPart = {
            url: originalUrl,
            key: originalEncrypted.key,
            nonce: originalEncrypted.nonce,
            sha256: originalEncrypted.sha256,
            width: (content as any).width || 0,
            height: (content as any).height || 0,
            mime: originalBlob.type || "application/octet-stream",
            size: originalBlob.size || 0,
        }

        let thumbPart: MediaPart | undefined
        const thumbBlob = await this.createThumbnail(originalBlob, content.contentType, mediaKind)
        if (thumbBlob) {
            const thumbEncrypted = await this.encryptBlob(thumbBlob)
            const thumbUrl = await this.uploadEncryptedBlob(thumbEncrypted.blob, channel, "thumb", content.contentType, this.fileNameOf(sourceFile), thumbBlob.type)
            thumbPart = {
                url: thumbUrl,
                key: thumbEncrypted.key,
                nonce: thumbEncrypted.nonce,
                sha256: thumbEncrypted.sha256,
                width: (thumbBlob as any).width || undefined,
                height: (thumbBlob as any).height || undefined,
                mime: thumbBlob.type || "image/jpeg",
                size: thumbBlob.size || 0,
            }
        }

        const encrypted = new MessageEncryptedMedia()
        encrypted.version = 1
        encrypted.mediaKind = mediaKind
        encrypted.originalContentType = content.contentType
        encrypted.name = this.fileNameOf(sourceFile)
        encrypted.original = originalPart
        encrypted.thumb = thumbPart
        return encrypted
    }

    public async restoreContent(content: MessageEncryptedMedia): Promise<MessageContent> {
        const displayPart = content.thumb || content.original
        const displayBlob = await this.decryptPart(displayPart)
        const displayUrl = this.createObjectURL(displayBlob)
        const restored = MessageContentManager.shared().getMessageContent(content.originalContentType)
        const payload: any = {
            type: content.originalContentType,
            url: displayUrl,
            width: displayPart.width || content.original?.width || 0,
            height: displayPart.height || content.original?.height || 0,
            name: content.name || "",
            size: content.original?.size || 0,
        }
        restored.decode(this.stringToUint8Array(JSON.stringify(payload)))
        ;(restored as any).e2eeMedia = {
            version: content.version,
            mediaKind: content.mediaKind,
            originalContentType: content.originalContentType,
            original: content.original,
            thumb: content.thumb,
            displayUrl,
        }
        return restored
    }

    public async loadOriginal(content: MessageContent | any): Promise<string | undefined> {
        const media = content && content.e2eeMedia
        if (!media || !media.original) {
            return undefined
        }
        if (media.originalBlobUrl) {
            return media.originalBlobUrl
        }
        const blob = await this.decryptPart(media.original)
        media.originalBlobUrl = this.createObjectURL(blob)
        return media.originalBlobUrl
    }

    private async encryptBlob(blob: Blob): Promise<{ blob: Blob; key: string; nonce: string; sha256: string }> {
        const subtle = this.subtleCrypto()
        const keyBytes = this.randomBytes(32)
        const nonceBytes = this.randomBytes(12)
        const cryptoKey = await subtle.importKey("raw", keyBytes, { name: "AES-GCM", length: 256 }, false, ["encrypt"])
        const encrypted = await subtle.encrypt({ name: "AES-GCM", iv: nonceBytes }, cryptoKey, await blob.arrayBuffer())
        const encryptedBlob = new Blob([encrypted], { type: "application/octet-stream" })
        return {
            blob: encryptedBlob,
            key: this.base64UrlEncode(keyBytes),
            nonce: this.base64UrlEncode(nonceBytes),
            sha256: await this.sha256(encryptedBlob),
        }
    }

    private async decryptPart(part: MediaPart): Promise<Blob> {
        if (!part || !part.url || !part.key || !part.nonce) {
            throw new Error("Invalid E2EE media part")
        }
        const encrypted = await this.fetchEncryptedBlob(part.url)
        const actualHash = await this.sha256(encrypted)
        if (part.sha256 && actualHash !== part.sha256) {
            throw new Error("E2EE media hash mismatch")
        }
        const subtle = this.subtleCrypto()
        const keyBytes = this.base64UrlDecode(part.key)
        const nonceBytes = this.base64UrlDecode(part.nonce)
        const cryptoKey = await subtle.importKey("raw", keyBytes, { name: "AES-GCM", length: 256 }, false, ["decrypt"])
        const decrypted = await subtle.decrypt({ name: "AES-GCM", iv: nonceBytes }, cryptoKey, await encrypted.arrayBuffer())
        return new Blob([decrypted], { type: part.mime || "application/octet-stream" })
    }

    private async uploadEncryptedBlob(
        blob: Blob,
        channel: Channel,
        kind: "original" | "thumb",
        contentType: number,
        fileName: string,
        mime?: string,
    ): Promise<string> {
        if (this.provider && this.provider.uploadEncryptedMedia) {
            return this.provider.uploadEncryptedMedia(blob, { channel, kind, contentType, fileName, mime })
        }
        if (!this.apiClient || typeof this.apiClient.get !== "function") {
            throw new Error("E2EE media upload provider is unavailable")
        }
        const path = this.buildUploadPath(channel, kind, fileName)
        const result = await this.apiClient.get(`file/upload?path=${path}&type=chat`)
        const uploadURL = result && result.url
        if (!uploadURL) {
            throw new Error("E2EE media upload URL is unavailable")
        }
        const form = new FormData()
        form.append("file", blob, `${kind}.e2ee`)
        const resp = await fetch(uploadURL, {
            method: "POST",
            body: form,
            headers: this.buildUploadHeaders(),
        })
        if (!resp.ok) {
            throw new Error(`E2EE media upload failed: ${resp.status}`)
        }
        const data = await resp.json()
        if (!data || !data.path) {
            throw new Error("E2EE media upload response missing path")
        }
        return data.path
    }

    private async fetchEncryptedBlob(url: string): Promise<Blob> {
        if (this.provider && this.provider.fetchEncryptedMedia) {
            return this.provider.fetchEncryptedMedia(url)
        }
        const fullURL = this.toAbsoluteURL(url)
        const resp = await fetch(fullURL, { cache: "force-cache" })
        if (!resp.ok) {
            throw new Error(`E2EE media download failed: ${resp.status}`)
        }
        const contentType = resp.headers && resp.headers.get ? resp.headers.get("content-type") || "" : ""
        if (contentType.indexOf("application/json") >= 0) {
            const data = await resp.json()
            const unwrapped = await this.unwrapServerEncryptedBlob(data)
            if (unwrapped) {
                return unwrapped
            }
            return new Blob([JSON.stringify(data)], { type: contentType })
        }
        return resp.blob()
    }

    private async unwrapServerEncryptedBlob(data: any): Promise<Blob | undefined> {
        if (!data || typeof data.key !== "string" || typeof data.encrypted_data !== "string") {
            return undefined
        }
        const encryptedData = this.base64Decode(data.encrypted_data)
        if (encryptedData.length <= 12) {
            return undefined
        }
        const keyBytes = this.base64Decode(data.key)
        const nonceBytes = encryptedData.slice(0, 12)
        const ciphertext = encryptedData.slice(12)
        const cryptoKey = await this.subtleCrypto().importKey("raw", keyBytes, { name: "AES-GCM", length: 256 }, false, ["decrypt"])
        const plaintextBase64 = await this.subtleCrypto().decrypt({ name: "AES-GCM", iv: nonceBytes }, cryptoKey, ciphertext)
        const plaintext = this.base64Decode(this.uint8ArrayToString(new Uint8Array(plaintextBase64)))
        return new Blob([plaintext], { type: "application/octet-stream" })
    }

    private async createThumbnail(blob: Blob, contentType: number, mediaKind: string): Promise<Blob | undefined> {
        if (this.provider && this.provider.createThumbnail) {
            return this.provider.createThumbnail(blob, { contentType, mediaKind, maxSize: 320 })
        }
        if (typeof document === "undefined" || typeof Image === "undefined") {
            return undefined
        }
        if (!blob.type || blob.type.indexOf("image/") !== 0) {
            return undefined
        }
        return new Promise<Blob | undefined>((resolve) => {
            const img = new Image()
            const src = this.createObjectURL(blob)
            img.onload = () => {
                const maxSize = 320
                const ratio = Math.min(1, maxSize / Math.max(img.width || maxSize, img.height || maxSize))
                const width = Math.max(1, Math.round((img.width || maxSize) * ratio))
                const height = Math.max(1, Math.round((img.height || maxSize) * ratio))
                const canvas = document.createElement("canvas")
                canvas.width = width
                canvas.height = height
                const ctx = canvas.getContext("2d")
                if (!ctx) {
                    this.revokeObjectURL(src)
                    resolve(undefined)
                    return
                }
                ctx.drawImage(img, 0, 0, width, height)
                canvas.toBlob((thumb) => {
                    this.revokeObjectURL(src)
                    if (thumb) {
                        ;(thumb as any).width = width
                        ;(thumb as any).height = height
                    }
                    resolve(thumb || undefined)
                }, "image/jpeg", 0.82)
            }
            img.onerror = () => {
                this.revokeObjectURL(src)
                resolve(undefined)
            }
            img.src = src
        })
    }

    private resolveMediaKind(content: MediaMessageContent, file: File): string {
        const name = this.fileNameOf(file).toLowerCase()
        const mime = (file as any).type || ""
        if (mime === "image/gif" || name.indexOf(".gif") >= 0) {
            return "gif"
        }
        if (content.contentType === MessageContentType.image) {
            return "image"
        }
        return "media"
    }

    private buildUploadPath(channel: Channel, kind: string, fileName: string): string {
        const ext = this.extensionOf(fileName)
        const suffix = ext ? `.${ext}.e2ee` : ".e2ee"
        return `/${channel.channelType}/${channel.channelID}/${this.uuid()}-${kind}${suffix}`
    }

    private toAbsoluteURL(url: string): string {
        if (url.indexOf("http") === 0 || !this.apiClient) {
            return url
        }
        const apiURL = (this.apiClient as any).config && (this.apiClient as any).config.apiURL
        if (!apiURL) {
            return url
        }
        if (url.indexOf("/") === 0) {
            return `${apiURL}${url.substring(1)}`
        }
        return `${apiURL}${url}`
    }

    private buildUploadHeaders(): Record<string, string> {
        const headers: Record<string, string> = { "bb-encrypt": "" }
        const config = this.apiClient && (this.apiClient as any).config
        if (!config) {
            return headers
        }

        let token: string | undefined
        if (typeof config.tokenCallback === "function") {
            token = config.tokenCallback()
        }
        if (!token && typeof config.token === "string") {
            token = config.token
        }
        if (token) {
            headers.token = token
        }
        return headers
    }

    private subtleCrypto(): SubtleCrypto {
        const cryptoObj = (globalThis as any).crypto
        if (!cryptoObj || !cryptoObj.subtle) {
            throw new Error("WebCrypto subtle is unavailable")
        }
        return cryptoObj.subtle
    }

    private randomBytes(length: number): Uint8Array {
        const bytes = new Uint8Array(length)
        const cryptoObj = (globalThis as any).crypto
        if (!cryptoObj || !cryptoObj.getRandomValues) {
            throw new Error("WebCrypto random is unavailable")
        }
        cryptoObj.getRandomValues(bytes)
        return bytes
    }

    private async sha256(blob: Blob): Promise<string> {
        const digest = await this.subtleCrypto().digest("SHA-256", await blob.arrayBuffer())
        return this.base64UrlEncode(new Uint8Array(digest))
    }

    private base64UrlEncode(bytes: Uint8Array): string {
        let binary = ""
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i])
        }
        const base64 = typeof btoa === "function"
            ? btoa(binary)
            : (Buffer as any).from(binary, "binary").toString("base64")
        return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
    }

    private base64UrlDecode(value: string): Uint8Array {
        const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4)
        return this.base64Decode(base64)
    }

    private base64Decode(base64: string): Uint8Array {
        const binary = typeof atob === "function"
            ? atob(base64)
            : (Buffer as any).from(base64, "base64").toString("binary")
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i)
        }
        return bytes
    }

    private createObjectURL(blob: Blob): string {
        if (typeof URL !== "undefined" && URL.createObjectURL) {
            return URL.createObjectURL(blob)
        }
        return `data:${blob.type || "application/octet-stream"};base64,`
    }

    private revokeObjectURL(url: string) {
        if (typeof URL !== "undefined" && URL.revokeObjectURL && url.indexOf("blob:") === 0) {
            URL.revokeObjectURL(url)
        }
    }

    private fileNameOf(file: any): string {
        return (file && file.name) || "media"
    }

    private extensionOf(fileName: string): string {
        const idx = fileName.lastIndexOf(".")
        return idx >= 0 ? fileName.substring(idx + 1).toLowerCase() : ""
    }

    private uuid(): string {
        return "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx".replace(/[x]/g, () =>
            Math.floor(Math.random() * 16).toString(16),
        )
    }

    private stringToUint8Array(value: string): Uint8Array {
        const encoded = unescape(encodeURIComponent(value))
        const result = new Array<number>()
        for (let i = 0; i < encoded.length; i++) {
            result.push(encoded.charCodeAt(i))
        }
        return new Uint8Array(result)
    }

    private uint8ArrayToString(bytes: Uint8Array): string {
        let binary = ""
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i])
        }
        return binary
    }
}
