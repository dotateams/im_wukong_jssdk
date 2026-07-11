const E2EE_CACHE_DB_NAME = "wk_e2ee_cache"
const E2EE_CACHE_DB_VERSION = 2

export const E2EE_CACHE_STORES = {
    PLAINTEXT: "plaintext",
    THUMBNAILS: "thumbnails",
    CHANNEL_DEVICES: "channelDevices",
    ENVELOPE_MISSING: "envelopeMissing",
}

export class E2EECacheStore {
    private dbPromise?: Promise<IDBDatabase | undefined>

    private static instance: E2EECacheStore

    public static shared(): E2EECacheStore {
        if (!this.instance) {
            this.instance = new E2EECacheStore()
        }
        return this.instance
    }

    public async get(storeName: string, key: string): Promise<any> {
        const db = await this.open()
        if (db) {
            const value = await this.request(db, storeName, "readonly", store => store.get(key))
            if (value !== undefined) {
                return value
            }
        }
        return await this.migrateLegacyKey(storeName, key)
    }

    public async set(storeName: string, key: string, value: any): Promise<void> {
        const db = await this.open()
        if (db) {
            await this.request(db, storeName, "readwrite", store => store.put(value, key))
            this.removeLegacyKey(key)
            return
        }
        this.writeLegacyKey(key, await this.serializeLegacyValue(value))
    }

    public async delete(storeName: string, key: string): Promise<void> {
        const db = await this.open()
        if (db) {
            await this.request(db, storeName, "readwrite", store => store.delete(key))
        }
        this.removeLegacyKey(key)
    }

    public async clearPrefix(storeName: string, prefix: string): Promise<void> {
        const db = await this.open()
        if (db) {
            const keys: any[] = await this.request(db, storeName, "readonly", store => store.getAllKeys()) || []
            const matching = keys.filter(key => String(key).indexOf(prefix) === 0)
            if (matching.length > 0) {
                await this.transaction(db, storeName, "readwrite", store => {
                    matching.forEach(key => store.delete(key))
                })
            }
        }
        this.removeLegacyPrefix(prefix)
    }

    public scheduleLegacyMigration(storeName: string, prefix: string): void {
        const keys = this.legacyKeys(prefix)
        if (keys.length === 0) {
            return
        }
        const runBatch = async (offset: number) => {
            const end = Math.min(offset + 25, keys.length)
            for (let i = offset; i < end; i++) {
                await this.migrateLegacyKey(storeName, keys[i])
            }
            if (end < keys.length) {
                setTimeout(() => { runBatch(end).catch(() => undefined) }, 0)
            }
        }
        setTimeout(() => { runBatch(0).catch(() => undefined) }, 0)
    }

    public async pruneExpiringEntries(storeName: string, maxEntries: number, batchSize = 250): Promise<boolean> {
        const db = await this.open()
        if (!db) {
            return false
        }
        const entries: { key: IDBValidKey; expiresAt: number }[] = []
        await new Promise<void>((resolve, reject) => {
            try {
                const transaction = db.transaction(storeName, "readonly")
                const request = transaction.objectStore(storeName).openCursor()
                request.onsuccess = () => {
                    const cursor = request.result
                    if (!cursor) {
                        resolve()
                        return
                    }
                    const parsed = this.parseExpiringValue(cursor.value)
                    entries.push({ key: cursor.key, expiresAt: Number(parsed?.expiresAt || 0) })
                    cursor.continue()
                }
                request.onerror = () => reject(request.error)
                transaction.onabort = () => reject(transaction.error)
            } catch (error) {
                reject(error)
            }
        })

        const now = Date.now()
        const expired = entries.filter(entry => entry.expiresAt <= now)
        const active = entries.filter(entry => entry.expiresAt > now).sort((a, b) => a.expiresAt - b.expiresAt)
        const overflow = active.slice(0, Math.max(0, active.length - Math.max(0, maxEntries)))
        const deletions = expired.concat(overflow).slice(0, Math.max(1, batchSize))
        if (deletions.length > 0) {
            await this.transaction(db, storeName, "readwrite", store => {
                deletions.forEach(entry => store.delete(entry.key))
            })
        }
        return expired.length + overflow.length > deletions.length
    }

    private async migrateLegacyKey(storeName: string, key: string): Promise<any> {
        const raw = this.readLegacyKey(key)
        if (raw === undefined) {
            return undefined
        }
        const db = await this.open()
        if (!db) {
            return raw
        }
        await this.request(db, storeName, "readwrite", store => store.put(raw, key))
        this.removeLegacyKey(key)
        return raw
    }

