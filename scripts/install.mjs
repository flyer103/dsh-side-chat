#!/usr/bin/env node
// Idempotent local installer for dsh-side-chat.
//
//   node scripts/install.mjs --profile <name> [--dry-run]
//   node scripts/install.mjs --profile <name> --uninstall [--dry-run]
//
// `dsh plugin --profile <name> add <repo>` records the dependency in the profile
// package.json and appends the bundle to dsh.profile.bundles; the profile's own
// cordis.patch.yml is not touched. Re-running is safe. DSH is never restarted.
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import url from "node:url";

const PACKAGE_NAME = "@flyer103/dsh-side-chat";
const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const dshHome = process.env.DSH_HOME?.trim()
  ? path.resolve(process.env.DSH_HOME.trim())
  : path.join(os.homedir(), ".dsh");

function fail(message) {
  console.error(`dsh-side-chat: ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`Usage:
  node scripts/install.mjs --profile <name> [--dry-run]
  node scripts/install.mjs --profile <name> --uninstall [--dry-run]

Options:
  --profile <name>  DSH profile to install into (desktop, web, or a profile you created)
  --uninstall       remove the plugin from that profile
  --dry-run         print the planned changes without running anything
  -h, --help        show this help
`);
}

function parseArgs(argv) {
  const options = { profile: undefined, uninstall: false, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--profile") {
      options.profile = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--profile=")) {
      options.profile = argument.slice("--profile=".length);
    } else if (argument === "--uninstall") {
      options.uninstall = true;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "-h" || argument === "--help") {
      options.help = true;
    } else {
      fail(`unknown argument ${JSON.stringify(argument)} (try --help)`);
    }
  }
  if (options.help) return options;
  if (options.profile === undefined || options.profile === "") {
    fail("--profile <name> is required (for example: --profile web, --profile desktop)");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(options.profile)) {
    fail(`invalid profile name ${JSON.stringify(options.profile)}`);
  }
  return options;
}

function readJson(filename) {
  return JSON.parse(readFileSync(filename, "utf8"));
}

function dshVersion(dryRun) {
  if (dryRun) return "unknown (dry run)";
  const result = spawnSync("dsh", ["--version"], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    fail("the `dsh` command is not on PATH; install DeepSeek Harness or add its CLI to PATH");
  }
  if (result.status !== 0) {
    return "unknown";
  }
  return result.stdout.trim();
}

function runDshPlugin(args) {
  const result = spawnSync("dsh", ["plugin", "--profile", options.profile, ...args], {
    stdio: "inherit",
  });
  if (result.error) {
    fail(`could not run dsh: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`dsh plugin ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function profileState(profileDir) {
  const manifestPath = path.join(profileDir, "package.json");
  const patchPath = path.join(profileDir, "cordis.patch.yml");
  if (!existsSync(manifestPath)) {
    return { manifestPath, patchPath, manifest: undefined, dependency: undefined, bundleListed: false };
  }
  const manifest = readJson(manifestPath);
  return {
    manifestPath,
    patchPath,
    manifest,
    dependency: manifest.dependencies?.[PACKAGE_NAME],
    bundleListed: manifest.dsh?.profile?.bundles?.includes(PACKAGE_NAME) === true,
  };
}

function composedRow(dryRun) {
  if (dryRun) {
    console.log(`dry-run: would verify the composed row with dsh --profile ${options.profile} --dump-config`);
    return undefined;
  }
  const result = spawnSync("dsh", ["--profile", options.profile, "--dump-config"], { encoding: "utf8" });
  if (result.status !== 0) {
    console.log("note: could not run dsh --dump-config to verify the composed row");
    return undefined;
  }
  return result.stdout.includes(`name: '${PACKAGE_NAME}'`);
}

function nextSteps(dryRun) {
  console.log("");
  console.log("Next steps:");
  console.log("  1. Restart DSH so the profile reloads: quit and reopen the Desktop app, or restart the dsh web process.");
  console.log("  2. Open a session and click “侧边会话” in the session header.");
  console.log("  3. Send a message; the side chat is created on first send and destroyed when the panel closes.");
  if (dryRun) console.log("  (dry run: nothing above was executed)");
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  usage();
  process.exit(0);
}

const repoManifest = readJson(path.join(repoRoot, "package.json"));
if (repoManifest.name !== PACKAGE_NAME) {
  fail(`expected package ${PACKAGE_NAME} at ${repoRoot}, found ${JSON.stringify(repoManifest.name)}`);
}
const bundlePatch = repoManifest.dsh?.bundle?.patch;
if (bundlePatch === undefined || !existsSync(path.resolve(repoRoot, bundlePatch))) {
  fail(`${PACKAGE_NAME} does not declare a readable dsh.bundle.patch`);
}

const profileDir = path.join(dshHome, "profiles", options.profile);
if (!existsSync(profileDir) && options.uninstall) {
  console.log(`dsh-side-chat: profile ${options.profile} does not exist at ${profileDir}; nothing to remove.`);
  process.exit(0);
}
const state = profileState(profileDir);
const installed = state.dependency !== undefined;
const bundleListed = state.bundleListed;

console.log(`dsh-side-chat installer${options.dryRun ? " (dry run)" : ""}`);
console.log(`  package:  ${PACKAGE_NAME} ${repoManifest.version}`);
console.log(`  repo:     ${repoRoot}`);
console.log(`  profile:  ${options.profile} (${profileDir})`);
console.log(`  dsh:      ${dshVersion(options.dryRun)}`);
if (!existsSync(profileDir) && !options.uninstall) {
  console.log("");
  console.log(`warning: profile ${options.profile} does not exist yet. dsh plugin will initialize it with`);
  console.log("         the default base bundles only; a Web GUI profile needs its own web-app bundles.");
  console.log("         Use the profile you actually run (desktop or web) unless you intend a new profile.");
}
console.log("");

if (options.uninstall) {
  if (!installed && !bundleListed) {
    console.log(`dsh-side-chat is not installed in profile ${options.profile}; nothing to do.`);
    process.exit(0);
  }
  if (installed) {
    if (options.dryRun) {
      console.log(`dry-run: would run dsh plugin --profile ${options.profile} remove ${PACKAGE_NAME}`);
    } else {
      runDshPlugin(["remove", PACKAGE_NAME]);
    }
  }
  const after = profileState(profileDir);
  if (after.bundleListed) {
    console.log("");
    console.log(`warning: dsh plugin remove finished but ${PACKAGE_NAME} is still listed in`);
    console.log(`         dsh.profile.bundles of ${after.manifestPath}. Remove that entry by hand,`);
    console.log("         then restart DSH.");
  }
  if (existsSync(state.patchPath)) {
    const patch = readFileSync(state.patchPath, "utf8");
    if (patch.includes(PACKAGE_NAME) || /id:\s*dsh-side-chat\b/.test(patch)) {
      console.log("");
      console.log(`note: ${state.patchPath} still mentions ${PACKAGE_NAME}.`);
      console.log("      This installer never writes profile patch rows. If you added one by hand, delete this entry:");
      console.log("        - insert:");
      console.log("            - id: dsh-side-chat");
      console.log(`              name: '${PACKAGE_NAME}'`);
    }
  }
  console.log("");
  if (options.dryRun) {
    console.log(`dry-run: would remove ${PACKAGE_NAME} from profile ${options.profile}.`);
  } else {
    if (composedRow(false) === true) {
      console.log(`warning: dsh --profile ${options.profile} --dump-config still composes ${PACKAGE_NAME}; restart DSH and re-check.`);
    }
    console.log(`Removed ${PACKAGE_NAME} from profile ${options.profile}. Restart DSH to unload it.`);
    console.log("No session data or workspace files are touched.");
  }
  process.exit(0);
}

if (installed && bundleListed) {
  console.log(`Already installed in profile ${options.profile} (${state.dependency}); nothing to do.`);
  nextSteps(options.dryRun);
  process.exit(0);
}

if (options.dryRun) {
  console.log(`dry-run: would run dsh plugin --profile ${options.profile} add ${repoRoot}`);
  if (installed && !bundleListed) {
    console.log(`warning: ${PACKAGE_NAME} is a profile dependency but is missing from dsh.profile.bundles.`);
    console.log("         Re-running add may not repair that; run the --uninstall then install again.");
  }
  nextSteps(true);
  process.exit(0);
}

runDshPlugin(["add", repoRoot]);

const after = profileState(profileDir);
if (after.dependency === undefined) {
  fail(`dsh plugin add finished but ${PACKAGE_NAME} is not in ${after.manifestPath}`);
}
if (!after.bundleListed) {
  fail(`dsh plugin add finished but ${PACKAGE_NAME} is missing from dsh.profile.bundles in ${after.manifestPath}; run this script with --uninstall, then install again`);
}
console.log("");
console.log(`Installed ${PACKAGE_NAME} into profile ${options.profile}.`);
if (composedRow(false) === true) {
  console.log(`Verified: dsh --profile ${options.profile} --dump-config composes the dsh-side-chat row.`);
} else {
  console.log("note: dsh --dump-config did not show the row; restart DSH and check the Plugins page if the button is missing.");
}
nextSteps(false);
