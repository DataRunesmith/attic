import { watch } from "node:fs";
import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";
const watchers = [];
let wrangler = null;
let stoppingWrangler = false;
let debounceTimer = null;
let building = false;
let pending = false;
let shuttingDown = false;

/** Run a project command and reject if it exits unsuccessfully. */
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: isWindows,
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(command + " exited with " + (signal || code)));
    });
  });
}

/** Build a complete staged Worker bundle before replacing the running dev process. */
async function build() {
  await run(isWindows ? "npm.cmd" : "npm", ["run", "build:cloudflare"]);
}

/** Start Wrangler against the fully rendered and bundled configuration. */
function startWrangler() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      isWindows ? "npx.cmd" : "npx",
      ["wrangler", "dev", "--local", "--config", ".cloudflare-build/wrangler.jsonc"],
      { stdio: "inherit", shell: isWindows, env: process.env },
    );
    wrangler = child;
    child.once("spawn", () => resolve());
    child.once("error", (error) => {
      if (wrangler === child) wrangler = null;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (wrangler === child) wrangler = null;
      if (!shuttingDown && !stoppingWrangler && code !== 0)
        console.error("Wrangler stopped (" + (signal || code) + "). Fix the issue and save a source file to restart.");
    });
  });
}

/** Stop the current Wrangler process before swapping the rendered output directory. */
async function stopWrangler() {
  const child = wrangler;
  if (!child || child.exitCode !== null || child.killed) return;
  stoppingWrangler = true;
  try {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.kill("SIGTERM");
    });
  } finally {
    stoppingWrangler = false;
  }
}

/** Rebuild once after a burst of file changes, then restart Wrangler on success. */
async function rebuild() {
  if (shuttingDown) return;
  if (building) {
    pending = true;
    return;
  }
  building = true;
  let successful = false;
  do {
    pending = false;
    try {
      await build();
      successful = true;
    } catch (error) {
      successful = false;
      console.error("Build failed; the previous rendered output remains available.", error);
      break;
    }
  } while (pending && !shuttingDown);

  if (successful && !shuttingDown) {
    try {
      await stopWrangler();
      if (!shuttingDown) await startWrangler();
    } catch (error) {
      console.error("Could not restart Wrangler:", error);
    }
  }
  building = false;
  if (pending && !shuttingDown) scheduleRebuild();
}

/** Debounce filesystem events so editor save bursts trigger one build. */
function scheduleRebuild() {
  if (shuttingDown) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (!shuttingDown) void rebuild().catch((error) => console.error("Development rebuild failed:", error));
  }, 250);
}

/** Watch a source directory recursively and schedule relevant rebuilds. */
function watchDirectory(path, filter = () => true) {
  const watcher = watch(path, { recursive: true }, (_event, filename) => {
    const name = filename?.toString() || "";
    if (!name || filter(name)) scheduleRebuild();
  });
  watcher.on("error", (error) => console.error("Watcher error for " + path + ":", error));
  watchers.push(watcher);
}

/** Watch root-level configuration files that affect the generated Worker. */
function watchRootFiles() {
  const relevant = new Set([
    ".cloudflare.env", "build.mjs", "cloudflare.example.env", "package.json", "wrangler.jsonc",
  ]);
  const watcher = watch(".", (_event, filename) => {
    if (filename && relevant.has(filename.toString())) scheduleRebuild();
  });
  watcher.on("error", (error) => console.error("Root watcher error:", error));
  watchers.push(watcher);
}

/** Close filesystem watchers and stop the active Wrangler child process. */
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(debounceTimer);
  for (const watcher of watchers) watcher.close();
  await stopWrangler();
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });

try {
  watchDirectory("src");
  watchDirectory("public");
  watchDirectory("tools");
  watchRootFiles();
  building = true;
  do {
    pending = false;
    await build();
  } while (pending && !shuttingDown);
  building = false;
  if (!shuttingDown) await startWrangler();
  console.log("Watching src/, public/, tools/, build.mjs, wrangler.jsonc, and .cloudflare.env.");
} catch (error) {
  await shutdown();
  console.error(error);
  process.exitCode = 1;
}
