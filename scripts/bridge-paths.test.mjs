// Where the CLI looks for the desktop app's agent bridge on each OS.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { bridgeApplicable, bridgeFilePath } from "../dist/macBridge.js";

describe("desktop app bridge discovery", () => {
  it("macOS reads Application Support", () => {
    const base = join(homedir(), "Library", "Application Support");
    assert.equal(bridgeFilePath("cloud", "darwin"), join(base, "Clipy", "agent-bridge.json"));
    assert.equal(bridgeFilePath("local", "darwin"), join(base, "Clipy Local", "agent-bridge.json"));
  });

  it("Windows reads %APPDATA%, where the Windows app writes it", () => {
    const saved = process.env.APPDATA;
    process.env.APPDATA = join("C:", "Users", "me", "AppData", "Roaming");
    try {
      assert.equal(bridgeFilePath("cloud", "win32"), join(process.env.APPDATA, "Clipy", "agent-bridge.json"));
      assert.equal(bridgeFilePath("local", "win32"), join(process.env.APPDATA, "Clipy Local", "agent-bridge.json"));
    } finally {
      if (saved === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = saved;
    }
  });

  it("the desktop app answers on macOS and Windows, not on Linux without an explicit file", () => {
    const saved = process.env.CLIPY_BRIDGE_FILE;
    delete process.env.CLIPY_BRIDGE_FILE;
    try {
      assert.equal(bridgeApplicable("cloud", "darwin"), true);
      assert.equal(bridgeApplicable("cloud", "win32"), true);
      assert.equal(bridgeApplicable("cloud", "linux"), false);
    } finally {
      if (saved !== undefined) process.env.CLIPY_BRIDGE_FILE = saved;
    }
  });
});
