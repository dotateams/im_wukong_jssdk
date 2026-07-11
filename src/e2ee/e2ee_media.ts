import { MessageContentType } from "../const"
import {
    Channel,
    MediaMessageContent,
    MessageContent,
    MessageContentManager,
    MessageEncryptedMedia,
} from "../model"
import type { E2EEApiClient, E2EEMediaProvider } from "./e2ee_types"
import CryptoJS from "crypto-js"
import { E2EECacheStore, E2EE_CACHE_STORES } from "./e2ee_cache_store"

type MediaPart = {
    url: string
    key: string
    nonce: string
    sha256: string
    file_md5?: string
    width?: number
    height?: number
    mime?: string
    size?: number
}

export const E2EE_MAX_INLINE_DECRYPT_BYTES = 64 * 1024 * 1024
export const E2EE_DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024

type ChunkedMediaPart = {
    mode: "chunked"
    session_id: string
    chunk_size: number
    size: number
    file_md5?: string
    mime?: string
    sha256: string
    chunk_count: number
    chunks: Array<MediaPart & {
        index: number
        offset: number
        plain_size: number
        encrypted_size?: number
        etag?: string
    }>
}

export type E2EEMediaProgressPhase = "uploading" | "downloading" | "decrypting" | "writing"

export type E2EEMediaProgress = {
    loadedBytes: number
    totalBytes: number
    percent: number
    chunkIndex?: number
    chunkCount?: number
    phase: E2EEMediaProgressPhase
}

export type SaveOriginalOptions = {
    onProgress?: (progress: E2EEMediaProgress) => void
}

export type E2EEMediaForwardCheck =
    | { ok: true }
    | { ok: false; reason: "missing-media" | "missing-object" | "missing-hash" | "incomplete-chunked-object" }

export class E2EEMediaCrypto {
    private apiClient?: E2EEApiClient
    private provider?: E2EEMediaProvider
    private cacheScope?: () => { uid?: string; deviceId?: string | number }
    private chunkThresholdBytes: number
    private chunkSize: number

