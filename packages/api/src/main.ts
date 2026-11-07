import { openConfiguredDatabase } from "@agentos/database";
import {
  AdapterRegistry,
  ArtifactService,
  DockerIsolatedRuntime,
  ExecutionCoordinator,
  FileSystemArtifactStorage,
  OpenCodeAdapter,
} from "@agentos/agents";
import { bindLoopback, createAgentOsServer } from "./server.js";
import { createLocalAuthorizationServices } from "./policy.js";

async function main(): Promise<void> {
  const configured = await openConfiguredDatabase();
  let app: Awaited<ReturnType<typeof createAgentOsServer>> | undefined;
  try {
    const existing = await configured.repositories.auth.findAnyPrincipal();
    const username = process.env["AGENTOS_BOOTSTRAP_USERNAME"];
    const password = process.env["AGENTOS_BOOTSTRAP_PASSWORD"];
    if (!existing && (!username || !password))
      throw new Error(
        "First startup requires AGENTOS_BOOTSTRAP_USERNAME and AGENTOS_BOOTSTRAP_PASSWORD",
      );
    if ((username && !password) || (!username && password))
      throw new Error("Set both bootstrap environment variables or neither");

    const artifactStorage = await FileSystemArtifactStorage.open();
    const artifacts = new ArtifactService(configured.repositories, artifactStorage);
    const authorization = createLocalAuthorizationServices(configured.repositories);
    const image = process.env["AGENTOS_OPENCODE_IMAGE"];
    let coordinator: ExecutionCoordinator | undefined;
    if (image) {
      const adapters = new AdapterRegistry();
      adapters.register(new OpenCodeAdapter(new DockerIsolatedRuntime({ image })));
      coordinator = new ExecutionCoordinator(
        configured.repositories,
        adapters,
        artifacts,
        () => new Date().toISOString(),
        authorization.execution,
      );
    }
    app = await createAgentOsServer({
      repositories: configured.repositories,
      ...(username && password ? { bootstrap: { username, password } } : {}),
      artifacts,
      approvals: authorization.approvals,
      ...(coordinator ? { coordinator } : {}),
      logger: false,
    });
    const port = Number(process.env["AGENTOS_API_PORT"] ?? 3777);
    const address = await bindLoopback(app, port);
    process.stdout.write(`AgentOS local API listening at ${address}\n`);

    await new Promise<void>((resolve) => {
      const shutdown = () => resolve();
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  } finally {
    await app?.close();
    await configured.close();
  }
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : "Error";
  process.stderr.write(`AgentOS API failed to start (${name})\n`);
  process.exitCode = 1;
});
