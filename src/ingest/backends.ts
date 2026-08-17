import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { ASSERTIONS_JSON_SCHEMA, SYSTEM, type ParseFn } from "./normalize.js";

export type BackendName = "api" | "claude-cli" | "codex-cli";

const MODEL = "claude-opus-5";
/** A CLI shells out to a whole agent; a claim that has not answered by now is stuck. */
const CLI_TIMEOUT_MS = 300_000;
/** Structured output for a long claim can exceed execFile's 1 MB default. */
const CLI_MAX_BUFFER = 16 * 1024 * 1024;

/** Both CLIs take one prompt, so the system text rides in front of the claim. */
const promptFor = (text: string) => `${SYSTEM}\n\nClaim:\n${text}`;

/**
 * Runs a CLI and returns its stdout.
 *
 * `spawn` rather than `execFile` specifically so stdin can be closed: both
 * CLIs wait on stdin when it is an open pipe nobody writes to, and execFile
 * offers no way to detach it. stderr is collected only to make a failure
 * legible — these are agents, and "exit 1" alone is not a diagnosis.
 */
export function runCapture(bin: string, args: string[], stripEnv: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of stripEnv) delete env[key];
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    let err = "";
    let size = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${bin} timed out after ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      size += d.length;
      if (size > CLI_MAX_BUFFER) {
        child.kill("SIGKILL");
        reject(new Error(`${bin} produced more than ${CLI_MAX_BUFFER} bytes`));
        return;
      }
      out += d;
    });
    child.stderr.on("data", (d: string) => { err += d.slice(0, 4000); });

    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${bin} exited ${code}: ${err.trim().slice(0, 500)}`));
    });
  });
}

/**
 * Pulls the first {...} block out of CLI output. Both CLIs are told to emit
 * schema-constrained JSON and both do, but they are agents: a stray log line
 * on stdout must not cost us the claim. Whatever survives is still run through
 * NormalizedSchema by the caller, so a wrong extraction fails closed.
 */
export function extractJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * The Anthropic API. Passes the JSON Schema directly rather than through
 * `betaZodOutputFormat`, which requires zod 4's `z.toJSONSchema` and throws on
 * this project's zod 3 before any request is made.
 */
export const apiParse: ParseFn = async (text) => {
  const client = new Anthropic();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4096,
    // Cached because SYSTEM is ~3 KB and identical for every claim in a run.
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    output_format: { type: "json_schema", schema: ASSERTIONS_JSON_SCHEMA as Record<string, unknown> },
    messages: [{ role: "user", content: `Claim:\n${text}` }],
  });
  const block = response.content.find((c) => c.type === "text");
  return block && block.type === "text" ? extractJson(block.text) : null;
};

/**
 * Auth variables that would override a CLI's logged-in session. They are
 * stripped from the child environment, because a backend chosen specifically
 * to spend a subscription must not silently fall through to a metered key that
 * happened to be exported — Claude Code says so itself: "ANTHROPIC_API_KEY or
 * another auth source is set and takes precedence over your claude.ai login".
 * Without this, defaulting to the CLI would not actually change who pays.
 */
export const CLAUDE_OVERRIDING_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
export const CODEX_OVERRIDING_ENV = ["OPENAI_API_KEY"];

/**
 * Claude Code in print mode. Authenticates with the operator's existing login
 * rather than an API key, which is the whole point: ingest is a local, one-off
 * operation, so it can use a credential CI never sees.
 */
export const claudeCliParse: ParseFn = async (text) => {
  const stdout = await runCapture("claude", [
    "-p", promptFor(text),
    "--json-schema", JSON.stringify(ASSERTIONS_JSON_SCHEMA),
    "--model", MODEL,
    // This is a text-to-JSON call. It has no business touching the filesystem.
    "--disallowed-tools", "Bash", "Edit", "Write", "Read",
  ], CLAUDE_OVERRIDING_ENV);
  return extractJson(stdout);
};

/**
 * Codex CLI. Writes the schema and reads the answer through a temp directory
 * because `codex exec` takes --output-schema as a FILE and reports its final
 * message with -o, rather than putting clean JSON on stdout.
 *
 * --skip-git-repo-check because codex otherwise refuses to run outside a
 * trusted git directory, and ingest has no reason to care where it was invoked.
 */
export const codexCliParse: ParseFn = async (text) => {
  const dir = await mkdtemp(join(tmpdir(), "claimrot-ingest-"));
  const schemaPath = join(dir, "schema.json");
  const outPath = join(dir, "out.json");
  try {
    await writeFile(schemaPath, JSON.stringify(ASSERTIONS_JSON_SCHEMA));
    await runCapture("codex", [
      "exec", promptFor(text),
      "--output-schema", schemaPath,
      "-o", outPath,
      "--sandbox", "read-only",
      "--skip-git-repo-check",
    ], CODEX_OVERRIDING_ENV);
    return extractJson(await readFile(outPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

export const BACKENDS: Record<BackendName, ParseFn> = {
  "api": apiParse,
  "claude-cli": claudeCliParse,
  "codex-cli": codexCliParse,
};

/**
 * Picks a backend, preferring an explicit choice and otherwise whatever this
 * machine can authenticate — CLIs first, API last.
 *
 * That order is about billing, not capability. A logged-in CLI draws on a
 * subscription the operator is already paying for; an API key meters per
 * token. Defaulting to the metered one merely because the variable happens to
 * be exported charges people for a choice they never made — and
 * `ANTHROPIC_API_KEY` is exported in a lot of shells for unrelated reasons.
 * `--backend api` is how you opt into being billed.
 *
 * The API is still the only backend CI can use, since the CLIs authenticate as
 * a logged-in human; CI sets --backend explicitly.
 */
export function selectBackend(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
  has: (bin: string) => boolean,
): { name: BackendName; parse: ParseFn } {
  const chosen = explicit ?? env.CLAIMROT_INGEST;
  if (chosen) {
    if (!(chosen in BACKENDS)) {
      throw new Error(
        `unknown ingest backend "${chosen}" — expected one of ${Object.keys(BACKENDS).join(", ")}`);
    }
    const name = chosen as BackendName;
    return { name, parse: BACKENDS[name] };
  }

  if (has("claude")) return { name: "claude-cli", parse: claudeCliParse };
  if (has("codex")) return { name: "codex-cli", parse: codexCliParse };
  if (env.ANTHROPIC_API_KEY) return { name: "api", parse: apiParse };

  throw new Error(
    "no ingest backend available: log into the claude or codex CLI, or set " +
    "ANTHROPIC_API_KEY and pass --backend api. Only `ingest` needs this — " +
    "`check` and `report` do not.");
}
