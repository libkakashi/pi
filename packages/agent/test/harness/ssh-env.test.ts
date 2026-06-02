import { afterEach, describe, expect, it } from "vitest";
import { FileError, getOrThrow } from "../../src/harness/types.ts";
import { expectLocalSshd, type LocalSshd } from "./local-sshd.ts";

let server: LocalSshd | undefined;

afterEach(async () => {
	if (server) {
		await server.stop();
		server = undefined;
	}
});

describe("SshExecutionEnv", () => {
	it("reads, writes, lists, and removes files and directories through local sshd", async () => {
		server = await expectLocalSshd();
		const env = server.env;

		expect(getOrThrow(await env.absolutePath("nested/child"))).toBe(`${server.cwd}/nested/child`);
		expect(getOrThrow(await env.joinPath([server.cwd, "nested", "child"]))).toBe(`${server.cwd}/nested/child`);
		getOrThrow(await env.createDir("nested/child"));
		getOrThrow(await env.writeFile("nested/child/file.txt", "hel"));
		getOrThrow(await env.appendFile("nested/child/file.txt", "lo"));
		expect(getOrThrow(await env.readTextFile("nested/child/file.txt"))).toBe("hello");
		expect(getOrThrow(await env.readTextLines("nested/child/file.txt", { maxLines: 1 }))).toEqual(["hello"]);
		expect(Buffer.from(getOrThrow(await env.readBinaryFile("nested/child/file.txt"))).toString("utf8")).toBe("hello");

		const entries = getOrThrow(await env.listDir("nested/child"));
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			name: "file.txt",
			path: `${server.cwd}/nested/child/file.txt`,
			kind: "file",
			size: 5,
		});
		expect(typeof entries[0]!.mtimeMs).toBe("number");

		expect(getOrThrow(await env.exists("nested/child/file.txt"))).toBe(true);
		getOrThrow(await env.remove("nested/child/file.txt"));
		expect(getOrThrow(await env.exists("nested/child/file.txt"))).toBe(false);
	});

	it("reports missing paths and non-directories as file errors", async () => {
		server = await expectLocalSshd();
		const env = server.env;

		const missing = await env.fileInfo("missing.txt");
		expect(missing.ok).toBe(false);
		if (!missing.ok) {
			expect(missing.error).toBeInstanceOf(FileError);
			expect(missing.error).toMatchObject({
				name: "FileError",
				code: "not_found",
				path: `${server.cwd}/missing.txt`,
			});
		}
		expect(getOrThrow(await env.exists("missing.txt"))).toBe(false);
		const read = await env.readTextFile("missing.txt");
		expect(read.ok).toBe(false);
		if (!read.ok) {
			expect(read.error).toMatchObject({
				code: "not_found",
				path: `${server.cwd}/missing.txt`,
			});
		}

		getOrThrow(await env.writeFile("file.txt", "hello"));
		const listed = await env.listDir("file.txt");
		expect(listed.ok).toBe(false);
		if (!listed.ok) expect(listed.error).toMatchObject({ code: "not_directory" });
	});

	it("fuzzy searches files through one remote execution", async () => {
		server = await expectLocalSshd();
		const env = server.env;

		getOrThrow(await env.writeFile("src/alpha.ts", "export {};"));
		getOrThrow(await env.writeFile("src/deeper/beta-alpha.ts", "export {};"));
		getOrThrow(await env.writeFile(".pi/config.json", "{}"));
		getOrThrow(await env.writeFile(".git/config", "[core]"));
		getOrThrow(await env.writeFile("outside/symlinked-alpha.ts", "export {};"));
		getOrThrow(await env.exec("ln -s outside linked"));

		const alpha = getOrThrow(await env.fuzzySearchFiles({ query: "alpha", maxResults: 20 }));
		expect(alpha.map((entry) => entry.path).sort()).toEqual([
			"linked/symlinked-alpha.ts",
			"outside/symlinked-alpha.ts",
			"src/alpha.ts",
			"src/deeper/beta-alpha.ts",
		]);

		expect(
			getOrThrow(await env.fuzzySearchFiles({ query: "config", maxResults: 20 })).map((entry) => entry.path),
		).toEqual([".pi/config.json"]);
	});

	it("fuzzy search respects gitignore while including untracked files", async () => {
		server = await expectLocalSshd();
		const env = server.env;
		getOrThrow(await env.exec("git init"));
		getOrThrow(await env.writeFile(".gitignore", "ignored.txt\nignored-dir/\n"));
		getOrThrow(await env.writeFile("visible.txt", "visible"));
		getOrThrow(await env.writeFile("ignored.txt", "ignored"));
		getOrThrow(await env.writeFile("ignored-dir/ignored-nested.txt", "ignored"));

		expect(
			getOrThrow(await env.fuzzySearchFiles({ query: "visible", maxResults: 20 })).map((entry) => entry.path),
		).toEqual(["visible.txt"]);
		expect(getOrThrow(await env.fuzzySearchFiles({ query: "ignored", maxResults: 20 }))).toEqual([]);
	});

	it("executes commands, streams output, and returns non-zero exit codes", async () => {
		server = await expectLocalSshd();
		const env = server.env;
		let stdout = "";
		let stderr = "";
		const result = getOrThrow(
			await env.exec('printf "%s:%s" "$PWD" "$SSH_ENV_TEST"; printf err >&2', {
				env: { SSH_ENV_TEST: "ok" },
				onStdout: (chunk) => {
					stdout += chunk;
				},
				onStderr: (chunk) => {
					stderr += chunk;
				},
			}),
		);

		expect(result).toEqual({ stdout: `${server.cwd}:ok`, stderr: "err", exitCode: 0 });
		expect(stdout).toBe(`${server.cwd}:ok`);
		expect(stderr).toBe("err");
		expect(getOrThrow(await env.exec("exit 7"))).toEqual({ stdout: "", stderr: "", exitCode: 7 });
	});

	it("returns timeout and callback errors", async () => {
		server = await expectLocalSshd();
		const env = server.env;

		const timeout = await env.exec("sleep 5", { timeout: 0.01 });
		expect(timeout.ok).toBe(false);
		if (!timeout.ok) expect(timeout.error).toMatchObject({ code: "timeout" });

		const callback = await env.exec("printf out", {
			onStdout: () => {
				throw new Error("callback failed");
			},
		});
		expect(callback.ok).toBe(false);
		if (!callback.ok) expect(callback.error).toMatchObject({ code: "callback_error", message: "callback failed" });
	});

	it("creates temporary directories and files through sftp", async () => {
		server = await expectLocalSshd();
		const env = server.env;

		const tempDir = getOrThrow(await env.createTempDir("ssh-env-test-"));
		expect(getOrThrow(await env.fileInfo(tempDir))).toMatchObject({ kind: "directory" });
		const tempFile = getOrThrow(await env.createTempFile({ prefix: "prefix-", suffix: ".txt" }));
		expect(tempFile.endsWith(".txt")).toBe(true);
		expect(getOrThrow(await env.fileInfo(tempFile))).toMatchObject({ kind: "file" });
	});
});
