// Sanity checks on the built extension: every referenced file exists,
// permissions are the expected minimal set, and no credential-like strings
// ended up in the bundle.
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const problems = [];

const manifest = JSON.parse(await readFile(join(dist, "manifest.json"), "utf8"));

const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_ui.page,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap((c) => c.js ?? []),
];
for (const file of referenced) {
  try {
    await stat(join(dist, file));
  } catch {
    problems.push(`Missing file referenced by manifest: ${file}`);
  }
}

const expectedPermissions = ["alarms", "storage"];
const permissions = [...(manifest.permissions ?? [])].sort();
if (JSON.stringify(permissions) !== JSON.stringify(expectedPermissions)) {
  problems.push(`Unexpected permissions: ${permissions.join(", ")}`);
}
const hosts = manifest.host_permissions ?? [];
if (hosts.length !== 1 || hosts[0] !== "https://api.github.com/*") {
  problems.push(`Unexpected host permissions: ${hosts.join(", ")}`);
}
for (const cs of manifest.content_scripts) {
  if (cs.matches.some((m) => m !== "https://leetcode.com/*")) {
    problems.push(`Content script matches more than leetcode.com: ${cs.matches.join(", ")}`);
  }
}
if (manifest.optional_permissions || manifest.optional_host_permissions) {
  problems.push("Manifest declares optional permissions; review them.");
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const secretPatterns = [/github_pat_[A-Za-z0-9_]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/];
for await (const file of walk(dist)) {
  if (!/\.(js|html|css|json)$/.test(file)) continue;
  const text = await readFile(file, "utf8");
  for (const re of secretPatterns) {
    if (re.test(text)) problems.push(`Credential-like string in ${file}`);
  }
}

if (problems.length) {
  console.error("dist verification failed:\n- " + problems.join("\n- "));
  process.exit(1);
}
console.log(`dist verified: ${referenced.length} referenced files present, permissions minimal, no credential-like strings.`);
