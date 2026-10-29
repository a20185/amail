import type { Command } from "commander";
import { resolveDirs } from "../../core/paths.js";
import { apiFetch } from "../util.js";

export interface ArchiveResult {
  id: string;
  project: string;
  path: string;
}

/** amail archive <id> --project <slug> → daemon POST /v1/archive */
export async function archiveMessage(
  id: string,
  project: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ArchiveResult> {
  const result = (await apiFetch(resolveDirs(env), "/v1/archive", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, project }),
  })) as ArchiveResult;
  console.log(`archived ${result.id} → ${result.path}`);
  return result;
}

export default function register(program: Command): void {
  program
    .command("archive")
    .description("archive a message into a project workspace")
    .argument("<id>", "message id")
    .requiredOption("--project <slug>", "target project slug")
    .action(async (id: string, opts: { project: string }) => {
      await archiveMessage(id, opts.project);
    });
}
