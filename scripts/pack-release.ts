import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Buildspace's package-stage workflow runs this once for the staging build and
// once for its production candidate. Each build inlines its own version, so the
// version is set before building, and package.json is cleaned the way
// clean-publish released it before. Tracked files are restored either way.
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

const destination = process.env.PACK_DESTINATION;
if (!destination) {
  throw new Error("PACK_DESTINATION is required");
}
const original = await readFile("package.json", "utf8");
const manifest = JSON.parse(original);
if (!STABLE_VERSION.test(manifest.version)) {
  throw new Error("package.json must declare a stable X.Y.Z version");
}
const version = `${manifest.version}${process.env.RELEASE_SUFFIX ?? ""}`;

try {
  await writeFile(
    "package.json",
    `${JSON.stringify({ ...manifest, version }, null, 2)}\n`
  );
  execFileSync("bun", ["run", "build"], { stdio: "inherit" });
  execFileSync(
    "node_modules/.bin/clear-package-json",
    ["package.json", "--output", "package.json"],
    { stdio: "inherit" }
  );
  execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", destination],
    { stdio: "inherit" }
  );
} finally {
  await writeFile("package.json", original);
}

const archive = join(destination, `photon-ai-otel-${version}.tgz`);
await mkdir("node_modules/.cache", { recursive: true });
const unpacked = await mkdtemp(resolve("node_modules/.cache/pack-release-"));
try {
  execFileSync("tar", ["-xzf", archive, "-C", unpacked]);
  const root = join(unpacked, "package");
  const packed = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (packed.name !== manifest.name || packed.version !== version) {
    throw new Error(`The archive holds ${packed.name}@${packed.version}`);
  }
  if (packed.scripts || packed.devDependencies || packed.publishConfig) {
    throw new Error("The packed package.json kept development fields");
  }
  const entry = packed.exports["."];
  await access(join(root, entry.types));
  const { PHOTON_OTEL_VERSION } = await import(
    pathToFileURL(join(root, entry.default)).href
  );
  if (PHOTON_OTEL_VERSION !== version) {
    throw new Error(
      `The packed build reports ${PHOTON_OTEL_VERSION}, not ${version}`
    );
  }
} finally {
  await rm(unpacked, { force: true, recursive: true });
}
