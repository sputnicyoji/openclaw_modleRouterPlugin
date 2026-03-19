/**
 * Loader integration test for model-router plugin.
 *
 * Verifies that the plugin can be loaded by OpenClaw's real plugin loader
 * (loadOpenClawPlugins + jiti), and that the /route command and
 * before_prompt_build hook are registered in the plugin registry.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadOpenClawPlugins } from "./loader.js";

const MODEL_ROUTER_DIR = path.resolve(
  import.meta.dirname,
  "../../../model-router",
);

const prevBundledDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

function mkdirSafe(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform !== "win32") {
    fs.chmodSync(dir, 0o755);
  }
}

describe("model-router plugin loader integration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-loader-test-"));
    if (process.platform !== "win32") {
      fs.chmodSync(tempDir, 0o755);
    }
    // Point bundled plugins dir to an empty location so stock plugins don't interfere
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(tempDir, "empty-bundled");
    mkdirSafe(process.env.OPENCLAW_BUNDLED_PLUGINS_DIR);
  });

  afterEach(() => {
    if (prevBundledDir) {
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = prevBundledDir;
    } else {
      delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads the real model-router plugin via jiti and registers command + hook", () => {
    const indexFile = path.join(MODEL_ROUTER_DIR, "index.ts");

    // Verify the plugin source exists
    expect(fs.existsSync(indexFile)).toBe(true);
    expect(fs.existsSync(path.join(MODEL_ROUTER_DIR, "openclaw.plugin.json"))).toBe(true);

    // Load the plugin using OpenClaw's real plugin loader
    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: tempDir,
      config: {
        plugins: {
          load: { paths: [indexFile] },
          allow: ["model-router"],
        },
      },
    });

    // Verify plugin was loaded successfully
    const plugin = registry.plugins.find((p) => p.id === "model-router");
    expect(plugin).toBeDefined();
    expect(plugin?.status).toBe("loaded");
    expect(plugin?.enabled).toBe(true);

    // Verify /route command was registered
    const routeCommand = registry.commands.find(
      (c) => c.command.name === "route",
    );
    expect(routeCommand).toBeDefined();
    expect(routeCommand?.command.description).toContain("routing rules");
    expect(routeCommand?.command.acceptsArgs).toBe(true);

    // Verify before_prompt_build hook was registered
    const promptHook = registry.typedHooks.find(
      (h) =>
        h.pluginId === "model-router" &&
        h.hookName === "before_prompt_build",
    );
    expect(promptHook).toBeDefined();
    expect(promptHook?.priority).toBe(0);
  });
});
