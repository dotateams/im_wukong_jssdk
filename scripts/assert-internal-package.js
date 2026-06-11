const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));

const failures = [];

if (pkg.name !== "wukongimjssdk") {
  failures.push(`package name must stay wukongimjssdk, got ${pkg.name}`);
}
if (pkg.version === "1.2.11" || !/e2ee/.test(pkg.version)) {
  failures.push(`package version must be an internal E2EE version, got ${pkg.version}`);
}
if (!pkg.wkE2EE || pkg.wkE2EE.internalPackage !== true) {
  failures.push("wkE2EE.internalPackage must be true");
}
if (!pkg.wkE2EE || pkg.wkE2EE.publicBaseVersion !== "1.2.11") {
  failures.push("wkE2EE.publicBaseVersion must be 1.2.11");
}
if (!pkg.publishConfig || pkg.publishConfig.tag !== "e2ee") {
  failures.push("publishConfig.tag must be e2ee");
}
if (lock.version !== pkg.version) {
  failures.push(`package-lock root version ${lock.version} does not match ${pkg.version}`);
}
if (!lock.packages || !lock.packages[""] || lock.packages[""].version !== pkg.version) {
  failures.push("package-lock packages[\"\"] version must match package version");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`internal package ok: ${pkg.name}@${pkg.version}`);
