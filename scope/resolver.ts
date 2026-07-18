/**
 * dream-memory/scope/resolver.ts
 * Scope resolution for memory storage
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export type Scope = "global" | "project" | "agent" | "session";

export interface ScopeContext {
	scope: Scope;
	scopeId?: string;
	project?: string;
	agent?: string;
	sessionId: string;
}

/**
 * Reserved scope IDs that MUST NOT be used as project/agent IDs.
 * These would collide with reserved stores or filter conventions.
 */
const RESERVED_SCOPE_IDS = new Set([
	"global",          // global.db reserved store
	"dream",           // dream session DBs use `global-dream-*` etc.
	"all",
	"any",
	"none",
	"null",
	"undefined",
]);

/**
 * Check if a project/agent ID collides with a reserved name.
 * Exported for testability and use by BankManager as well.
 */
export function isReservedScopeId(id: string | undefined): boolean {
	if (!id) return false;
	// Exact match
	if (RESERVED_SCOPE_IDS.has(id.toLowerCase())) return true;
	// Pattern: anything matching `*-dream-*` is reserved for dream sessions
	if (/^[a-z0-9_-]*-dream-[a-z0-9_-]+$/i.test(id)) return true;
	// Pattern: starts with `archived-` (used by BankManager for archive names)
	if (id.startsWith("archived-")) return true;
	return false;
}

/**
 * Sanitize a project ID by adding a `proj-` prefix when it collides
 * with a reserved name. Returns the original ID if safe.
 */
export function sanitizeProjectId(id: string | undefined): string | undefined {
	if (!id) return id;
	if (isReservedScopeId(id)) {
		return `proj-${id}`;
	}
	return id;
}

/**
 * Files that signal "this directory is a real project". Used by
 * `isRealProject` to decide whether `cwd` deserves a project-scoped
 * memory store. Without this strict check, every random directory the
 * user `cd`s into (e.g., `/tmp`, `/home/arthur`, `/var/log`) would
 * create a phantom .db file via the basename fallback. Those phantom
 * DBs accumulated over time and the auto-cleanup only removed them
 * after 7 days of age — long after they'd been used briefly and
 * forgotten.
 *
 * The list covers the major package ecosystems:
 *   - .git/                 (any git project, regardless of language)
 *   - package.json          (Node/JS/TS)
 *   - pyproject.toml        (Python, PEP 621)
 *   - Cargo.toml            (Rust)
 *   - go.mod                (Go)
 *   - pom.xml               (Java/Maven)
 *   - build.gradle / .gradle (Java/Kotlin/Groovy/Gradle)
 *   - Gemfile               (Ruby/Bundler)
 *   - composer.json         (PHP/Composer)
 *   - mix.exs               (Elixir/Mix)
 *   - Package.swift         (Swift Package Manager)
 *
 * The criterion is intentionally narrow: presence of any one of these
 * files (or a `.git/` directory) signals a real project. We don't use
 * basename heuristics (which fail for non-project directories) or any
 * other soft signal. If the user wants a project store in a custom
 * dir, they should either git init it or add one of these manifests.
 *
 * This function is exported and used by:
 *   - `detectProject` (this file) — to skip the basename fallback
 *   - `capture/signals.ts:detectScope` — same criterion for auto-capture
 */
export const PROJECT_MARKER_FILES: ReadonlyArray<string> = [
	".git",
	"package.json",
	"pyproject.toml",
	"Cargo.toml",
	"go.mod",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"Gemfile",
	"composer.json",
	"mix.exs",
	"Package.swift",
];

/**
 * Check if a directory is a real project.
 *
 * @param cwd  The directory to check
 * @returns true if cwd has any project marker, false otherwise
 */
