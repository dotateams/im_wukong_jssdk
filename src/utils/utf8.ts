export function utf8BytesToString(data: Uint8Array): string {
    if (typeof TextDecoder !== "undefined") {
        return new TextDecoder().decode(data)
    }

    const chunkSize = 0x2000
    const parts: string[] = []
    for (let offset = 0; offset < data.length; offset += chunkSize) {
        const end = Math.min(offset + chunkSize, data.length)
        let encoded = ""
        for (let i = offset; i < end; i += 1) {
            encoded += String.fromCharCode(data[i])
        }
        parts.push(encoded)
    }
    return decodeURIComponent(escape(parts.join("")))
}
