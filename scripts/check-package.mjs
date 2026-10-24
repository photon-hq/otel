import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const consumer = await mkdtemp(join(tmpdir(), "otel-consumer-"));
const run = (command, args, cwd = consumer) =>
  execFileSync(command, args, { cwd, stdio: "inherit" });

try {
  const clean = join(consumer, "clean");
  run(
    process.execPath,
    [
      join(root, "node_modules/clean-publish/clean-publish.js"),
      "--without-publish",
      "--temp-dir",
      clean,
    ],
    root
  );
  const [packed] = JSON.parse(
    execFileSync("npm", ["pack", "--ignore-scripts", "--json", clean], {
      cwd: consumer,
      encoding: "utf8",
    })
  );
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" })
  );
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    join(consumer, packed.filename),
  ]);
  const lock = JSON.parse(
    await readFile(join(consumer, "package-lock.json"), "utf8")
  );
  if (
    Object.keys(lock.packages).some((path) =>
      path.endsWith("node_modules/typescript")
    )
  ) {
    throw new Error("Runtime consumers must not install TypeScript");
  }
  run(process.execPath, [
    "--input-type=module",
    "-e",
    `import assert from 'node:assert/strict';
     import { createIsolatedOtel, isOtelActive } from '@photon-ai/otel';
     const runtime = createIsolatedOtel({
       endpoint: 'http://127.0.0.1:4318',
       serviceName: 'package-smoke',
       traceparentHeader: 'x-test-traceparent',
     });
     assert.equal(isOtelActive(), false);
     await runtime.shutdown();`,
  ]);
} finally {
  await rm(consumer, { force: true, recursive: true });
}