export function isRealProject(cwd: string): boolean {
	if (!cwd) return false;
	try {
		for (const marker of PROJECT_MARKER_FILES) {
			if (existsSync(join(cwd, marker))) return true;
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Manifest extractors: given the raw file contents, return the project's
 * canonical name (or undefined if not extractable). Order in
 * `MANIFEST_EXTRACTORS` matters — first match wins. We keep the previous
 * `package.json` behaviour at the top so existing users see no change.
 *
 * Why regex over a real parser: `Cargo.toml` and `pyproject.toml` are
 * TOML with nested sections and quoted multi-line strings. A full TOML
 * parser would add a dependency for a single field. The regex below
 * targets the first `name = "..."` line in the `[package]`/`[project]`
 * sections, which is the conventional placement and matches ~99% of
 * real-world manifests. False negatives fall through to the basename
 * fallback at the end of `detectProject`, which is still stable.
 */
const MANIFEST_EXTRACTORS: ReadonlyArray<{
	file: string;
	extract: (content: string) => string | undefined;
}> = [
	{
		file: "package.json",
		extract: (content) => {
			try {
				const pkg = JSON.parse(content);
				return typeof pkg.name === "string" ? pkg.name : undefined;
			} catch {
				return undefined;
			}
		},
	},
	{
		file: "composer.json",
		extract: (content) => {
			try {
				const pkg = JSON.parse(content);
				return typeof pkg.name === "string" ? pkg.name : undefined;
			} catch {
				return undefined;
			}
		},
	},
	{
		file: "Cargo.toml",
		extract: (content) => {
			// [package] section: name = "..."
			const m = content.match(/\[package\][\s\S]*?^\s*name\s*=\s*"([^"]+)"/m);
			return m ? m[1] : undefined;
		},
	},
	{
		file: "pyproject.toml",
		extract: (content) => {
			// [project] section (PEP 621): name = "..."
			const m = content.match(/\[project\][\s\S]*?^\s*name\s*=\s*"([^"]+)"/m);
			return m ? m[1] : undefined;
		},
	},
	{
		file: "go.mod",
		extract: (content) => {
			// First non-comment line: module github.com/user/repo
			const m = content.match(/^\s*module\s+(\S+)/m);
			if (!m) return undefined;
			// Take the last path segment as the project name. "github.com/foo/bar"
			// → "bar". This matches how Go modules are commonly referred to.
			const segments = m[1].split("/");
			return segments[segments.length - 1];
		},
	},
];

/**
 * Detect project name from git remote, package manifest, or basename.
 *
 * Strict mode: only returns a project ID if cwd qualifies as a real project
 * (has any of the markers in `PROJECT_MARKER_FILES`). Random directories
 * (no project markers) return undefined, which causes `resolveScope` to
 * fall back to "global" scope.
 *
 * The previous implementation fell back to `basename(cwd)` when no markers
 * were found, creating phantom project DBs for every directory the user
 * `cd`'d into. The strict version prevents that leak.
 *
 * Multi-ecosystem support (Phase 1 audit): originally only `package.json`
 * was checked. Python, Rust, Go, PHP, etc. projects were silently treated
 * as non-projects because their manifest names weren't in the check list.
 * Now any marker in `PROJECT_MARKER_FILES` qualifies, and the manifest
 * extractors above pull the canonical name when available.
 */
export function detectProject(cwd: string): string | undefined {
	// Strict check first: if cwd has no project markers, return undefined
	// immediately. This is the fix for phantom project DBs.
	if (!isRealProject(cwd)) return undefined;

	// Try git remote (works for any language — the project name from the
	// remote is usually more stable than the manifest name, since it
	// doesn't change when the manifest gets renamed).
	try {
		const remote = execSync("git remote get-url origin 2>/dev/null", { cwd, encoding: "utf-8" }).trim();
		if (remote) {
			// Extract repo name from URL
			const match = remote.match(/\/([^/]+?)(?:\.git)?$/);
			if (match) return sanitizeProjectId(match[1]);
		}
	} catch {
		// Not a git repo (but isRealProject said it has .git — race? skip silently)
	}

	// Try each known manifest extractor. First one that finds a name wins.
	for (const { file, extract } of MANIFEST_EXTRACTORS) {
		const path = join(cwd, file);
		if (!existsSync(path)) continue;
		try {
			const content = readFileSync(path, "utf-8");
			const name = extract(content);
			if (name) return sanitizeProjectId(name);
		} catch {
			// Unreadable / permission error — try the next manifest.
		}
	}

	// We know `isRealProject` returned true, so there's a marker. None of
	// the extractors matched (e.g., pom.xml, build.gradle, Gemfile,
	// mix.exs, Package.swift — marker-only entries with no name
	// extraction). Fall back to the directory basename, which is stable
	// for real projects: it's the same path the user navigates to.
	return sanitizeProjectId(basename(cwd) || "unnamed");
}

/**
 * Detect agent name from system prompt or config
 */
export function detectAgent(systemPrompt?: string): string | undefined {
	if (!systemPrompt) return undefined;

	// Look for agent name patterns
	const patterns = [/You are\s+(?:a\s+)?(.+?)(?:\.|,|\n)/i, /Agent:\s*(.+?)(?:\.|,|\n)/i, /Persona:\s*(.+?)(?:\.|,|\n)/i];

	for (const pattern of patterns) {
		const match = systemPrompt.match(pattern);
		if (match) return match[1].trim().slice(0, 50);
	}

	return undefined;
}

/**
 * Resolve full scope context
 */
export function resolveScope(params: {
	cwd: string;
	sessionId: string;
	systemPrompt?: string;
	scopeOverride?: Scope;
	scopeIdOverride?: string;
}): ScopeContext {
	const project = detectProject(params.cwd);
	const agent = detectAgent(params.systemPrompt);

	// If override provided, use it
	if (params.scopeOverride) {
		// Auto-detect scopeId if not provided
		let scopeId = params.scopeIdOverride;
		if (!scopeId) {
			if (params.scopeOverride === "project") scopeId = project;
			else if (params.scopeOverride === "agent") scopeId = agent;
			else if (params.scopeOverride === "session") scopeId = params.sessionId;
		}
		// Downgrade: if the user explicitly asked for "project" scope but no
		// real project was detected (cwd has no .git or package.json), fall
		// back to "global". Without this, scope=project + scope_id=null would
		// silently create a memory tagged as project in global.db — breaking
		// the "scope=X lives in store X" invariant. The user can always
		// re-tag the memory later via /dream-list + manual update.
		if (params.scopeOverride === "project" && !scopeId) {
			return {
				scope: "global",
				project,
				agent,
				sessionId: params.sessionId,
			};
		}
		return {
			scope: params.scopeOverride,
			scopeId,
			project,
			agent,
			sessionId: params.sessionId,
		};
	}

	// Auto-detect scope
	if (agent) {
		return {
			scope: "agent",
			scopeId: agent,
			project,
			agent,
			sessionId: params.sessionId,
		};
	}

	if (project) {
		return {
			scope: "project",
			scopeId: project,
			project,
			agent,
			sessionId: params.sessionId,
		};
	}

	return {
		scope: "global",
		project,
		agent,
		sessionId: params.sessionId,
	};
}