    constructor(options: {
        apiClient?: E2EEApiClient
        provider?: E2EEMediaProvider
        cacheScope?: () => { uid?: string; deviceId?: string | number }
        chunkThresholdBytes?: number
        chunkSize?: number
    } = {}) {
        this.apiClient = options.apiClient
        this.provider = options.provider
        this.cacheScope = options.cacheScope
        this.chunkThresholdBytes = Math.max(1, Number(options.chunkThresholdBytes || E2EE_MAX_INLINE_DECRYPT_BYTES))
        this.chunkSize = Math.max(1, Number(options.chunkSize || E2EE_DEFAULT_CHUNK_SIZE))
        const scope = this.cacheScope ? this.cacheScope() : {}
        if (scope.uid && scope.deviceId !== undefined && scope.deviceId !== null) {
            E2EECacheStore.shared().scheduleLegacyMigration(
                E2EE_CACHE_STORES.THUMBNAILS,
                `wk_e2ee_media_thumb:${scope.uid}:${String(scope.deviceId)}:`,
            )
        }
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

    public toEncryptedMediaContent(content: MessageContent | any): MessageEncryptedMedia | undefined {
        const media = content && content.e2eeMedia
        if (!media || !media.original) {
            return undefined
        }
        const encrypted = new MessageEncryptedMedia()
        encrypted.version = Number(media.version || 1)
        encrypted.mediaKind = media.mediaKind || ""
        encrypted.originalContentType = Number(media.originalContentType || content.contentType || 0)
        encrypted.name = media.name || content.name || ""
        encrypted.original = this.cloneJSON(media.original)
        encrypted.thumb = media.thumb ? this.cloneJSON(media.thumb) : undefined
        return encrypted
    }

    public prepareReusableMediaForwardContent(content: MessageContent | any): MessageEncryptedMedia | undefined {
        return this.toEncryptedMediaContent(content)
    }

    public canForwardE2EEMedia(content: MessageContent | any): E2EEMediaForwardCheck {
        const media = content instanceof MessageEncryptedMedia ? content : content && content.e2eeMedia
        if (!media || !media.original) {
            return { ok: false, reason: "missing-media" }
        }
        const original = media.original
        if (this.isChunkedPart(original)) {
            if (!Array.isArray(original.chunks) || original.chunks.length === 0) {
                return { ok: false, reason: "missing-object" }
            }
            for (const chunk of original.chunks) {
                if (!chunk || !chunk.url || !chunk.key || !chunk.nonce) {
                    return { ok: false, reason: "incomplete-chunked-object" }
                }
                if (!chunk.sha256) {
                    return { ok: false, reason: "missing-hash" }
                }
            }
            return { ok: true }
        }
        if (!original.url || !original.key || !original.nonce) {
            return { ok: false, reason: "missing-object" }
        }
        if (!original.sha256) {
            return { ok: false, reason: "missing-hash" }
        }
        return { ok: true }
    }

    public async encryptContent(content: MediaMessageContent, channel: Channel): Promise<MessageEncryptedMedia> {
        const sourceFile = content.file
        if (!sourceFile) {
            throw new Error("E2EE media file is required")
        }
        const mediaKind = this.resolveMediaKind(content, sourceFile)
        const originalBlob = sourceFile as any as Blob
        const fileMD5 = await this.md5(originalBlob)
        const onUploadProgress = typeof (content as any).onUploadProgress === "function"
            ? (content as any).onUploadProgress
            : undefined
        const originalPart = originalBlob.size > this.chunkThresholdBytes
            ? await this.encryptChunkedBlob(originalBlob, channel, content.contentType, this.fileNameOf(sourceFile), originalBlob.type, fileMD5, onUploadProgress)
            : await this.encryptSingleOriginalPart(originalBlob, channel, content, sourceFile, fileMD5, onUploadProgress)

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
        encrypted.version = this.isChunkedPart(originalPart) ? 2 : 1
        encrypted.mediaKind = mediaKind
        encrypted.originalContentType = content.contentType
        encrypted.name = this.fileNameOf(sourceFile)
        encrypted.original = originalPart
        encrypted.thumb = thumbPart
        this.attachLocalEncryptedMedia(content, encrypted, sourceFile)
        return encrypted
    }

    private attachLocalEncryptedMedia(content: MediaMessageContent, encrypted: MessageEncryptedMedia, sourceFile: File): void {
        const localContent = content as any
        const displayUrl = this.localDisplayUrlFor(encrypted, sourceFile)
        if ("url" in localContent) {
            localContent.url = displayUrl
        }
        content.remoteUrl = displayUrl
        if (!localContent.name) {
            localContent.name = encrypted.name || this.fileNameOf(sourceFile)
        }
        if (!localContent.size) {
            localContent.size = encrypted.original?.size || (sourceFile as any).size || 0
        }
        localContent.e2eeMedia = {
            version: encrypted.version,
            mediaKind: encrypted.mediaKind,
            originalContentType: encrypted.originalContentType,
            name: encrypted.name,
            original: encrypted.original,
            thumb: encrypted.thumb,
            displayUrl,
        }
        content.file = undefined
    }

    private localDisplayUrlFor(encrypted: MessageEncryptedMedia, sourceFile: File): string {
        if (!encrypted.thumb) {
            return ""
        }
        return this.createObjectURL(sourceFile as any as Blob)
    }

    public async restoreContent(content: MessageEncryptedMedia): Promise<MessageContent> {
        if (this.shouldDeferOriginal(content)) {
            return this.restoreDeferredOriginal(content)
        }
        const displayPart = content.thumb || content.original
        const displayBlob = displayPart === content.thumb
            ? await this.decryptCachedThumbnailPart(content, displayPart)
            : await this.decryptPart(displayPart)
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
            name: content.name,
            original: content.original,
            thumb: content.thumb,
            displayUrl,
        }
        return restored
    }

    private shouldDeferOriginal(content: MessageEncryptedMedia): boolean {
        if (content.thumb) {
            return false
        }
        const kind = (content.mediaKind || "").toLowerCase()
        return kind === "media" || kind === "file" || kind === "video" || kind === "audio"
    }

    private restoreDeferredOriginal(content: MessageEncryptedMedia): MessageContent {
        const restored = MessageContentManager.shared().getMessageContent(content.originalContentType)
        const payload: any = {
            type: content.originalContentType,
            url: "",
            width: content.original?.width || 0,
            height: content.original?.height || 0,
            name: content.name || "",
            size: content.original?.size || 0,
        }
        restored.decode(this.stringToUint8Array(JSON.stringify(payload)))
        ;(restored as any).e2eeMedia = {
            version: content.version,
            mediaKind: content.mediaKind,
            originalContentType: content.originalContentType,
            name: content.name,
            original: content.original,
            thumb: content.thumb,
        }
        return restored
    }

    public async loadOriginal(content: MessageContent | any, options?: SaveOriginalOptions): Promise<string | undefined> {
        const media = content && content.e2eeMedia
        if (!media || !media.original) {
            return undefined
        }
        if (media.originalBlobUrl) {
            const totalBytes = Number(media.original.size || 0)
            this.emitProgress(options && options.onProgress, {
                loadedBytes: totalBytes,
                totalBytes,
                chunkIndex: 0,
                chunkCount: this.isChunkedPart(media.original) ? media.original.chunks.length : 1,
                phase: "writing",
            })
            return media.originalBlobUrl
        }
        const blob = this.isChunkedPart(media.original)
            ? await this.decryptChunkedPart(media.original, options)
            : await this.loadSingleOriginal(media.original, options)
        this.revokeBlobURL(media.originalBlobUrl)
        media.originalBlobUrl = this.createObjectURL(blob)
        return media.originalBlobUrl
    }

