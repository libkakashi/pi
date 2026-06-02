import type { ExecutionEnv, FileError, Result } from "@earendil-works/pi-agent-core";
import { detectSupportedImageMimeType } from "../utils/mime.ts";
import type {
	BashOperations,
	EditOperations,
	FindOperations,
	GrepOperations,
	LsOperations,
	ReadOperations,
	ToolsOptions,
	WriteOperations,
} from "./tools/index.ts";

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function throwFileError<T>(result: Result<T, FileError>): T {
	if (result.ok) return result.value;
	throw result.error;
}

function toBuffer(bytes: Uint8Array): Buffer {
	return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

function createReadOperationsFromEnv(env: ExecutionEnv): ReadOperations {
	return {
		readFile: async (path) => toBuffer(throwFileError(await env.readBinaryFile(path))),
		access: async (path) => {
			throwFileError(await env.fileInfo(path));
		},
		detectImageMimeType: async (path) => {
			const bytes = throwFileError(await env.readBinaryFile(path));
			return detectSupportedImageMimeType(bytes);
		},
	};
}

function createWriteOperationsFromEnv(env: ExecutionEnv): WriteOperations {
	return {
		writeFile: async (path, content) => {
			throwFileError(await env.writeFile(path, content));
		},
		mkdir: async (dir) => {
			throwFileError(await env.createDir(dir, { recursive: true }));
		},
		getMutationQueueKey: async (path) => path,
	};
}

function createEditOperationsFromEnv(env: ExecutionEnv): EditOperations {
	return {
		readFile: async (path) => toBuffer(throwFileError(await env.readBinaryFile(path))),
		writeFile: async (path, content) => {
			throwFileError(await env.writeFile(path, content));
		},
		access: async (path) => {
			throwFileError(await env.fileInfo(path));
		},
		getMutationQueueKey: async (path) => path,
	};
}

function createBashOperationsFromEnv(env: ExecutionEnv): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env: commandEnv }) => {
			const envOverrides: Record<string, string> = {};
			for (const [key, value] of Object.entries(commandEnv ?? {})) {
				if (value !== undefined) {
					envOverrides[key] = value;
				}
			}
			const result = await env.exec(command, {
				cwd,
				env: Object.keys(envOverrides).length > 0 ? envOverrides : undefined,
				timeout,
				abortSignal: signal,
				onStdout: (chunk) => onData(Buffer.from(chunk)),
				onStderr: (chunk) => onData(Buffer.from(chunk)),
			});
			if (!result.ok) throw result.error;
			return { exitCode: result.value.exitCode };
		},
	};
}

function createLsOperationsFromEnv(env: ExecutionEnv): LsOperations {
	return {
		exists: async (path) => throwFileError(await env.exists(path)),
		stat: async (path) => {
			const info = throwFileError(await env.fileInfo(path));
			return { isDirectory: () => info.kind === "directory" };
		},
		readdir: async (path) => throwFileError(await env.listDir(path)).map((entry) => entry.name),
	};
}

function createFindOperationsFromEnv(env: ExecutionEnv): FindOperations {
	return {
		exists: async (path) => throwFileError(await env.exists(path)),
		glob: async (pattern, cwd, options) => {
			const command = [
				"fd",
				"--hidden",
				"--exclude",
				shellQuote("node_modules"),
				"--exclude",
				shellQuote(".git"),
				"--glob",
				"--max-results",
				String(options.limit),
				"--",
				shellQuote(pattern),
				".",
			].join(" ");
			const result = await env.exec(command, { cwd });
			if (!result.ok) throw result.error;
			if (result.value.exitCode !== 0 && result.value.stdout.trim().length === 0) {
				return [];
			}
			return result.value.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
				.map((line) => (line.startsWith("/") ? line : `${cwd.replace(/\/+$/, "")}/${line.replace(/^\.\//, "")}`));
		},
	};
}

function createGrepOperationsFromEnv(env: ExecutionEnv): GrepOperations {
	return {
		isDirectory: async (path) => throwFileError(await env.fileInfo(path)).kind === "directory",
		readFile: async (path) => throwFileError(await env.readTextFile(path)),
		runRipgrep: async (args, options) => {
			const quotedArgs = args.map(shellQuote).join(" ");
			const result = await env.exec(`rg ${quotedArgs}`, {
				cwd: options.cwd,
				abortSignal: options.signal,
			});
			if (!result.ok) throw result.error;
			return result.value;
		},
	};
}

export function createExecutionEnvToolOptions(env: ExecutionEnv): ToolsOptions {
	return {
		read: { operations: createReadOperationsFromEnv(env) },
		bash: { operations: createBashOperationsFromEnv(env) },
		edit: { operations: createEditOperationsFromEnv(env) },
		write: { operations: createWriteOperationsFromEnv(env) },
		grep: { operations: createGrepOperationsFromEnv(env) },
		find: { operations: createFindOperationsFromEnv(env) },
		ls: { operations: createLsOperationsFromEnv(env) },
	};
}
