const fs = require("fs");
const path = require("path");

require("ts-node").register({
  transpileOnly: true,
  compilerOptions: {
    module: "commonjs",
    target: "es2018",
  },
});

const tests = [];
const debug = process.env.TEST_DEBUG === "1";

global.test = (name, fn) => {
  tests.push({ name, fn });
};

function walk(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function grepValue() {
  const index = process.argv.indexOf("--grep");
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return "";
}

async function main() {
  const grep = grepValue();
  const testFiles = walk(path.join(__dirname)).sort();

  for (const file of testFiles) {
    if (debug) {
      console.log(`load - ${file}`);
    }
    require(file);
  }

  const selected = grep
    ? tests.filter((item) => item.name.indexOf(grep) >= 0)
    : tests;

  if (selected.length === 0) {
    throw new Error(`No tests matched ${grep || "<all>"}`);
  }

  let failed = 0;
  for (const item of selected) {
    try {
      const { E2EECacheStore, E2EE_CACHE_STORES } = require("../src/e2ee/e2ee_cache_store");
      await E2EECacheStore.shared().clearPrefix(E2EE_CACHE_STORES.ENVELOPE_MISSING, "");
      if (debug) {
        console.log(`run - ${item.name}`);
      }
      await item.fn();
      console.log(`ok - ${item.name}`);
    } catch (error) {
      failed++;
      console.error(`not ok - ${item.name}`);
      console.error(error && error.stack ? error.stack : error);
    }
  }

  if (failed > 0) {
    process.exit(1);
  }
  console.log(`pass - ${selected.length} test(s)`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
