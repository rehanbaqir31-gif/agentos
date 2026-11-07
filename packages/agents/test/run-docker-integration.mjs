import { execFile } from "node:child_process";
import { console } from "node:console";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dockerContext = resolve(packageRoot, "test/docker-integration");
const tag = `agentos-docker-integration:${process.pid}`;
let imageId;

try {
  await exec("docker", ["version", "--format", "{{.Server.Version}}"]);
  await exec("docker", ["build", "--tag", tag, dockerContext], { timeout: 180_000 });
  ({ stdout: imageId } = await exec("docker", ["image", "inspect", "--format", "{{.Id}}", tag]));
  const { exitCode = 1 } = await new Promise((resolveRun, reject) => {
    const child = execFile(
      "pnpm",
      ["exec", "vitest", "run", "test/docker-runtime.integration.test.ts"],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          AGENTOS_DOCKER_INTEGRATION: "1",
          AGENTOS_DOCKER_TEST_IMAGE: imageId.trim(),
        },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        if (error && !("code" in error)) reject(error);
        else resolveRun({ exitCode: error?.code ?? 0 });
      },
    );
    child.on("error", reject);
  });
  if (exitCode !== 0) process.exitCode = Number(exitCode) || 1;
} catch (error) {
  console.error("Docker daemon integration requires a working Docker Engine and image build.");
  console.error(error);
  process.exitCode = 1;
} finally {
  if (imageId) await exec("docker", ["image", "rm", "--force", imageId.trim()]).catch(() => {});
  await exec("docker", ["image", "rm", "--force", tag]).catch(() => {});
}