    private open(): Promise<IDBDatabase | undefined> {
        if (this.dbPromise) {
            return this.dbPromise
        }
        this.dbPromise = new Promise(resolve => {
            if (typeof indexedDB === "undefined") {
                resolve(undefined)
                return
            }
            const request = indexedDB.open(E2EE_CACHE_DB_NAME, E2EE_CACHE_DB_VERSION)
            request.onupgradeneeded = () => {
                const db = request.result
                Object.keys(E2EE_CACHE_STORES).forEach(name => {
                    const storeName = (E2EE_CACHE_STORES as any)[name]
                    if (!db.objectStoreNames.contains(storeName)) {
                        db.createObjectStore(storeName)
                    }
                })
            }
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => resolve(undefined)
            request.onblocked = () => resolve(undefined)
        })
        return this.dbPromise
    }

    private request(db: IDBDatabase, storeName: string, mode: IDBTransactionMode, create: (store: IDBObjectStore) => IDBRequest): Promise<any> {
        return new Promise((resolve, reject) => {
            try {
                const transaction = db.transaction(storeName, mode)
                const request = create(transaction.objectStore(storeName))
                request.onsuccess = () => resolve(request.result)
                request.onerror = () => reject(request.error)
                transaction.onabort = () => reject(transaction.error)
            } catch (error) {
                reject(error)
            }
        })
    }

    private transaction(db: IDBDatabase, storeName: string, mode: IDBTransactionMode, apply: (store: IDBObjectStore) => void): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                const transaction = db.transaction(storeName, mode)
                apply(transaction.objectStore(storeName))
                transaction.oncomplete = () => resolve()
                transaction.onerror = () => reject(transaction.error)
                transaction.onabort = () => reject(transaction.error)
            } catch (error) {
                reject(error)
            }
        })
    }

    private readLegacyKey(key: string): string | undefined {
        for (const storage of this.legacyStorages()) {
            try {
                const value = storage.getItem(key)
                if (value !== null) {
                    return value
                }
            } catch (_error) {
                // Web Storage may be unavailable in restricted browser contexts.
            }
        }
        return undefined
    }

    private removeLegacyKey(key: string): void {
        this.legacyStorages().forEach(storage => {
            try { storage.removeItem(key) } catch (_error) { /* best-effort legacy cleanup */ }
        })
    }

    private writeLegacyKey(key: string, value: string): void {
        const storages = this.legacyStorages()
        storages.forEach(storage => {
            try { storage.setItem(key, value) } catch (_error) { /* non-browser fallback only */ }
        })
    }

    private async serializeLegacyValue(value: any): Promise<string> {
        if (typeof value === "string") {
            return value
        }
        if (value && value.blob instanceof Blob) {
            const bytes = new Uint8Array(await value.blob.arrayBuffer())
            let binary = ""
            // tslint:disable-next-line:prefer-for-of
            for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i])
            }
            const base64 = typeof btoa === "function"
                ? btoa(binary)
                : (globalThis as any).Buffer.from(binary, "binary").toString("base64")
            return JSON.stringify({ ...value, blob: undefined, bytes: base64 })
        }
        return JSON.stringify(value)
    }

    private parseExpiringValue(value: any): any {
        if (typeof value !== "string") {
            return value
        }
        try {
            return JSON.parse(value)
        } catch (_error) {
            return undefined
        }
    }

    private legacyKeys(prefix: string): string[] {
        const keys = new Set<string>()
        this.legacyStorages().forEach(storage => {
            try {
                for (let i = 0; i < storage.length; i++) {
                    const key = storage.key(i)
                    if (key && key.indexOf(prefix) === 0) {
                        keys.add(key)
                    }
                }
            } catch (_error) {
                // Ignore a legacy storage that cannot be enumerated.
            }
        })
        return Array.from(keys)
    }

    private removeLegacyPrefix(prefix: string): void {
        this.legacyKeys(prefix).forEach(key => this.removeLegacyKey(key))
    }

    private legacyStorages(): Storage[] {
        const storages: Storage[] = []
        for (const name of ["sessionStorage", "localStorage"]) {
            try {
                const storage = (globalThis as any)[name]
                if (storage) {
                    storages.push(storage)
                }
            } catch (_error) {
                // Web Storage may be unavailable in restricted browser contexts.
            }
        }
        return storages
    }
}
