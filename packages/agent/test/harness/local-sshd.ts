import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ConnectConfig } from "ssh2";
import { SshExecutionEnv } from "../../src/harness/env/ssh.ts";
import { getOrThrow } from "../../src/harness/types.ts";

const execFileAsync = promisify(execFile);

export interface LocalSshd {
	root: string;
	cwd: string;
	connection: ConnectConfig;
	env: SshExecutionEnv;
	stop: () => Promise<void>;
}

async function getFreePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => {
				if (typeof address === "object" && address) resolve(address.port);
				else reject(new Error("failed to allocate local port"));
			});
		});
	});
}

async function generateKey(path: string, type: "ed25519" | "rsa"): Promise<void> {
	await execFileAsync("ssh-keygen", ["-q", "-t", type, "-N", "", "-f", path]);
}

async function waitForSshd(connection: ConnectConfig, cwd: string, tempRoot: string): Promise<SshExecutionEnv> {
	let lastError: Error | undefined;
	for (let attempt = 0; attempt < 50; attempt++) {
		const result = await SshExecutionEnv.create({ connection, cwd, tempRoot });
		if (result.ok) return result.value;
		lastError = result.error;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw lastError ?? new Error("sshd did not become ready");
}

export async function startLocalSshd(): Promise<LocalSshd | null> {
	const sshdPath = "/usr/sbin/sshd";
	if (!existsSync(sshdPath)) return null;

	const root = await mkdtemp(join(tmpdir(), "pi-local-sshd-"));
	const realRoot = await realpath(root);
	const realTempRoot = await realpath(tmpdir());
	const cwd = join(realRoot, "cwd");
	await mkdir(cwd, { recursive: true });

	const clientKey = join(root, "client_ed25519");
	const hostKey = join(root, "host_ed25519");
	await generateKey(clientKey, "ed25519");
	await generateKey(hostKey, "ed25519");

	const authorizedKeys = join(root, "authorized_keys");
	const clientPublicKey = await readFile(`${clientKey}.pub`, "utf-8");
	await writeFile(authorizedKeys, clientPublicKey, "utf-8");

	const port = await getFreePort();
	const configPath = join(root, "sshd_config");
	const pidPath = join(root, "sshd.pid");
	const logPath = join(root, "sshd.log");
	const username = userInfo().username;
	await writeFile(
		configPath,
		[
			`Port ${port}`,
			"ListenAddress 127.0.0.1",
			`HostKey ${hostKey}`,
			`PidFile ${pidPath}`,
			`AuthorizedKeysFile ${authorizedKeys}`,
			"PasswordAuthentication no",
			"KbdInteractiveAuthentication no",
			"PubkeyAuthentication yes",
			"StrictModes no",
			"UsePAM no",
			"AcceptEnv *",
			`AllowUsers ${username}`,
			"Subsystem sftp internal-sftp",
			"LogLevel ERROR",
			"",
		].join("\n"),
		"utf-8",
	);

	let process: ChildProcess | undefined = spawn(sshdPath, ["-D", "-f", configPath, "-E", logPath], {
		stdio: ["ignore", "ignore", "ignore"],
	});

	const connection: ConnectConfig = {
		host: "127.0.0.1",
		port,
		username,
		privateKey: await readFile(clientKey),
		readyTimeout: 2000,
	};

	try {
		const env = await waitForSshd(connection, cwd, realTempRoot);
		return {
			root: realRoot,
			cwd,
			connection,
			env,
			stop: async () => {
				await env.cleanup();
				process?.kill();
				process = undefined;
				await rm(realRoot, { recursive: true, force: true });
			},
		};
	} catch (error) {
		process?.kill();
		await rm(realRoot, { recursive: true, force: true });
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`failed to start local sshd: ${message}`);
	}
}

export async function expectLocalSshd(): Promise<LocalSshd> {
	const server = await startLocalSshd();
	if (!server) throw new Error("local sshd is not available");
	getOrThrow(await server.env.exists("."));
	return server;
}
