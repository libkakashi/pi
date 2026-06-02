import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { basename, dirname } from "path";
import { CONFIG_DIR_NAME } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";

export interface PromptTemplate {
	name: string;
	description: string;
	argumentHint?: string;
	content: string;
	sourceInfo: SourceInfo;
	filePath: string;
}

export interface LoadPromptTemplatesOptions {
	cwd: string;
	agentDir: string;
	promptPaths: string[];
	includeDefaults: boolean;
	executionEnv: ExecutionEnv;
}

export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];

		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (/\s/.test(char)) {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}

	if (current) {
		args.push(current);
	}

	return args;
}

export function substituteArgs(content: string, args: string[]): string {
	let result = content;

	result = result.replace(/\$(\d+)/g, (_, num) => {
		const index = parseInt(num, 10) - 1;
		return args[index] ?? "";
	});

	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
		let start = parseInt(startStr, 10) - 1;
		if (start < 0) start = 0;

		if (lengthStr) {
			const length = parseInt(lengthStr, 10);
			return args.slice(start, start + length).join(" ");
		}
		return args.slice(start).join(" ");
	});

	const allArgs = args.join(" ");
	result = result.replace(/\$ARGUMENTS/g, allArgs);
	result = result.replace(/\$@/g, allArgs);

	return result;
}

async function envJoin(env: ExecutionEnv, parts: string[]): Promise<string> {
	const joined = await env.joinPath(parts);
	return joined.ok ? joined.value : parts.join("/");
}

async function resolveEnvPath(env: ExecutionEnv, path: string): Promise<string> {
	const resolved = await env.absolutePath(path);
	return resolved.ok ? resolved.value : path;
}

function isUnderEnvPath(target: string, root: string): boolean {
	if (target === root) return true;
	const prefix = root.endsWith("/") ? root : `${root}/`;
	return target.startsWith(prefix);
}

async function loadTemplateFromFile(
	env: ExecutionEnv,
	filePath: string,
	sourceInfo: SourceInfo,
): Promise<PromptTemplate | null> {
	const rawContent = await env.readTextFile(filePath);
	if (!rawContent.ok) {
		return null;
	}

	try {
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(rawContent.value);
		const name = basename(filePath).replace(/\.md$/, "");

		let description = frontmatter.description || "";
		if (!description) {
			const firstLine = body.split("\n").find((line) => line.trim());
			if (firstLine) {
				description = firstLine.slice(0, 60);
				if (firstLine.length > 60) description += "...";
			}
		}

		return {
			name,
			description,
			...(frontmatter["argument-hint"] && { argumentHint: frontmatter["argument-hint"] }),
			content: body,
			sourceInfo,
			filePath,
		};
	} catch {
		return null;
	}
}

async function loadTemplatesFromDir(
	env: ExecutionEnv,
	dir: string,
	getSourceInfo: (filePath: string) => SourceInfo,
): Promise<PromptTemplate[]> {
	const templates: PromptTemplate[] = [];
	const entries = await env.listDir(dir);
	if (!entries.ok) {
		return templates;
	}

	const loaded = await Promise.all(
		entries.value.map(async (entry) => {
			if (entry.kind !== "file" || !entry.name.endsWith(".md")) return null;
			return await loadTemplateFromFile(env, entry.path, getSourceInfo(entry.path));
		}),
	);
	for (const template of loaded) {
		if (template) {
			templates.push(template);
		}
	}

	return templates;
}

export async function loadPromptTemplates(options: LoadPromptTemplatesOptions): Promise<PromptTemplate[]> {
	const env = options.executionEnv;
	const resolvedCwd = await resolveEnvPath(env, options.cwd);
	const resolvedAgentDir = await resolveEnvPath(env, options.agentDir);
	const templates: PromptTemplate[] = [];
	const globalPromptsDir = await envJoin(env, [resolvedAgentDir, "prompts"]);
	const projectPromptsDir = await envJoin(env, [resolvedCwd, CONFIG_DIR_NAME, "prompts"]);

	const getSourceInfo = (resolvedPath: string): SourceInfo => {
		if (isUnderEnvPath(resolvedPath, globalPromptsDir)) {
			return createSyntheticSourceInfo(resolvedPath, {
				source: "local",
				scope: "user",
				baseDir: globalPromptsDir,
			});
		}
		if (isUnderEnvPath(resolvedPath, projectPromptsDir)) {
			return createSyntheticSourceInfo(resolvedPath, {
				source: "local",
				scope: "project",
				baseDir: projectPromptsDir,
			});
		}
		return createSyntheticSourceInfo(resolvedPath, {
			source: "local",
			baseDir: dirname(resolvedPath),
		});
	};

	if (options.includeDefaults) {
		const [globalTemplates, projectTemplates] = await Promise.all([
			loadTemplatesFromDir(env, globalPromptsDir, getSourceInfo),
			loadTemplatesFromDir(env, projectPromptsDir, getSourceInfo),
		]);
		templates.push(...globalTemplates, ...projectTemplates);
	}

	const pathTemplates = await Promise.all(
		options.promptPaths.map(async (rawPath) => {
			const resolvedPath = await resolveEnvPath(env, rawPath);
			const info = await env.fileInfo(resolvedPath);
			if (!info.ok) return [];
			if (info.value.kind === "directory") {
				return await loadTemplatesFromDir(env, resolvedPath, getSourceInfo);
			} else if (info.value.kind === "file" && resolvedPath.endsWith(".md")) {
				const template = await loadTemplateFromFile(env, resolvedPath, getSourceInfo(resolvedPath));
				if (template) {
					return [template];
				}
			}
			return [];
		}),
	);
	for (const pathResult of pathTemplates) {
		templates.push(...pathResult);
	}

	return templates;
}

export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
	if (!text.startsWith("/")) return text;

	const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
	if (!match) return text;

	const templateName = match[1];
	const argsString = match[2] ?? "";
	const template = templates.find((t) => t.name === templateName);
	if (!template) return text;

	const args = parseCommandArgs(argsString);
	return substituteArgs(template.content, args);
}
