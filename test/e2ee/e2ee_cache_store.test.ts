import { strict as assert } from "assert"
import { indexedDB as fakeIndexedDB } from "fake-indexeddb"
import { E2EECacheStore, E2EE_CACHE_STORES } from "../../src/e2ee/e2ee_cache_store"

declare const test: (name: string, fn: () => Promise<void> | void) => void

async function closeCacheStore(): Promise<void> {
    const current: any = (E2EECacheStore as any).instance
    if (current?.dbPromise) {
        const db = await current.dbPromise
        db?.close()
    }
    ;(E2EECacheStore as any).instance = undefined
}

async function resetCacheStore(): Promise<void> {
    await closeCacheStore()
    await new Promise<void>((resolve, reject) => {
        const request = fakeIndexedDB.deleteDatabase("wk_e2ee_cache")
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
        request.onblocked = () => reject(new Error("test database deletion was blocked"))
    })
}

test("E2EE cache migrates legacy envelope-missing entries into IndexedDB", async () => {
    const originalIndexedDB = (global as any).indexedDB
    const originalLocalStorage = (global as any).localStorage
    const legacy = new Map<string, string>()
    ;(global as any).indexedDB = fakeIndexedDB
    ;(global as any).localStorage = {
        getItem: (key: string) => legacy.get(key) || null,
        setItem: (key: string, value: string) => legacy.set(key, value),
        removeItem: (key: string) => legacy.delete(key),
        key: (index: number) => Array.from(legacy.keys())[index] || null,
        get length() { return legacy.size },
    }
    const key = "e2ee_sender_key_envelope_missing:bob:bob-web:legacy"
    const value = JSON.stringify({ expiresAt: Date.now() + 60000 })
    legacy.set(key, value)

    try {
        await resetCacheStore()
        const store = E2EECacheStore.shared()
        assert.equal(await store.get(E2EE_CACHE_STORES.ENVELOPE_MISSING, key), value)
        assert.equal(legacy.has(key), false)

        await closeCacheStore()
        assert.equal(await E2EECacheStore.shared().get(E2EE_CACHE_STORES.ENVELOPE_MISSING, key), value)
    } finally {
        await resetCacheStore()
        ;(global as any).indexedDB = originalIndexedDB
        ;(global as any).localStorage = originalLocalStorage
    }
})

test("E2EE cache removes expired and over-limit envelope-missing entries in batches", async () => {
    const originalIndexedDB = (global as any).indexedDB
    ;(global as any).indexedDB = fakeIndexedDB
    try {
        await resetCacheStore()
        const store = E2EECacheStore.shared()
        const now = Date.now()
        await store.set(E2EE_CACHE_STORES.ENVELOPE_MISSING, "expired", { expiresAt: now - 1 })
        await store.set(E2EE_CACHE_STORES.ENVELOPE_MISSING, "active-1", { expiresAt: now + 1000 })
        await store.set(E2EE_CACHE_STORES.ENVELOPE_MISSING, "active-2", { expiresAt: now + 2000 })
        await store.set(E2EE_CACHE_STORES.ENVELOPE_MISSING, "active-3", { expiresAt: now + 3000 })

        const hasMore = await store.pruneExpiringEntries(E2EE_CACHE_STORES.ENVELOPE_MISSING, 2, 10)
        assert.equal(hasMore, false)
        assert.equal(await store.get(E2EE_CACHE_STORES.ENVELOPE_MISSING, "expired"), undefined)
        assert.equal(await store.get(E2EE_CACHE_STORES.ENVELOPE_MISSING, "active-1"), undefined)
        assert.deepEqual(await store.get(E2EE_CACHE_STORES.ENVELOPE_MISSING, "active-2"), { expiresAt: now + 2000 })
        assert.deepEqual(await store.get(E2EE_CACHE_STORES.ENVELOPE_MISSING, "active-3"), { expiresAt: now + 3000 })
    } finally {
        await resetCacheStore()
        ;(global as any).indexedDB = originalIndexedDB
    }
})
