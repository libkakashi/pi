import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SshExecutionEnv } from "../../agent/src/env.ts";
import { expectLocalSshd, type LocalSshd } from "../../agent/test/harness/local-sshd.ts";
import { processFileArguments } from "../src/cli/file-processor.ts";
import { createExecutionEnvToolOptions } from "../src/core/execution-env-tools.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "../src/core/tools/index.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}

describe("coding-agent SSH execution env integration", () => {
	let server: LocalSshd | undefined;
	let extraEnv: SshExecutionEnv | undefined;
	let localAgentDir: string | undefined;

	afterEach(async () => {
		if (extraEnv) {
			await extraEnv.cleanup();
			extraEnv = undefined;
		}
		if (server) {
			await server.stop();
			server = undefined;
		}
		if (localAgentDir) {
			rmSync(localAgentDir, { recursive: true, force: true });
			localAgentDir = undefined;
		}
	});

	it("routes built-in read, write, edit, bash, and ls tools through SshExecutionEnv", async () => {
		server = await expectLocalSshd();
		const options = createExecutionEnvToolOptions(server.env);

		const write = createWriteTool(server.cwd, options.write);
		const read = createReadTool(server.cwd, options.read);
		const edit = createEditTool(server.cwd, options.edit);
		const bash = createBashTool(server.cwd, options.bash);
		const ls = createLsTool(server.cwd, options.ls);

		expect(getTextOutput(await write.execute("write", { path: "src/file.txt", content: "hello world" }))).toContain(
			"Successfully wrote",
		);
		expect(getTextOutput(await read.execute("read", { path: "src/file.txt" }))).toContain("hello world");
		expect(
			getTextOutput(
				await edit.execute("edit", {
					path: "src/file.txt",
					edits: [{ oldText: "hello", newText: "remote" }],
				}),
			),
		).toContain("Successfully replaced");
		expect(getTextOutput(await bash.execute("bash", { command: "cat src/file.txt" }))).toContain("remote world");

		const listed = await ls.execute("ls", { path: "src" });
		expect(getTextOutput(listed)).toContain("file.txt");
	});

	it("loads project resources and @file attachments through SshExecutionEnv", async () => {
		server = await expectLocalSshd();
		localAgentDir = join(tmpdir(), `pi-agent-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(localAgentDir, { recursive: true });

		await server.env.writeFile("AGENTS.md", "remote project instructions");
		await server.env.writeFile(".pi/skills/example/SKILL.md", "---\nname: example\ndescription: Remote skill\n---\n");
		await server.env.writeFile(".pi/prompts/review.md", "---\ndescription: Remote prompt\n---\nReview {{target}}\n");
		await server.env.writeFile(
			".pi/themes/remote.json",
			readFileSync("src/modes/interactive/theme/dark.json", "utf-8").replace('"name": "dark"', '"name": "remote"'),
		);
		await server.env.writeFile("input.txt", "remote input");

		const loader = new DefaultResourceLoader({
			cwd: server.cwd,
			agentDir: localAgentDir,
			settingsManager: SettingsManager.inMemory(),
			executionEnv: server.env,
			noExtensions: true,
		});
		await loader.reload();

		expect(loader.getAgentsFiles().agentsFiles).toEqual([
			{ path: `${server.cwd}/AGENTS.md`, content: "remote project instructions" },
		]);
		expect(loader.getSkills().skills.map((skill) => skill.name)).toContain("example");
		expect(loader.getPrompts().prompts.map((prompt) => prompt.name)).toContain("review");
		expect(loader.getThemes().themes.map((theme) => theme.name)).toContain("remote");

		const processed = await processFileArguments(["input.txt"], { executionEnv: server.env });
		expect(processed.text).toContain("remote input");

		await server.env.writeFile("image.png", Buffer.from(TINY_PNG_BASE64, "base64"));
		const imageProcessed = await processFileArguments(["image.png"], {
			executionEnv: server.env,
			autoResizeImages: false,
		});
		expect(imageProcessed.images).toHaveLength(1);
		expect(imageProcessed.images[0]).toMatchObject({ type: "image", mimeType: "image/png" });
	});

	it("routes grep and find through remote search commands", async () => {
		server = await expectLocalSshd();
		await server.env.writeFile(
			"bin/fd",
			`#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--max-results" ]; then shift 2; continue; fi
  if [ "$1" = "--" ]; then shift; break; fi
  shift
done
pattern="$1"
root="$2"
find "$root" -type f -name "$pattern" | sed 's#^\\./##'
`,
		);
		await server.env.writeFile(
			"bin/rg",
			`#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then shift; break; fi
  shift
done
pattern="$1"
root="$2"
find "$root" -type f | while IFS= read -r file; do
  awk -v pat="$pattern" -v file="$file" '
    index($0, pat) {
      line = $0
      gsub(/\\\\/, "\\\\\\\\", line)
      gsub(/"/, "\\\\\\"", line)
      gsub(/\\\\/, "\\\\\\\\", file)
      gsub(/"/, "\\\\\\"", file)
      printf("{\\"type\\":\\"match\\",\\"data\\":{\\"path\\":{\\"text\\":\\"%s\\"},\\"line_number\\":%d,\\"lines\\":{\\"text\\":\\"%s\\\\n\\"}}}\\n", file, NR, line)
    }
  ' "$file"
done
`,
		);
		await server.env.exec("chmod +x bin/fd bin/rg");
		await server.env.writeFile("search/a.txt", "alpha\nneedle one\n");
		await server.env.writeFile("search/b.md", "needle two\n");

		const created = await SshExecutionEnv.create({
			connection: server.connection,
			cwd: server.cwd,
			shellEnv: { PATH: `${server.cwd}/bin:/usr/bin:/bin:/usr/sbin:/sbin` },
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		extraEnv = created.value;
		const options = createExecutionEnvToolOptions(extraEnv);
		const find = createFindTool(server.cwd, options.find);
		const grep = createGrepTool(server.cwd, options.grep);

		expect(getTextOutput(await find.execute("find", { pattern: "*.txt", path: "search" }))).toContain("a.txt");
		const grepOutput = getTextOutput(await grep.execute("grep", { pattern: "needle", path: "search" }));
		expect(grepOutput).toContain("a.txt:2: needle one");
		expect(grepOutput).toContain("b.md:1: needle two");
	});
});