    public async loadOriginalBlob(content: MessageContent | any, options?: SaveOriginalOptions): Promise<Blob | undefined> {
        const media = content && content.e2eeMedia
        if (!media || !media.original) {
            return undefined
        }
        return this.decryptOriginalPart(media.original, options)
    }

    public async loadThumbnail(content: MessageContent | any): Promise<string | undefined> {
        const media = content && content.e2eeMedia
        if (!media) {
            return undefined
        }
        if (media.displayUrl) {
            return media.displayUrl
        }
        if (media.thumb) {
            const blob = await this.decryptCachedThumbnailPart(media as MessageEncryptedMedia, media.thumb)
            this.revokeBlobURL(media.displayUrl)
            media.displayUrl = this.createObjectURL(blob)
            return media.displayUrl
        }
        return this.loadOriginal(content)
    }

    public async saveOriginal(content: MessageContent | any, fileName?: string, options?: SaveOriginalOptions): Promise<boolean> {
        const media = content && content.e2eeMedia
        if (!media || !media.original) {
            return false
        }
        const picker = (globalThis as any).showSaveFilePicker
        if (typeof picker !== "function") {
            return false
        }
        const handle = await picker({
            suggestedName: fileName || content.name || "file",
        })
        const writable = await handle.createWritable()
        try {
            if (!this.isChunkedPart(media.original)) {
                await this.saveSingleOriginal(media.original, writable, options)
                return true
            }
            const blob = await this.decryptChunkedPart(media.original, options)
            await writable.write(blob)
            await writable.close()
            this.emitProgress(options && options.onProgress, {
                loadedBytes: blob.size,
                totalBytes: blob.size,
                chunkIndex: Math.max(0, media.original.chunks.length - 1),
                chunkCount: media.original.chunks.length,
                phase: "writing",
            })
            return true
        } catch (error) {
            try {
                await writable.abort()
            } catch (_abortError) {
                // The original download/decrypt error is more useful to the caller.
            }
            throw error
        }
    }

    public async clearLocalData(): Promise<void> {
        const scope = this.cacheScope ? this.cacheScope() : {}
        if (!scope.uid || scope.deviceId === undefined || scope.deviceId === null) {
            return
        }
        const prefix = `wk_e2ee_media_thumb:${scope.uid}:${String(scope.deviceId)}:`
        await E2EECacheStore.shared().clearPrefix(E2EE_CACHE_STORES.THUMBNAILS, prefix)
    }

    private emitProgress(callback: ((progress: E2EEMediaProgress) => void) | undefined, progress: {
        loadedBytes: number
        totalBytes: number
        chunkIndex?: number
        chunkCount?: number
        phase: E2EEMediaProgressPhase
    }): void {
        if (!callback) {
            return
        }
        const totalBytes = Math.max(0, Number(progress.totalBytes || 0))
        const rawLoaded = Math.max(0, Number(progress.loadedBytes || 0))
        const loadedBytes = totalBytes > 0 ? Math.min(totalBytes, rawLoaded) : rawLoaded
        const percent = totalBytes > 0 ? Math.max(0, Math.min(100, Math.floor((loadedBytes / totalBytes) * 100))) : 0
        callback({
            loadedBytes,
            totalBytes,
            percent,
            chunkIndex: progress.chunkIndex,
            chunkCount: progress.chunkCount,
            phase: progress.phase,
        })
    }

    private async saveSingleOriginal(part: MediaPart, writable: any, options?: SaveOriginalOptions): Promise<void> {
        const totalBytes = Number(part.size || 0)
        this.emitProgress(options && options.onProgress, {
            loadedBytes: 0,
            totalBytes,
            chunkIndex: 0,
            chunkCount: 1,
            phase: "downloading",
        })
        const blob = await this.decryptPart(part, (event: any) => {
            const total = Number(event && event.total ? event.total : part.size || 0)
            const loaded = Math.max(0, Number(event && event.loaded ? event.loaded : 0))
            const scaledLoaded = total > 0 && totalBytes > 0 ? Math.floor((Math.min(total, loaded) / total) * totalBytes) : Math.min(totalBytes || loaded, loaded)
            this.emitProgress(options && options.onProgress, {
                loadedBytes: scaledLoaded,
                totalBytes,
                chunkIndex: 0,
                chunkCount: 1,
                phase: "downloading",
            })
        })
        this.emitProgress(options && options.onProgress, {
            loadedBytes: totalBytes,
            totalBytes,
            chunkIndex: 0,
            chunkCount: 1,
            phase: "decrypting",
        })
        await writable.write(blob)
        this.emitProgress(options && options.onProgress, {
            loadedBytes: totalBytes || blob.size,
            totalBytes: totalBytes || blob.size,
            chunkIndex: 0,
            chunkCount: 1,
            phase: "writing",
        })
        await writable.close()
    }

