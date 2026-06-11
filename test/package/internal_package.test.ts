import * as assert from "assert";
import { execFileSync } from "child_process";
import * as path from "path";

declare const test: (name: string, fn: () => void | Promise<void>) => void;

const packageJson = require("../../package.json");
const packageLock = require("../../package-lock.json");

test("internal_package keeps import name but uses E2EE internal version", () => {
    assert.equal(packageJson.name, "wukongimjssdk");
    assert.notEqual(packageJson.version, "1.2.11");
    assert.match(packageJson.version, /e2ee/);
    assert.equal(packageJson.wkE2EE && packageJson.wkE2EE.internalPackage, true);
    assert.equal(packageJson.wkE2EE && packageJson.wkE2EE.publicBaseVersion, "1.2.11");
});

test("internal_package lockfile root version matches package version", () => {
    assert.equal(packageLock.version, packageJson.version);
    assert.equal(packageLock.packages[""].version, packageJson.version);
});

test("internal_package assertion script passes", () => {
    execFileSync(
        "node",
        [path.join(__dirname, "../../scripts/assert-internal-package.js")],
        { stdio: "pipe" },
    );
});
