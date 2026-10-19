import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let testApi;
try {
  testApi = await import("vitest");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  testApi = await import("node:test");
}
const { afterEach, beforeEach, describe, it } = testApi;

const require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_ROOT = path.resolve(__dirname, "../../cli");
const SQLITE_MOD = path.join(CLI_ROOT, "hooks/sqliteRuntime.js");
const TRAY_MOD = path.join(CLI_ROOT, "hooks/trayRuntime.js");

const HOUR = 60 * 60 * 1000;
const tempDirs = [];
let originalDataDir;
let originalPath;

// `npmInstall()` calls the module-local `runNpmInstall`, not the exported
// reference, so stubbing the export cannot intercept it. A fake `npm` first on
// PATH is the only seam that covers both hooks.
const FAKE_NPM = `#!/bin/sh
set -e
if [ "$FAKE_NPM_FAIL" = "1" ]; then
  echo "npm ERR! 404 Not Found" >&2
  exit 1
fi
for arg in "$@"; do
  case "$arg" in
    sql.js@*)
      mkdir -p node_modules/sql.js/dist
      echo '{}' > node_modules/sql.js/package.json
      : > node_modules/sql.js/dist/sql-wasm.wasm
      ;;
    better-sqlite3@*)
      mkdir -p node_modules/better-sqlite3
      echo '{}' > node_modules/better-sqlite3/package.json
      if [ -n "$FAKE_BETTER_SQLITE_BINARY" ]; then
        mkdir -p "$(dirname "$FAKE_BETTER_SQLITE_BINARY")"
        cp "$FAKE_BINARY_SRC" "$FAKE_BETTER_SQLITE_BINARY"
      fi
      ;;
    systray2@*)
      mkdir -p node_modules/systray2
      echo '{}' > node_modules/systray2/package.json
      ;;
  esac
done
exit 0
`;

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function marker(dataDir, name) {
  return path.join(dataDir, "runtime", name);
}

function writeMarker(dataDir, name, at) {
  fs.mkdirSync(path.join(dataDir, "runtime"), { recursive: true });
  fs.writeFileSync(marker(dataDir, name), String(at));
}

// Mach-O magic (0xfeedfacf, arm64) so isBetterSqliteBinaryValid() accepts it on
// darwin; ELF/MZ elsewhere.
function binaryMagic() {
  if (process.platform === "linux") return Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
  if (process.platform === "win32") return Buffer.from("MZ", "ascii");
  return Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);
}

// Fresh module instances so each test re-reads DATA_DIR.
function loadSqlite() {
  delete require.cache[require.resolve(SQLITE_MOD)];
  delete require.cache[require.resolve(TRAY_MOD)];
  return require(SQLITE_MOD);
}

function loadTray() {
  loadSqlite();
  return require(TRAY_MOD);
}

