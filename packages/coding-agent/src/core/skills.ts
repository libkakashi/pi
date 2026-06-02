import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import ignore from "ignore";
import { basename, dirname, relative, sep } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

async function envJoin(env: ExecutionEnv, parts: string[]): Promise<string> {
	const joined = await env.joinPath(parts);
	return joined.ok ? joined.value : parts.join("/");
}

async function resolveEnvPath(env: ExecutionEnv, path: string): Promise<string> {
	const resolved = await env.absolutePath(path);
	return resolved.ok ? resolved.value : path;
}

async function addIgnoreRules(env: ExecutionEnv, ig: IgnoreMatcher, dir: string, rootDir: string): Promise<void> {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	const patternGroups = await Promise.all(
		IGNORE_FILE_NAMES.map(async (filename) => {
			const ignorePath = await envJoin(env, [dir, filename]);
			const content = await env.readTextFile(ignorePath);
			if (!content.ok) return [];
			return content.value
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
		}),
	);
	for (const patterns of patternGroups) {
		if (patterns.length > 0) {
			ig.add(patterns);
		}
	}
}

export interface SkillFrontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
	[key: string]: unknown;
}

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	sourceInfo: SourceInfo;
	disableModelInvocation: boolean;
}

export interface LoadSkillsResult {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

/**
 * Validate skill name per Agent Skills spec.
 * Returns array of validation error messages (empty if valid).
 */
function validateName(name: string): string[] {
	const errors: string[] = [];

	if (name.length > MAX_NAME_LENGTH) {
		errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	}

	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
	}
	if (name.startsWith("-") || name.endsWith("-")) {
		errors.push(`name must not start or end with a hyphen`);
	}

	if (name.includes("--")) {
		errors.push(`name must not contain consecutive hyphens`);
	}

	return errors;
}

/**
 * Validate description per Agent Skills spec.
 */
function validateDescription(description: string | undefined): string[] {
	const errors: string[] = [];

	if (!description || description.trim() === "") {
		errors.push("description is required");
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}

	return errors;
}

export interface LoadSkillsFromDirOptions {
	/** Directory to scan for skills */
	dir: string;
	/** Source identifier for these skills */
	source: string;
	/** Execution environment for these skills */
	executionEnv: ExecutionEnv;
}

function createSkillSourceInfo(filePath: string, baseDir: string, source: string): SourceInfo {
	switch (source) {
		case "user":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "user",
				baseDir,
			});
		case "project":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "project",
				baseDir,
			});
		case "path":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				baseDir,
			});
		default:
			return createSyntheticSourceInfo(filePath, { source, baseDir });
	}
}

/**
 * Load skills from a directory.
 *
 * Discovery rules:
 * - if a directory contains SKILL.md, treat it as a skill root and do not recurse further
 * - otherwise, load direct .md children in the root
 * - recurse into subdirectories to find SKILL.md
 */
export async function loadSkillsFromDir(options: LoadSkillsFromDirOptions): Promise<LoadSkillsResult> {
	return await loadSkillsFromDirInternal(options.executionEnv, options.dir, options.source, true);
}

async function loadSkillsFromDirInternal(
	env: ExecutionEnv,
	dir: string,
	source: string,
	includeRootFiles: boolean,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): Promise<LoadSkillsResult> {
	const skills: Skill[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	await addIgnoreRules(env, ig, dir, root);

	const listed = await env.listDir(dir);
	if (!listed.ok) {
		return { skills, diagnostics };
	}

	for (const entry of listed.value) {
		if (entry.name !== "SKILL.md" || entry.kind !== "file") continue;
		const relPath = toPosixPath(relative(root, entry.path));
		if (ig.ignores(relPath)) continue;
		const result = await loadSkillFromFile(env, entry.path, source);
		if (result.skill) skills.push(result.skill);
		diagnostics.push(...result.diagnostics);
		return { skills, diagnostics };
	}

	const childResults = await Promise.all(
		listed.value.map(async (entry) => {
			if (entry.name.startsWith(".") || entry.name === "node_modules") return { skills: [], diagnostics: [] };
			const relPath = toPosixPath(relative(root, entry.path));
			const ignorePath = entry.kind === "directory" ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) return { skills: [], diagnostics: [] };

			if (entry.kind === "directory") {
				return await loadSkillsFromDirInternal(env, entry.path, source, false, ig, root);
			}

			if (entry.kind !== "file" || !includeRootFiles || !entry.name.endsWith(".md")) {
				return { skills: [], diagnostics: [] };
			}
			const result = await loadSkillFromFile(env, entry.path, source);
			return {
				skills: result.skill ? [result.skill] : [],
				diagnostics: result.diagnostics,
			};
		}),
	);
	for (const result of childResults) {
		skills.push(...result.skills);
		diagnostics.push(...result.diagnostics);
	}

	return { skills, diagnostics };
}

