import { randomUUID } from "node:crypto";
import { posix as path } from "node:path";
import ssh2, {
	type ClientChannel,
	type ConnectConfig,
	type FileEntryWithStats,
	type SFTPWrapper,
	type Stats,
} from "ssh2";
import {
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileInfo,
	type FileKind,
	type FuzzySearchFileEntry,
	type FuzzySearchFilesOptions,
	ok,
	type Result,
	toError,
} from "../types.ts";

type SshClient = InstanceType<typeof ssh2.Client>;

export interface SshExecutionEnvOptions {
	/** ssh2 connection configuration. */
	connection: ConnectConfig;
	/** Remote working directory. */
	cwd: string;
	/** Remote temp root used by createTempDir/createTempFile. Defaults to /tmp. */
	tempRoot?: string;
	/** Base environment forwarded to SSH exec requests. */
	shellEnv?: Record<string, string>;
}

export interface CreateSshExecutionEnvOptions extends Omit<SshExecutionEnvOptions, "cwd"> {
	/** Remote working directory. If omitted, resolves to the server's SFTP realpath("."). */
	cwd?: string;
}

function resolvePath(cwd: string, filePath: string): string {
	return path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(cwd, filePath);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellEnvAssignment(key: string, value: string): string {
	return `${key}=${shellQuote(value)}`;
}

function fileKindFromStats(stats: Stats): FileKind | undefined {
	if (stats.isFile()) return "file";
	if (stats.isDirectory()) return "directory";
	if (stats.isSymbolicLink()) return "symlink";
	return undefined;
}

function fileInfoFromStats(filePath: string, stats: Stats): Result<FileInfo, FileError> {
	const kind = fileKindFromStats(stats);
	if (!kind) return err(new FileError("invalid", "Unsupported file type", filePath));
	return ok({
		name: path.basename(filePath),
		path: filePath,
		kind,
		size: stats.size,
		mtimeMs: stats.mtime * 1000,
	});
}

function isErrorWithCode(error: unknown): error is Error & { code?: unknown } {
	return error instanceof Error && "code" in error;
}

function toFileError(error: unknown, filePath?: string): FileError {
	if (error instanceof FileError) {
		return error.path || !filePath ? error : new FileError(error.code, error.message, filePath, error);
	}
	const cause = toError(error);
	const code = isErrorWithCode(error) ? error.code : undefined;
	if (
		code === ssh2.utils.sftp.STATUS_CODE.NO_SUCH_FILE ||
		code === "ENOENT" ||
		code === "NO_SUCH_FILE" ||
		code === "No such file"
	) {
		return new FileError("not_found", cause.message, filePath, cause);
	}
	if (code === ssh2.utils.sftp.STATUS_CODE.PERMISSION_DENIED || code === "EACCES" || code === "EPERM") {
		return new FileError("permission_denied", cause.message, filePath, cause);
	}
	if (code === ssh2.utils.sftp.STATUS_CODE.OP_UNSUPPORTED) {
		return new FileError("not_supported", cause.message, filePath, cause);
	}
	if (code === "ENOTDIR") return new FileError("not_directory", cause.message, filePath, cause);
	if (code === "EISDIR") return new FileError("is_directory", cause.message, filePath, cause);
	return new FileError("unknown", cause.message, filePath, cause);
}

function abortFileResult<TValue>(
	signal: AbortSignal | undefined,
	filePath?: string,
): Result<TValue, FileError> | undefined {
	return signal?.aborted ? err(new FileError("aborted", "aborted", filePath)) : undefined;
}

function abortExecutionResult<TValue>(signal: AbortSignal | undefined): Result<TValue, ExecutionError> | undefined {
	return signal?.aborted ? err(new ExecutionError("aborted", "aborted")) : undefined;
}

function sshCallbackResult<TValue>(
	invoke: (callback: (error: Error | null | undefined, value: TValue) => void) => void,
): Promise<Result<TValue, FileError>> {
	return new Promise((resolve) => {
		try {
			invoke((error, value) => {
				if (error) resolve(err(toFileError(error)));
				else resolve(ok(value));
			});
		} catch (error) {
			resolve(err(toFileError(error)));
		}
	});
}

function sshVoidCallbackResult(
	invoke: (callback: (error?: Error | null) => void) => void,
): Promise<Result<void, FileError>> {
	return new Promise((resolve) => {
		try {
			invoke((error) => {
				if (error) resolve(err(toFileError(error)));
				else resolve(ok(undefined));
			});
		} catch (error) {
			resolve(err(toFileError(error)));
		}
	});
}

export class SshExecutionEnv implements ExecutionEnv {
	cwd: string;
	private connection: ConnectConfig;
	private client: SshClient | undefined;
	private connectPromise: Promise<Result<void, ExecutionError>> | undefined;
	private sftpPromise: Promise<Result<SFTPWrapper, FileError>> | undefined;
	private tempRoot: string;
	private shellEnv?: Record<string, string>;

	constructor(options: SshExecutionEnvOptions) {
		this.connection = {
			...options.connection,
			algorithms: {
				...options.connection.algorithms,
				compress: ["zlib@openssh.com", "zlib", "none"],
			},
		};
		this.cwd = path.normalize(options.cwd);
		this.tempRoot = options.tempRoot ?? "/tmp";
		this.shellEnv = options.shellEnv;
	}

	static async create(options: CreateSshExecutionEnvOptions): Promise<Result<SshExecutionEnv, ExecutionError>> {
		const env = new SshExecutionEnv({ ...options, cwd: options.cwd ?? "." });
		const ready = await env.ensureConnected();
		if (!ready.ok) return err(ready.error);
		if (!options.cwd) {
			const sftp = await env.getSftp();
			if (!sftp.ok) return err(new ExecutionError("unknown", sftp.error.message, sftp.error));
			const resolved = await env.sftpRealpath(sftp.value, ".");
			if (!resolved.ok) return err(new ExecutionError("unknown", resolved.error.message, resolved.error));
			env.cwd = resolved.value;
		}
		return ok(env);
	}

	async absolutePath(filePath: string): Promise<Result<string, FileError>> {
		return ok(resolvePath(this.cwd, filePath));
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(path.join(...parts));
	}

	async exec(
		command: string,
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			timeout?: number;
			abortSignal?: AbortSignal;
			onStdout?: (chunk: string) => void;
			onStderr?: (chunk: string) => void;
		},
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		const aborted = abortExecutionResult<{ stdout: string; stderr: string; exitCode: number }>(options?.abortSignal);
		if (aborted) return aborted;
		const connected = await this.ensureConnected();
		if (!connected.ok) return connected;
		const client = this.client;
		if (!client) return err(new ExecutionError("unknown", "SSH client is not connected"));

		const cwd = options?.cwd ? resolvePath(this.cwd, options.cwd) : this.cwd;
		const env = this.shellEnv || options?.env ? { ...this.shellEnv, ...options?.env } : undefined;
		const envPrefix = env
			? Object.entries(env)
					.filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
					.map(([key, value]) => `export ${shellEnvAssignment(key, value)};`)
					.join(" ")
			: "";
		const remoteCommand = `cd ${shellQuote(cwd)} && ${envPrefix ? `${envPrefix} ` : ""}${command}`;

		return await new Promise((resolve) => {
			let stdout = "";
			let stderr = "";
			let exitCode = 0;
			let settled = false;
			let timedOut = false;
			let callbackError: ExecutionError | undefined;
			let channel: ClientChannel | undefined;
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const onAbort = () => {
				channel?.close();
			};
			const settle = (result: Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.abortSignal) options.abortSignal.removeEventListener("abort", onAbort);
				if (settled) return;
				settled = true;
				resolve(result);
			};

			client.exec(remoteCommand, (error: Error | undefined, stream: ClientChannel) => {
				if (error) {
					settle(err(new ExecutionError("spawn_error", error.message, error)));
					return;
				}

				channel = stream;
				timeoutId =
					typeof options?.timeout === "number"
						? setTimeout(() => {
								timedOut = true;
								stream.close();
							}, options.timeout * 1000)
						: undefined;

				if (options?.abortSignal) {
					if (options.abortSignal.aborted) onAbort();
					else options.abortSignal.addEventListener("abort", onAbort, { once: true });
				}

				stream.setEncoding("utf8");
				stream.stderr.setEncoding("utf8");
				stream.on("data", (chunk: string) => {
					stdout += chunk;
					try {
						options?.onStdout?.(chunk);
					} catch (callbackUnknownError) {
						const cause = toError(callbackUnknownError);
						callbackError = new ExecutionError("callback_error", cause.message, cause);
						stream.close();
					}
				});
				stream.stderr.on("data", (chunk: string) => {
					stderr += chunk;
					try {
						options?.onStderr?.(chunk);
					} catch (callbackUnknownError) {
						const cause = toError(callbackUnknownError);
						callbackError = new ExecutionError("callback_error", cause.message, cause);
						stream.close();
					}
				});
				stream.on("exit", (codeOrNull: number | null) => {
					exitCode = codeOrNull ?? 0;
				});
				stream.on("close", () => {
					if (callbackError) {
						settle(err(callbackError));
					} else if (timedOut) {
						settle(err(new ExecutionError("timeout", `timeout:${options?.timeout}`)));
					} else if (options?.abortSignal?.aborted) {
						settle(err(new ExecutionError("aborted", "aborted")));
					} else {
						settle(ok({ stdout, stderr, exitCode }));
					}
				});
			});
		});
	}

	async readTextFile(filePath: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		const resolved = resolvePath(this.cwd, filePath);
		const aborted = abortFileResult<string>(abortSignal, resolved);
		if (aborted) return aborted;
		const bytes = await this.readBinaryFile(resolved, abortSignal);
		if (!bytes.ok) return err(bytes.error);
		return ok(Buffer.from(bytes.value).toString("utf8"));
	}

	async readTextLines(
		filePath: string,
		options?: { maxLines?: number; abortSignal?: AbortSignal },
	): Promise<Result<string[], FileError>> {
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		const content = await this.readTextFile(filePath, options?.abortSignal);
		if (!content.ok) return err(content.error);
		const lines = content.value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
		return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
	}

	async readBinaryFile(filePath: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
		const resolved = resolvePath(this.cwd, filePath);
		const aborted = abortFileResult<Uint8Array>(abortSignal, resolved);
		if (aborted) return aborted;
		const sftp = await this.getSftp();
		if (!sftp.ok) return err(sftp.error);
		const result = await sshCallbackResult<Buffer>((callback) => sftp.value.readFile(resolved, callback));
		if (!result.ok) return err(toFileError(result.error, resolved));
		return ok(result.value);
	}

	async writeFile(
		filePath: string,
		content: string | Uint8Array,
		abortSignal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, filePath);
		const aborted = abortFileResult<void>(abortSignal, resolved);
		if (aborted) return aborted;
		const parent = await this.createDir(path.dirname(resolved), { recursive: true, abortSignal });
		if (!parent.ok) return parent;
		const sftp = await this.getSftp();
		if (!sftp.ok) return err(sftp.error);
		const data = typeof content === "string" ? content : Buffer.from(content);
		const result = await sshVoidCallbackResult((callback) => sftp.value.writeFile(resolved, data, callback));
		if (!result.ok) return err(toFileError(result.error, resolved));
		return result;
	}

	async appendFile(
		filePath: string,
		content: string | Uint8Array,
		abortSignal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, filePath);
		const aborted = abortFileResult<void>(abortSignal, resolved);
		if (aborted) return aborted;
		const parent = await this.createDir(path.dirname(resolved), { recursive: true, abortSignal });
		if (!parent.ok) return parent;
		const sftp = await this.getSftp();
		if (!sftp.ok) return err(sftp.error);
		const data = typeof content === "string" ? content : Buffer.from(content);
		const result = await sshVoidCallbackResult((callback) => sftp.value.appendFile(resolved, data, callback));
		if (!result.ok) return err(toFileError(result.error, resolved));
		return result;
	}

	async fileInfo(filePath: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
		const resolved = resolvePath(this.cwd, filePath);
		const aborted = abortFileResult<FileInfo>(abortSignal, resolved);
		if (aborted) return aborted;
		const sftp = await this.getSftp();
		if (!sftp.ok) return err(sftp.error);
		const stats = await this.sftpLstat(sftp.value, resolved);
		if (!stats.ok) return err(toFileError(stats.error, resolved));
		return fileInfoFromStats(resolved, stats.value);
	}

	async listDir(filePath: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
		const resolved = resolvePath(this.cwd, filePath);
		const aborted = abortFileResult<FileInfo[]>(abortSignal, resolved);
		if (aborted) return aborted;
		const sftp = await this.getSftp();
		if (!sftp.ok) return err(sftp.error);
		const entries = await sshCallbackResult<FileEntryWithStats[]>((callback) =>
			sftp.value.readdir(resolved, callback),
		);
		if (!entries.ok) {
			const info = await this.fileInfo(resolved, abortSignal);
			if (info.ok && info.value.kind !== "directory") {
				return err(new FileError("not_directory", `Not a directory: ${resolved}`, resolved));
			}
			return err(toFileError(entries.error, resolved));
		}
		return ok(
			entries.value
				.map((entry) => fileInfoFromStats(path.join(resolved, entry.filename), entry.attrs))
				.filter((info): info is Result<FileInfo, FileError> & { ok: true } => info.ok)
				.map((info) => info.value),
		);
	}

	async fuzzySearchFiles(options?: FuzzySearchFilesOptions): Promise<Result<FuzzySearchFileEntry[], FileError>> {
		const baseDir = resolvePath(this.cwd, options?.baseDir ?? this.cwd);
		const maxResults = options?.maxResults ?? 100;
		const includeHidden = options?.includeHidden ?? true;
		const followSymlinks = options?.followSymlinks ?? true;
		const exclude = options?.exclude ?? [".git"];
		const query = options?.query ?? "";
		const aborted = abortFileResult<FuzzySearchFileEntry[]>(options?.abortSignal, baseDir);
		if (aborted) return aborted;

		const pruneNames = [...exclude];
		if (!includeHidden) pruneNames.push(".*");
		const pruneExpression =
			pruneNames.length > 0
				? `\\( ${pruneNames.map((name) => `-name ${shellQuote(name)}`).join(" -o ")} \\) -prune -o`
				: "";
		const findFlags = followSymlinks ? "-L" : "";
		const hiddenFlag = includeHidden ? "--hidden" : "";
		const followFlag = followSymlinks ? "--follow" : "";
		const excludeFlags = exclude.map((name) => `--exclude ${shellQuote(name)}`).join(" ");
		const classifyPaths = [
			"while IFS= read -r p; do",
			'rel="$' + '{p#./}";',
			'if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git check-ignore -q -- "$rel"; then continue; fi;',
			'if [ -d "$p" ]; then kind=directory; elif [ -f "$p" ]; then kind=file; elif [ -L "$p" ]; then kind=symlink; else continue; fi;',
			'printf \'%s\\t%s\\n\' "$kind" "$rel";',
			"done",
		].join(" ");
		const portableFind = [
			"find",
			findFlags,
			".",
			pruneExpression,
			"\\(",
			"-type f -o -type d -o -type l",
			"\\)",
			"-print",
			"|",
			"awk",
			shellQuote(
				`BEGIN { q = tolower(${JSON.stringify(query)}); limit = ${maxResults}; count = 0 }
{
	path = $0;
	sub(/^\\.\\//, "", path);
	if (path == "") next;
	lower = tolower(path);
	if (q != "" && index(lower, q) == 0) next;
	print $0;
	count++;
	if (count >= limit) exit;
}`,
			),
			"|",
			classifyPaths,
		]
			.filter(Boolean)
			.join(" ");
		const gnuFind = [
			"find",
			findFlags,
			".",
			pruneExpression,
			"\\(",
			"-type f -o -type d -o -type l",
			"\\)",
			"-printf '%p\\n'",
			"|",
			"awk",
			shellQuote(
				`BEGIN { q = tolower(${JSON.stringify(query)}); limit = ${maxResults}; count = 0 }
{
	path = $0;
	sub(/^\\.\\//, "", path);
	if (path == "") next;
	lower = tolower(path);
	if (q != "" && index(lower, q) == 0) next;
	print $0;
	count++;
	if (count >= limit) exit;
}`,
			),
			"|",
			classifyPaths,
		]
			.filter(Boolean)
			.join(" ");
		const fd = [
			"fd",
			"--color never",
			"--strip-cwd-prefix",
			"-F",
			hiddenFlag,
			followFlag,
			excludeFlags,
			"--max-results",
			String(maxResults),
			"--type f --type d --type l",
			"--",
			shellQuote(query),
			".",
			"|",
			classifyPaths,
		]
			.filter(Boolean)
			.join(" ");
		const command = [
			`cd ${shellQuote(baseDir)}`,
			"&&",
			`if command -v fd >/dev/null 2>&1; then ${fd};`,
			`elif find --version >/dev/null 2>&1; then ${gnuFind};`,
			`else ${portableFind}; fi`,
		]
			.filter(Boolean)
			.join(" ");
		const result = await this.exec(command, { timeout: 10, abortSignal: options?.abortSignal });
		if (!result.ok) {
			return err(
				new FileError(
					result.error.code === "aborted" ? "aborted" : "unknown",
					result.error.message,
					baseDir,
					result.error,
				),
			);
		}
		if (result.value.exitCode !== 0) {
			return err(new FileError("unknown", result.value.stderr || `find exited ${result.value.exitCode}`, baseDir));
		}

		const entries: FuzzySearchFileEntry[] = [];
		for (const line of result.value.stdout.split(/\r?\n/)) {
			if (!line) continue;
			const tabIndex = line.indexOf("\t");
			if (tabIndex === -1) continue;
			const kind = line.slice(0, tabIndex) as FileKind;
			let entryPath = line.slice(tabIndex + 1);
			if (kind === "directory" && !entryPath.endsWith("/")) {
				entryPath = `${entryPath}/`;
			}
			entries.push({ path: entryPath, kind });
		}
		return ok(entries);
	}

	async canonicalPath(filePath: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		const resolved = resolvePath(this.cwd, filePath);
		const aborted = abortFileResult<string>(abortSignal, resolved);
		if (aborted) return aborted;
		const sftp = await this.getSftp();
		if (!sftp.ok) return err(sftp.error);
		const real = await this.sftpRealpath(sftp.value, resolved);
		if (!real.ok) return err(toFileError(real.error, resolved));
		return real;
	}

	async exists(filePath: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>> {
		const info = await this.fileInfo(filePath, abortSignal);
		if (info.ok) return ok(true);
		if (info.error.code === "not_found") return ok(false);
		return err(info.error);
	}

	async createDir(
		filePath: string,
		options?: { recursive?: boolean; abortSignal?: AbortSignal },
	): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, filePath);
		const aborted = abortFileResult<void>(options?.abortSignal, resolved);
		if (aborted) return aborted;
		const sftp = await this.getSftp();
		if (!sftp.ok) return err(sftp.error);
		if ((options?.recursive ?? true) === true) {
			return this.createDirRecursive(sftp.value, resolved, options?.abortSignal);
		}
		const result = await sshVoidCallbackResult((callback) => sftp.value.mkdir(resolved, callback));
		if (!result.ok) return err(toFileError(result.error, resolved));
		return result;
	}

	async remove(
		filePath: string,
		options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
	): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, filePath);
		const aborted = abortFileResult<void>(options?.abortSignal, resolved);
		if (aborted) return aborted;
		const sftp = await this.getSftp();
		if (!sftp.ok) return err(sftp.error);
		const info = await this.fileInfo(resolved, options?.abortSignal);
		if (!info.ok) {
			if (options?.force && info.error.code === "not_found") return ok(undefined);
			return err(info.error);
		}
		if (info.value.kind === "directory") {
			if (options?.recursive) {
				const entries = await this.listDir(resolved, options.abortSignal);
				if (!entries.ok) return err(entries.error);
				for (const entry of entries.value) {
					const child = await this.remove(entry.path, options);
					if (!child.ok) return child;
				}
			}
			const result = await sshVoidCallbackResult((callback) => sftp.value.rmdir(resolved, callback));
			if (!result.ok) return err(toFileError(result.error, resolved));
			return result;
		}
		const result = await sshVoidCallbackResult((callback) => sftp.value.unlink(resolved, callback));
		if (!result.ok) return err(toFileError(result.error, resolved));
		return result;
	}

	async createTempDir(prefix: string = "tmp-", abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		for (let i = 0; i < 10; i++) {
			const candidate = path.join(this.tempRoot, `${prefix}${randomUUID()}`);
			const created = await this.createDir(candidate, { recursive: false, abortSignal });
			if (created.ok) return ok(candidate);
			if (created.error.code !== "unknown") return err(created.error);
		}
		return err(new FileError("unknown", "Failed to create unique remote temporary directory", this.tempRoot));
	}

	async createTempFile(options?: {
		prefix?: string;
		suffix?: string;
		abortSignal?: AbortSignal;
	}): Promise<Result<string, FileError>> {
		for (let i = 0; i < 10; i++) {
			const candidate = path.join(this.tempRoot, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
			const exists = await this.exists(candidate, options?.abortSignal);
			if (!exists.ok) return err(exists.error);
			if (exists.value) continue;
			const written = await this.writeFile(candidate, "", options?.abortSignal);
			if (written.ok) return ok(candidate);
			if (written.error.code !== "not_found") return err(written.error);
		}
		return err(new FileError("unknown", "Failed to create unique remote temporary file", this.tempRoot));
	}

	async cleanup(): Promise<void> {
		this.sftpPromise = undefined;
		this.connectPromise = undefined;
		this.client?.end();
		this.client = undefined;
	}

	private ensureConnected(): Promise<Result<void, ExecutionError>> {
		if (this.connectPromise) return this.connectPromise;
		this.client = new ssh2.Client();
		const client = this.client;
		this.connectPromise = new Promise((resolve) => {
			let settled = false;
			const settle = (result: Result<void, ExecutionError>) => {
				if (settled) return;
				settled = true;
				client.removeAllListeners("ready");
				client.removeAllListeners("error");
				resolve(result);
			};
			client.once("ready", () => settle(ok(undefined)));
			client.once("error", (error: Error) => settle(err(new ExecutionError("spawn_error", error.message, error))));
			client.once("close", () => {
				this.connectPromise = undefined;
				this.sftpPromise = undefined;
				if (this.client === client) this.client = undefined;
			});
			client.connect(this.connection);
		});
		return this.connectPromise;
	}

	private async getSftp(): Promise<Result<SFTPWrapper, FileError>> {
		const connected = await this.ensureConnected();
		if (!connected.ok) return err(new FileError("unknown", connected.error.message, undefined, connected.error));
		const client = this.client;
		if (!client) return err(new FileError("unknown", "SSH client is not connected"));
		if (this.sftpPromise) return this.sftpPromise;
		this.sftpPromise = new Promise((resolve) => {
			client.sftp((error: Error | undefined, sftp: SFTPWrapper) => {
				if (error) resolve(err(toFileError(error)));
				else resolve(ok(sftp));
			});
		});
		return this.sftpPromise;
	}

	private async createDirRecursive(
		sftp: SFTPWrapper,
		resolved: string,
		abortSignal: AbortSignal | undefined,
	): Promise<Result<void, FileError>> {
		if (resolved === "/") return ok(undefined);
		const parts = resolved.split("/").filter((part) => part.length > 0);
		let current = resolved.startsWith("/") ? "/" : "";
		for (const part of parts) {
			const aborted = abortFileResult<void>(abortSignal, resolved);
			if (aborted) return aborted;
			current = current === "/" ? `/${part}` : path.join(current, part);
			const stats = await this.sftpLstat(sftp, current);
			if (stats.ok) {
				if (!stats.value.isDirectory())
					return err(new FileError("not_directory", `Not a directory: ${current}`, current));
				continue;
			}
			if (stats.error.code !== "not_found") return err(stats.error);
			const created = await sshVoidCallbackResult((callback) => sftp.mkdir(current, callback));
			if (!created.ok) return err(toFileError(created.error, current));
		}
		return ok(undefined);
	}

	private sftpLstat(sftp: SFTPWrapper, filePath: string): Promise<Result<Stats, FileError>> {
		return sshCallbackResult<Stats>((callback) => sftp.lstat(filePath, callback)).then((result) =>
			result.ok ? result : err(toFileError(result.error, filePath)),
		);
	}

	private sftpRealpath(sftp: SFTPWrapper, filePath: string): Promise<Result<string, FileError>> {
		return sshCallbackResult<string>((callback) => sftp.realpath(filePath, callback)).then((result) =>
			result.ok ? result : err(toFileError(result.error, filePath)),
		);
	}
}
