const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { once } = require("events");
const { Blob } = require("buffer");

require("ts-node").register({
  transpileOnly: true,
  compilerOptions: {
    module: "commonjs",
    target: "es2018",
  },
});

const { E2EEMediaCrypto } = require("../src/e2ee/e2ee_media");
const { Channel, MediaMessageContent } = require("../src/model");

const MiB = 1024 * 1024;
const FILE_SIZE_MIB = Number(process.env.E2EE_SMOKE_FILE_MB || 512);
const CHUNK_SIZE = Number(process.env.E2EE_SMOKE_CHUNK_MB || 8) * MiB;
const TEST_ROOT = path.resolve(__dirname, "..", ".codex-logs", "e2ee-chunked-512mb-smoke");

if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto;
}

class SmokeFileContent extends MediaMessageContent {
  constructor(file) {
    super();
    this.file = file;
    this.name = file.name;
    this.size = file.size;
  }

  get contentType() {
    return 8;
  }

  encodeJSON() {
    return {
      name: this.name,
      size: this.size,
      url: this.remoteUrl || "",
    };
  }

  decodeJSON(content) {
    this.name = content && content.name || "";
    this.size = content && content.size || 0;
    this.remoteUrl = content && content.url || "";
  }
}

class DiskBackedFile {
  constructor(filePath, name, type, size) {
    this.filePath = filePath;
    this.name = name;
    this.type = type;
    this.size = size;
  }

  slice(start = 0, end = this.size, type = this.type) {
    const safeStart = Math.max(0, Number(start || 0));
    const safeEnd = Math.min(this.size, Number(end == null ? this.size : end));
    const length = Math.max(0, safeEnd - safeStart);
    const buffer = Buffer.allocUnsafe(length);
    const fd = fs.openSync(this.filePath, "r");
    try {
      fs.readSync(fd, buffer, 0, length, safeStart);
    } finally {
      fs.closeSync(fd);
    }
    return new Blob([buffer], { type: type || this.type || "application/octet-stream" });
  }
}

async function ensureCleanRoot() {
  await fsp.rm(TEST_ROOT, { recursive: true, force: true });
  await fsp.mkdir(TEST_ROOT, { recursive: true });
}

async function createDeterministicFile(filePath, sizeBytes) {
  const stream = fs.createWriteStream(filePath);
  const hash = crypto.createHash("sha256");
  const block = Buffer.allocUnsafe(MiB);
  let written = 0;
  while (written < sizeBytes) {
    const current = Math.min(block.length, sizeBytes - written);
    for (let i = 0; i < current; i++) {
      block[i] = (written + i) & 0xff;
    }
    const slice = block.subarray(0, current);
    hash.update(slice);
    if (!stream.write(slice)) {
      await once(stream, "drain");
    }
    written += current;
  }
  await new Promise((resolve, reject) => {
    stream.end(resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function createWritableFileHandle(outputPath) {
  return {
    async createWritable() {
      const stream = fs.createWriteStream(outputPath);
      return {
        async write(blob) {
          const buffer = Buffer.from(await blob.arrayBuffer());
          if (!stream.write(buffer)) {
            await once(stream, "drain");
          }
        },
        async close() {
          await new Promise((resolve, reject) => {
            stream.end(resolve);
            stream.on("error", reject);
          });
        },
        async abort() {
          stream.destroy();
        },
      };
    },
  };
}

async function main() {
  const sizeBytes = FILE_SIZE_MIB * MiB;
  const inputPath = path.join(TEST_ROOT, "plain-512mb.bin");
  const outputPath = path.join(TEST_ROOT, "plain-512mb.restored.bin");
  const encryptedDir = path.join(TEST_ROOT, "encrypted");
  await ensureCleanRoot();
  await fsp.mkdir(encryptedDir, { recursive: true });

  let completed = false;
  const uploadedChunks = [];

  try {
    console.log(`[smoke] generating ${FILE_SIZE_MIB}MiB file...`);
    const expectedHash = await createDeterministicFile(inputPath, sizeBytes);
    const diskFile = new DiskBackedFile(inputPath, "plain-512mb.bin", "application/octet-stream", sizeBytes);
    const channel = new Channel("e2ee-chunked-smoke", 2);
    const uploadCrypto = new E2EEMediaCrypto({
      chunkThresholdBytes: 64 * MiB,
      chunkSize: CHUNK_SIZE,
      provider: {
        createEncryptedMediaUploadSession: async (context) => {
          if (context.size !== sizeBytes) {
            throw new Error(`unexpected session size ${context.size}`);
          }
          return { session_id: "smoke-session" };
        },
        uploadEncryptedMediaChunk: async (blob, context) => {
          const chunkPath = path.join(encryptedDir, `${String(context.chunkIndex).padStart(4, "0")}.chunk.e2ee`);
          await fsp.writeFile(chunkPath, Buffer.from(await blob.arrayBuffer()));
          uploadedChunks.push({ index: context.chunkIndex, plainSize: context.plainSize, encryptedSize: blob.size });
          return { url: chunkPath, size: blob.size, etag: `chunk-${context.chunkIndex}` };
        },
        completeEncryptedMediaUpload: async (_context) => {
          completed = true;
          return { ok: true };
        },
      },
    });

    console.log("[smoke] encrypting and writing encrypted chunks...");
    const encrypted = await uploadCrypto.encryptContent(new SmokeFileContent(diskFile), channel);
    if (encrypted.version !== 2 || !encrypted.original || encrypted.original.mode !== "chunked") {
      throw new Error("expected chunked v2 E2EE media manifest");
    }
    if (encrypted.original.sha256) {
      throw new Error("chunked manifest must not require whole-file sha256");
    }
    if (!completed) {
      throw new Error("chunked upload was not completed");
    }
    const expectedChunks = Math.ceil(sizeBytes / CHUNK_SIZE);
    if (uploadedChunks.length !== expectedChunks) {
      throw new Error(`expected ${expectedChunks} chunks, got ${uploadedChunks.length}`);
    }

    globalThis.showSaveFilePicker = async () => createWritableFileHandle(outputPath);
    const downloadCrypto = new E2EEMediaCrypto({
      provider: {
        fetchEncryptedMedia: async (url) => {
          const bytes = await fsp.readFile(url);
          return new Blob([bytes], { type: "application/octet-stream" });
        },
      },
    });

    console.log("[smoke] decrypting chunked file through saveOriginal...");
    const saved = await downloadCrypto.saveOriginal({ name: "plain-512mb.bin", e2eeMedia: encrypted }, "plain-512mb.bin");
    if (!saved) {
      throw new Error("saveOriginal returned false");
    }
    const actualHash = await sha256File(outputPath);
    if (actualHash !== expectedHash) {
      throw new Error(`restored hash mismatch: expected ${expectedHash}, got ${actualHash}`);
    }
    console.log(`[smoke] pass: ${FILE_SIZE_MIB}MiB round-trip, ${uploadedChunks.length} chunks, sha256=${actualHash}`);
  } finally {
    await fsp.rm(TEST_ROOT, { recursive: true, force: true });
    console.log(`[smoke] cleaned ${TEST_ROOT}`);
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