beforeEach(() => {
  originalDataDir = process.env.DATA_DIR;
  originalPath = process.env.PATH;
  process.env.DATA_DIR = makeTempDir("9router-runtime-cooldown-");
  const binDir = makeTempDir("9router-fake-npm-");
  const npmPath = path.join(binDir, "npm");
  fs.writeFileSync(npmPath, FAKE_NPM, { mode: 0o755 });
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  process.env.PATH = originalPath;
  delete process.env.FAKE_NPM_FAIL;
  delete process.env.FAKE_BETTER_SQLITE_BINARY;
  delete process.env.FAKE_BINARY_SRC;
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("cli runtime retry cooldown — sqlite", () => {
  it("records an attempt and skips the next run", () => {
    process.env.FAKE_NPM_FAIL = "1";
    const dataDir = process.env.DATA_DIR;
    const sqlite = loadSqlite();

    const first = sqlite.ensureSqliteRuntime({ silent: true });
    assert.equal(first.betterSqlite, false);
    assert.notEqual(first.skipped, true, "first run is a real attempt, not a skip");
    assert.ok(fs.existsSync(marker(dataDir, ".sqlite-attempt")), "attempt marker written");

    const second = sqlite.ensureSqliteRuntime({ silent: true });
    assert.equal(second.skipped, true, "second run reports the skip");
  });

  it("skips before attempting sql.js, not just better-sqlite3", () => {
    const dataDir = process.env.DATA_DIR;
    const attemptedAt = Date.now() - 60_000;
    writeMarker(dataDir, ".sqlite-attempt", attemptedAt);

    const sqlite = loadSqlite();
    const result = sqlite.ensureSqliteRuntime({ silent: true });

    assert.equal(result.skipped, true);
    const at = Number(fs.readFileSync(marker(dataDir, ".sqlite-attempt"), "utf8").trim());
    assert.equal(at, attemptedAt, "marker untouched — no new attempt was recorded");
    assert.equal(
      fs.existsSync(path.join(dataDir, "runtime", "node_modules")),
      false,
      "no install ran while the cooldown is active",
    );
  });

  it("retries once the cooldown has expired", () => {
    const dataDir = process.env.DATA_DIR;
    writeMarker(dataDir, ".sqlite-attempt", Date.now() - 25 * HOUR);

    const sqlite = loadSqlite();
    sqlite.ensureSqliteRuntime({ silent: true });

    const at = Number(fs.readFileSync(marker(dataDir, ".sqlite-attempt"), "utf8").trim());
    assert.ok(Date.now() - at < 60_000, "marker refreshed by the new attempt");
  });

  it("clears the marker only when both engines are ready", () => {
    const dataDir = process.env.DATA_DIR;
    writeMarker(dataDir, ".sqlite-attempt", Date.now() - 25 * HOUR);

    const sqlite = loadSqlite();
    const partial = sqlite.ensureSqliteRuntime({ silent: true });
    assert.equal(partial.sqlJs, true, "sql.js landed");
    assert.equal(partial.betterSqlite, false, "no native binary yet");
    assert.ok(fs.existsSync(marker(dataDir, ".sqlite-attempt")), "marker survives a partial success");

    // Now let the binary check pass too.
    const src = path.join(makeTempDir("9router-binary-"), "better_sqlite3.node");
    fs.writeFileSync(src, binaryMagic());
    process.env.FAKE_BINARY_SRC = src;
    process.env.FAKE_BETTER_SQLITE_BINARY = path.join(
      "node_modules", "better-sqlite3", "prebuilds", `${process.platform}-${process.arch}.node`,
    );
    fs.rmSync(marker(dataDir, ".sqlite-attempt"), { force: true });

    const full = loadSqlite().ensureSqliteRuntime({ silent: true });
    assert.equal(full.betterSqlite, true);
    assert.equal(full.sqlJs, true);
    assert.equal(fs.existsSync(marker(dataDir, ".sqlite-attempt")), false, "marker cleared on full success");
  });
});

describe("cli runtime retry cooldown — tray", () => {
  it("creates the runtime dir before writing the attempt marker", () => {
    process.env.FAKE_NPM_FAIL = "1";
    const dataDir = process.env.DATA_DIR;
    const tray = loadTray();

    assert.equal(fs.existsSync(path.join(dataDir, "runtime")), false, "precondition: no runtime dir");
    const result = tray.ensureTrayRuntime({ silent: true });

    assert.equal(result.systray, false);
    assert.ok(fs.existsSync(marker(dataDir, ".tray-install-attempt")), "marker survived the missing dir");
  });

  it("returns the same shape when skipping as on a failed install", () => {
    const dataDir = process.env.DATA_DIR;
    writeMarker(dataDir, ".tray-install-attempt", Date.now());

    const tray = loadTray();
    const result = tray.ensureTrayRuntime({ silent: true });

    assert.equal(result.skipped, true);
    assert.ok(result.arm64, "callers can read .arm64 unconditionally");
  });

  it("clears the marker once systray2 is installed", () => {
    const dataDir = process.env.DATA_DIR;
    writeMarker(dataDir, ".tray-install-attempt", Date.now() - 25 * HOUR);

    const tray = loadTray();
    const result = tray.ensureTrayRuntime({ silent: true });

    assert.equal(result.systray, true);
    assert.equal(fs.existsSync(marker(dataDir, ".tray-install-attempt")), false, "marker cleared on success");
  });
});