    private async decryptOriginalPart(part: MediaPart | ChunkedMediaPart, options?: SaveOriginalOptions): Promise<Blob> {
        return this.isChunkedPart(part)
            ? this.decryptChunkedPart(part, options)
            : this.loadSingleOriginal(part, options)
    }

    private async loadSingleOriginal(part: MediaPart, options?: SaveOriginalOptions): Promise<Blob> {
        const totalBytes = Number(part.size || 0)
        this.emitProgress(options && options.onProgress, {
            loadedBytes: 0,
            totalBytes,
            chunkIndex: 0,
            chunkCount: 1,
            phase: "downloading",
        })
        const blob = await this.decryptPart(part, (event: any) => {
            const total = Number(event && event.total ? event.total : part.size || 0)
            const loaded = Math.max(0, Number(event && event.loaded ? event.loaded : 0))
            const scaledLoaded = total > 0 && totalBytes > 0 ? Math.floor((Math.min(total, loaded) / total) * totalBytes) : Math.min(totalBytes || loaded, loaded)
            this.emitProgress(options && options.onProgress, {
                loadedBytes: scaledLoaded,
                totalBytes,
                chunkIndex: 0,
                chunkCount: 1,
                phase: "downloading",
            })
        })
        const finalBytes = totalBytes || blob.size
        this.emitProgress(options && options.onProgress, {
            loadedBytes: finalBytes,
            totalBytes: finalBytes,
            chunkIndex: 0,
            chunkCount: 1,
            phase: "writing",
        })
        return blob
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

    private async encryptSingleOriginalPart(
        originalBlob: Blob,
        channel: Channel,
        content: MediaMessageContent,
        sourceFile: File,
        fileMD5: string,
        onUploadProgress?: (progress: E2EEMediaProgress) => void,
    ): Promise<MediaPart> {
        const originalEncrypted = await this.encryptBlob(originalBlob)
        const originalUrl = await this.uploadEncryptedBlob(originalEncrypted.blob, channel, "original", content.contentType, this.fileNameOf(sourceFile), originalBlob.type, (event: any) => {
            const total = Number(event && event.total ? event.total : originalEncrypted.blob.size)
            const loaded = Math.max(0, Number(event && event.loaded ? event.loaded : 0))
            const scaledLoaded = total > 0 ? Math.floor((Math.min(total, loaded) / total) * originalBlob.size) : Math.min(originalBlob.size, loaded)
            this.emitProgress(onUploadProgress, {
                loadedBytes: scaledLoaded,
                totalBytes: originalBlob.size,
                chunkIndex: 0,
                chunkCount: 1,
                phase: "uploading",
            })
        })
        return {
            url: originalUrl,
            key: originalEncrypted.key,
            nonce: originalEncrypted.nonce,
            sha256: originalEncrypted.sha256,
            file_md5: fileMD5,
            width: (content as any).width || 0,
            height: (content as any).height || 0,
            mime: originalBlob.type || "application/octet-stream",
            size: originalBlob.size || 0,
        }
    }

    private async encryptChunkedBlob(
        blob: Blob,
        channel: Channel,
        contentType: number,
        fileName: string,
        mime?: string,
        fileMD5?: string,
        onUploadProgress?: (progress: E2EEMediaProgress) => void,
    ): Promise<ChunkedMediaPart> {
        const chunkSize = this.chunkSize
        const chunkCount = Math.max(1, Math.ceil(blob.size / chunkSize))
        const plaintextSha256 = await this.sha256(blob)
        const sessionId = await this.createChunkedUploadSession(channel, contentType, fileName, mime, blob.size, chunkSize, chunkCount)
        const chunks: ChunkedMediaPart["chunks"] = []
        let uploadedBytes = 0
        for (let index = 0; index < chunkCount; index++) {
            const offset = index * chunkSize
            const plainChunk = blob.slice(offset, Math.min(offset + chunkSize, blob.size), mime || blob.type || "application/octet-stream")
            const encrypted = await this.encryptBlob(plainChunk)
            const uploadedBytesBeforeChunk = uploadedBytes
            const uploaded = await this.uploadEncryptedChunk(encrypted.blob, {
                channel,
                sessionId,
                chunkIndex: index,
                chunkCount,
                offset,
                plainSize: plainChunk.size,
                contentType,
                fileName,
                mime,
                onUploadProgress: (event: any) => {
                    const total = Number(event && event.total ? event.total : encrypted.blob.size)
                    const loaded = Math.max(0, Number(event && event.loaded ? event.loaded : 0))
                    const scaledLoaded = total > 0 ? Math.floor((Math.min(total, loaded) / total) * plainChunk.size) : Math.min(plainChunk.size, loaded)
                    this.emitProgress(onUploadProgress, {
                        loadedBytes: uploadedBytesBeforeChunk + scaledLoaded,
                        totalBytes: blob.size,
                        chunkIndex: index,
                        chunkCount,
                        phase: "uploading",
                    })
                },
            })
            chunks.push({
                index,
                offset,
                plain_size: plainChunk.size,
                encrypted_size: uploaded.size || encrypted.blob.size,
                etag: uploaded.etag,
                url: uploaded.url,
                key: encrypted.key,
                nonce: encrypted.nonce,
                sha256: encrypted.sha256,
                mime: "application/octet-stream",
                size: encrypted.blob.size,
            })
            uploadedBytes += plainChunk.size
            this.emitProgress(onUploadProgress, {
                loadedBytes: uploadedBytes,
                totalBytes: blob.size,
                chunkIndex: index,
                chunkCount,
                phase: "uploading",
            })
        }
        await this.completeChunkedUpload(channel, sessionId, chunks, contentType, fileName, mime, blob.size)
        return {
            mode: "chunked",
            session_id: sessionId,
            chunk_size: chunkSize,
            size: blob.size,
            file_md5: fileMD5,
            mime: mime || blob.type || "application/octet-stream",
            sha256: plaintextSha256,
            chunk_count: chunkCount,
            chunks,
        }
    }

    private async decryptChunkedPart(part: ChunkedMediaPart, options?: SaveOriginalOptions): Promise<Blob> {
        if (!part || part.mode !== "chunked" || !Array.isArray(part.chunks) || part.chunks.length === 0) {
            throw new Error("Invalid E2EE chunked media part")
        }
        const sorted = this.validateChunkedPart(part)
        const pieces: Blob[] = []
        const totalBytes = Number(part.size || sorted.reduce((sum: number, chunk: any) => sum + Number(chunk.plain_size || 0), 0))
        let downloadedBytes = 0
        this.emitProgress(options && options.onProgress, {
            loadedBytes: 0,
            totalBytes,
            chunkIndex: 0,
            chunkCount: sorted.length,
            phase: "downloading",
        })
        for (const chunk of sorted) {
            this.emitProgress(options && options.onProgress, {
                loadedBytes: downloadedBytes,
                totalBytes,
                chunkIndex: Number(chunk.index || 0),
                chunkCount: sorted.length,
                phase: "downloading",
            })
            const blob = await this.decryptPart(chunk, (event: any) => {
                const total = Number(event && event.total ? event.total : chunk.size || chunk.encrypted_size || chunk.plain_size || 0)
                const loaded = Math.max(0, Number(event && event.loaded ? event.loaded : 0))
                const plainSize = Number(chunk.plain_size || 0)
                const scaledLoaded = total > 0 && plainSize > 0 ? Math.floor((Math.min(total, loaded) / total) * plainSize) : Math.min(plainSize || loaded, loaded)
                this.emitProgress(options && options.onProgress, {
                    loadedBytes: downloadedBytes + scaledLoaded,
                    totalBytes,
                    chunkIndex: Number(chunk.index || 0),
                    chunkCount: sorted.length,
                    phase: "downloading",
                })
            })
            pieces.push(blob)
            downloadedBytes += Number(chunk.plain_size || blob.size || 0)
            this.emitProgress(options && options.onProgress, {
                loadedBytes: downloadedBytes,
                totalBytes,
                chunkIndex: Number(chunk.index || 0),
                chunkCount: sorted.length,
                phase: "decrypting",
            })
        }
        const blob = new Blob(pieces, { type: part.mime || "application/octet-stream" })
        const actualHash = await this.sha256(blob)
        if (actualHash !== part.sha256) {
            throw new Error("E2EE chunked media hash mismatch")
        }
        this.emitProgress(options && options.onProgress, {
            loadedBytes: totalBytes || blob.size,
            totalBytes: totalBytes || blob.size,
            chunkIndex: Math.max(0, sorted.length - 1),
            chunkCount: sorted.length,
            phase: "writing",
        })
        return blob
    }

    private validateChunkedPart(part: ChunkedMediaPart): ChunkedMediaPart["chunks"] {
        if (!part.sha256) {
            throw new Error("E2EE chunked media sha256 is missing")
        }
        const expectedCount = Number(part.chunk_count || 0)
        if (!Number.isFinite(expectedCount) || expectedCount <= 0) {
            throw new Error("E2EE chunked media chunk_count is invalid")
        }
        if (part.chunks.length !== expectedCount) {
            throw new Error("E2EE chunked media chunk count mismatch")
        }
        const sorted = part.chunks.slice().sort((a, b) => Number(a.index || 0) - Number(b.index || 0))
        let expectedOffset = 0
        for (let i = 0; i < sorted.length; i++) {
            const chunk = sorted[i]
            const index = Number(chunk.index)
            if (index !== i) {
                throw new Error("E2EE chunked media chunk index is not continuous")
            }
            const offset = Number(chunk.offset)
            if (!Number.isFinite(offset) || offset !== expectedOffset) {
                throw new Error("E2EE chunked media chunk offset is not continuous")
            }
            const plainSize = Number(chunk.plain_size || 0)
            if (!Number.isFinite(plainSize) || plainSize < 0) {
                throw new Error("E2EE chunked media chunk size is invalid")
            }
            expectedOffset += plainSize
        }
        const expectedSize = Number(part.size || expectedOffset)
        if (Number.isFinite(expectedSize) && expectedSize >= 0 && expectedOffset !== expectedSize) {
            throw new Error("E2EE chunked media total size mismatch")
        }
        return sorted
    }

    private isChunkedPart(part: any): part is ChunkedMediaPart {
        return !!(part && part.mode === "chunked" && Array.isArray(part.chunks))
    }

    private revokeBlobURL(url?: string): void {
        if (!url || url.indexOf("blob:") !== 0) {
            return
        }
        try {
            URL.revokeObjectURL(url)
        } catch (_error) {
        }
    }

    private async decryptPart(part: MediaPart, onDownloadProgress?: (event: any) => void): Promise<Blob> {
        if (!part || !part.url || !part.key || !part.nonce) {
            throw new Error("Invalid E2EE media part")
        }
        this.assertInlineDecryptAllowed(part)
        const encrypted = await this.fetchEncryptedBlob(part.url, onDownloadProgress)
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

    private assertInlineDecryptAllowed(part: MediaPart): void {
        if (this.isChunkedPart(part)) {
            return
        }
        const size = Number(part && part.size ? part.size : 0)
        if (size > E2EE_MAX_INLINE_DECRYPT_BYTES) {
            throw new Error(`E2EE media is too large for inline decrypt: ${size}`)
        }
    }

    private async decryptCachedThumbnailPart(content: MessageEncryptedMedia, part: MediaPart): Promise<Blob> {
        const cached = await this.restoreThumbnailCache(content, part)
        if (cached) {
            return cached
        }
        const blob = await this.decryptPart(part)
        await this.saveThumbnailCache(content, part, blob)
        return blob
    }

    private async restoreThumbnailCache(content: MessageEncryptedMedia, part: MediaPart): Promise<Blob | undefined> {
        const key = this.thumbnailCacheKey(content, part)
        if (!key) {
            return undefined
        }
        try {
            const raw = await E2EECacheStore.shared().get(E2EE_CACHE_STORES.THUMBNAILS, key)
            if (!raw) {
                return undefined
            }
            const data = typeof raw === "string" ? JSON.parse(raw) : raw
            if (!data || data.sha256 !== part.sha256) {
                await E2EECacheStore.shared().delete(E2EE_CACHE_STORES.THUMBNAILS, key)
                return undefined
            }
            if (data.blob instanceof Blob) {
                return data.blob
            }
            if (typeof data.bytes !== "string") {
                await E2EECacheStore.shared().delete(E2EE_CACHE_STORES.THUMBNAILS, key)
                return undefined
            }
            const bytes = this.base64Decode(data.bytes)
            const blob = new Blob([bytes], { type: data.mime || part.mime || "application/octet-stream" })
            await E2EECacheStore.shared().set(E2EE_CACHE_STORES.THUMBNAILS, key, {
                sha256: data.sha256,
                mime: blob.type,
                blob,
                cachedAt: data.cachedAt || Date.now(),
            })
            return blob
        } catch (_error) {
            await E2EECacheStore.shared().delete(E2EE_CACHE_STORES.THUMBNAILS, key)
            return undefined
        }
    }

    private async saveThumbnailCache(content: MessageEncryptedMedia, part: MediaPart, blob: Blob): Promise<void> {
        const key = this.thumbnailCacheKey(content, part)
        if (!key) {
            return
        }
        try {
            await E2EECacheStore.shared().set(E2EE_CACHE_STORES.THUMBNAILS, key, {
                sha256: part.sha256,
                mime: blob.type || part.mime || "application/octet-stream",
                blob,
                cachedAt: Date.now(),
            })
        } catch (_error) {
            // Thumbnail cache is best-effort; display must continue from the decrypted blob.
        }
    }

    private thumbnailCacheKey(content: MessageEncryptedMedia, part: MediaPart): string {
        if (!part || !part.sha256) {
            return ""
        }
        const scope = this.cacheScope ? this.cacheScope() : {}
        const uid = scope.uid || "anonymous"
        const deviceId = scope.deviceId === undefined || scope.deviceId === null ? "unknown-device" : String(scope.deviceId)
        const mediaIdentity = `${content.originalContentType || ""}:${content.mediaKind || ""}:${part.url || ""}:${part.sha256}`
        return `wk_e2ee_media_thumb:${uid}:${deviceId}:${this.hashString(mediaIdentity)}`
    }

    private async uploadEncryptedBlob(
        blob: Blob,
        channel: Channel,
        kind: "original" | "thumb",
        contentType: number,
        fileName: string,
        mime?: string,
        onUploadProgress?: (event: any) => void,
    ): Promise<string> {
        if (this.provider && this.provider.uploadEncryptedMedia) {
            return this.provider.uploadEncryptedMedia(blob, { channel, kind, contentType, fileName, mime })
        }
        if (!this.apiClient || typeof this.apiClient.get !== "function") {
            throw new Error("E2EE media upload provider is unavailable")
        }
        const path = this.buildUploadPath(channel, kind, fileName)
        const result = await this.apiClient.get(`file/upload?path=${encodeURIComponent(path)}&type=chat`)
        const uploadURL = result && result.url
        if (!uploadURL) {
            throw new Error("E2EE media upload URL is unavailable")
        }
        const form = new FormData()
        form.append("file", blob, `${kind}.e2ee`)
        if (onUploadProgress && typeof XMLHttpRequest !== "undefined") {
            return this.uploadEncryptedBlobWithXHR(uploadURL, form, onUploadProgress)
        }
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

    private uploadEncryptedBlobWithXHR(uploadURL: string, form: FormData, onUploadProgress: (event: any) => void): Promise<string> {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest()
            xhr.open("POST", uploadURL)
            const headers = this.buildUploadHeaders()
            Object.keys(headers).forEach((key) => {
                xhr.setRequestHeader(key, (headers as any)[key])
            })
            xhr.upload.onprogress = (event) => {
                onUploadProgress({
                    loaded: event.loaded,
                    total: event.total,
                })
            }
            xhr.onerror = () => reject(new Error("E2EE media upload failed"))
            xhr.onload = () => {
                if (xhr.status < 200 || xhr.status >= 300) {
                    reject(new Error(`E2EE media upload failed: ${xhr.status}`))
                    return
                }
                try {
                    const data = JSON.parse(xhr.responseText || "{}")
                    if (!data || !data.path) {
                        reject(new Error("E2EE media upload response missing path"))
                        return
                    }
                    resolve(data.path)
                } catch (error) {
                    reject(error)
                }
            }
            xhr.send(form)
        })
    }

    private async createChunkedUploadSession(
        channel: Channel,
        contentType: number,
        fileName: string,
        mime: string | undefined,
        size: number,
        chunkSize: number,
        chunkCount: number,
    ): Promise<string> {
        const context = { channel, contentType, fileName, mime, size, chunkSize, chunkCount }
        if (this.provider && this.provider.createEncryptedMediaUploadSession) {
            const result = await this.provider.createEncryptedMediaUploadSession(context)
            const sessionId = result && (result.session_id || result.sessionId)
            if (sessionId) {
                return sessionId
            }
        }
        if (!this.apiClient || typeof this.apiClient.post !== "function") {
            throw new Error("E2EE chunked media upload session provider is unavailable")
        }
        const result = await this.apiClient.post("file/e2ee/chunked/sessions", {
            channel_id: channel.channelID,
            channel_type: channel.channelType,
            content_type: contentType,
            file_name: fileName,
            mime,
            size,
            chunk_size: chunkSize,
            chunk_count: chunkCount,
        })
        const sessionId = result && (result.session_id || result.sessionId)
        if (!sessionId) {
            throw new Error("E2EE chunked media upload session response missing session_id")
        }
        return sessionId
    }

    private async uploadEncryptedChunk(blob: Blob, context: {
        channel: Channel
        sessionId: string
        chunkIndex: number
        chunkCount: number
        offset: number
        plainSize: number
        contentType: number
        fileName?: string
        mime?: string
        onUploadProgress?: (event: any) => void
    }): Promise<{ url: string; size?: number; etag?: string }> {
        if (this.provider && this.provider.uploadEncryptedMediaChunk) {
            return this.provider.uploadEncryptedMediaChunk(blob, context)
        }
        if (!this.apiClient || typeof (this.apiClient as any).put !== "function") {
            throw new Error("E2EE chunked media upload provider is unavailable")
        }
        const form = new FormData()
        form.append("file", blob, `${context.chunkIndex}.e2ee`)
        const result = await (this.apiClient as any).put(`file/e2ee/chunked/sessions/${context.sessionId}/chunks/${context.chunkIndex}`, form, {
            headers: this.buildUploadHeaders(),
            onUploadProgress: (event: any) => {
                if (context.onUploadProgress) {
                    context.onUploadProgress(event)
                }
            },
        })
        if (!result || !result.url) {
            throw new Error("E2EE chunked media upload response missing url")
        }
        return result
    }

    private async completeChunkedUpload(
        channel: Channel,
        sessionId: string,
        chunks: any[],
        contentType: number,
        fileName: string,
        mime: string | undefined,
        size: number,
    ): Promise<void> {
        const context = { channel, sessionId, chunks, contentType, fileName, mime, size }
        if (this.provider && this.provider.completeEncryptedMediaUpload) {
            await this.provider.completeEncryptedMediaUpload(context)
            return
        }
        if (this.apiClient && typeof this.apiClient.post === "function") {
            await this.apiClient.post(`file/e2ee/chunked/sessions/${sessionId}/complete`, {
                chunks,
                size,
            })
        }
    }

    private async fetchEncryptedBlob(url: string, onDownloadProgress?: (event: any) => void): Promise<Blob> {
        if (this.provider && this.provider.fetchEncryptedMedia) {
            const blob = await this.provider.fetchEncryptedMedia(url, { onDownloadProgress })
            const blobType = blob && blob.type ? blob.type : ""
            if (blobType.indexOf("application/json") >= 0) {
                try {
                    const data = JSON.parse(await blob.text())
                    const unwrapped = await this.unwrapServerEncryptedBlob(data)
                    if (unwrapped) {
                        return unwrapped
                    }
                } catch (_error) {
                }
            }
            return blob
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
        if (!onDownloadProgress || !resp.body || typeof resp.body.getReader !== "function") {
            const blob = await resp.blob()
            if (onDownloadProgress) {
                onDownloadProgress({
                    loaded: blob.size,
                    total: blob.size,
                })
            }
            return blob
        }
        const contentLength = Number(resp.headers && resp.headers.get ? resp.headers.get("content-length") || 0 : 0)
        const reader = resp.body.getReader()
        const chunks: Uint8Array[] = []
        let loaded = 0
        while (true) {
            const result = await reader.read()
            if (result.done) {
                break
            }
            const value = result.value
            if (value) {
                chunks.push(value)
                loaded += value.byteLength
                onDownloadProgress({
                    loaded,
                    total: contentLength || loaded,
                })
            }
        }
        return new Blob(chunks, { type: contentType || "application/octet-stream" })
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
        return `${channel.channelType}/${channel.channelID}/${this.uuid()}-${kind}${suffix}`
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
        const hasher = (CryptoJS as any).algo.SHA256.create()
        const chunkSize = Math.max(1, this.chunkSize || E2EE_DEFAULT_CHUNK_SIZE)
        for (let offset = 0; offset < blob.size; offset += chunkSize) {
            const chunk = blob.slice(offset, Math.min(offset + chunkSize, blob.size))
            const bytes = new Uint8Array(await chunk.arrayBuffer())
            hasher.update(this.bytesToWordArray(bytes))
        }
        const base64 = hasher.finalize().toString((CryptoJS as any).enc.Base64)
        return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
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

    private base64Encode(bytes: Uint8Array): string {
        let binary = ""
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i])
        }
        return typeof btoa === "function"
            ? btoa(binary)
            : (Buffer as any).from(binary, "binary").toString("base64")
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

    private cloneJSON<T>(value: T): T {
        return value === undefined || value === null
            ? value
            : JSON.parse(JSON.stringify(value))
    }

    private async md5(blob: Blob): Promise<string> {
        const hasher = (CryptoJS as any).algo.MD5.create()
        const chunkSize = Math.max(1, this.chunkSize || E2EE_DEFAULT_CHUNK_SIZE)
        for (let offset = 0; offset < blob.size; offset += chunkSize) {
            const chunk = blob.slice(offset, Math.min(offset + chunkSize, blob.size))
            const bytes = new Uint8Array(await chunk.arrayBuffer())
            hasher.update(this.bytesToWordArray(bytes))
        }
        return hasher.finalize().toString()
    }

    private bytesToWordArray(bytes: Uint8Array): any {
        const words: number[] = []
        for (let i = 0; i < bytes.length; i++) {
            words[i >>> 2] |= bytes[i] << (24 - (i % 4) * 8)
        }
        return (CryptoJS as any).lib.WordArray.create(words, bytes.length)
    }

    private hashString(value: string): string {
        let hash = 0
        for (let i = 0; i < value.length; i++) {
            hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0
        }
        return String(hash >>> 0)
    }
}