async function loadSkillFromFile(
	env: ExecutionEnv,
	filePath: string,
	source: string,
): Promise<{ skill: Skill | null; diagnostics: ResourceDiagnostic[] }> {
	const diagnostics: ResourceDiagnostic[] = [];
	const rawContent = await env.readTextFile(filePath);
	if (!rawContent.ok) {
		diagnostics.push({ type: "warning", message: rawContent.error.message, path: filePath });
		return { skill: null, diagnostics };
	}

	try {
		const { frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent.value);
		const skillDir = dirname(filePath);
		const name = frontmatter.name || basename(skillDir);

		for (const error of validateDescription(frontmatter.description)) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}
		for (const error of validateName(name)) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		if (!frontmatter.description || frontmatter.description.trim() === "") {
			return { skill: null, diagnostics };
		}

		return {
			skill: {
				name,
				description: frontmatter.description,
				filePath,
				baseDir: skillDir,
				sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
				disableModelInvocation: frontmatter["disable-model-invocation"] === true,
			},
			diagnostics,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to parse skill file";
		diagnostics.push({ type: "warning", message, path: filePath });
		return { skill: null, diagnostics };
	}
}

/**
 * Format skills for inclusion in a system prompt.
 * Uses XML format per Agent Skills standard.
 * See: https://agentskills.io/integrate-skills
 *
 * Skills with disableModelInvocation=true are excluded from the prompt
 * (they can only be invoked explicitly via /skill:name commands).
 */
function isUnderEnvPath(target: string, root: string): boolean {
	if (target === root) return true;
	const prefix = root.endsWith("/") ? root : `${root}/`;
	return target.startsWith(prefix);
}

async function loadSkillsFromPath(env: ExecutionEnv, path: string, source: string): Promise<LoadSkillsResult> {
	const info = await env.fileInfo(path);
	if (!info.ok) {
		return { skills: [], diagnostics: [{ type: "warning", message: "skill path does not exist", path }] };
	}
	if (info.value.kind === "directory") {
		return await loadSkillsFromDirInternal(env, path, source, true);
	}
	if (info.value.kind === "file" && path.endsWith(".md")) {
		const result = await loadSkillFromFile(env, path, source);
		return result.skill
			? { skills: [result.skill], diagnostics: result.diagnostics }
			: { skills: [], diagnostics: result.diagnostics };
	}
	return { skills: [], diagnostics: [{ type: "warning", message: "skill path is not a markdown file", path }] };
}

export function formatSkillsForPrompt(skills: Skill[]): string {
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);

	if (visibleSkills.length === 0) {
		return "";
	}

	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];

	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");

	return lines.join("\n");
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export interface LoadSkillsOptions {
	/** Working directory for project-local skills. */
	cwd: string;
	/** Agent config directory for global skills. */
	agentDir: string;
	/** Explicit skill paths (files or directories) */
	skillPaths: string[];
	/** Include default skills directories. */
	includeDefaults: boolean;
	/** Environment for resolving skill paths and executing commands. */
	executionEnv: ExecutionEnv;
}

export async function loadSkills(options: LoadSkillsOptions): Promise<LoadSkillsResult> {
	const env = options.executionEnv;
	const [resolvedCwd, resolvedAgentDir] = await Promise.all([
		resolveEnvPath(env, options.cwd),
		resolveEnvPath(env, options.agentDir ?? getAgentDir()),
	]);
	const [userSkillsDir, projectSkillsDir] = await Promise.all([
		envJoin(env, [resolvedAgentDir, "skills"]),
		envJoin(env, [resolvedCwd, CONFIG_DIR_NAME, "skills"]),
	]);
	const skillMap = new Map<string, Skill>();
	const pathSet = new Set<string>();
	const allDiagnostics: ResourceDiagnostic[] = [];
	const collisionDiagnostics: ResourceDiagnostic[] = [];

	function addSkills(result: LoadSkillsResult) {
		allDiagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			if (pathSet.has(skill.filePath)) continue;
			const existing = skillMap.get(skill.name);
			if (existing) {
				collisionDiagnostics.push({
					type: "collision",
					message: `name "${skill.name}" collision`,
					path: skill.filePath,
					collision: {
						resourceType: "skill",
						name: skill.name,
						winnerPath: existing.filePath,
						loserPath: skill.filePath,
					},
				});
			} else {
				skillMap.set(skill.name, skill);
				pathSet.add(skill.filePath);
			}
		}
	}

	if (options.includeDefaults) {
		const [userSkills, projectSkills] = await Promise.all([
			loadSkillsFromDirInternal(env, userSkillsDir, "user", true),
			loadSkillsFromDirInternal(env, projectSkillsDir, "project", true),
		]);
		addSkills(userSkills);
		addSkills(projectSkills);
	}

	const getSource = (resolvedPath: string): "user" | "project" | "path" => {
		if (!options.includeDefaults) {
			if (isUnderEnvPath(resolvedPath, userSkillsDir)) return "user";
			if (isUnderEnvPath(resolvedPath, projectSkillsDir)) return "project";
		}
		return "path";
	};

	const pathResults = await Promise.all(
		options.skillPaths.map(async (rawPath) => {
			const resolvedPath = await resolveEnvPath(env, rawPath);
			return await loadSkillsFromPath(env, resolvedPath, getSource(resolvedPath));
		}),
	);
	for (const result of pathResults) {
		addSkills(result);
	}

	return {
		skills: Array.from(skillMap.values()),
		diagnostics: [...allDiagnostics, ...collisionDiagnostics],
	};
}
