/**
 * dream-memory/utils/detect.ts
 * Content analysis utilities for auto-detection of source type and entity extraction.
 *
 * F13: Source type tagging — auto-detect what kind of content is being stored.
 * F19: Entity extraction — extract technology names, file paths, etc. as tags.
 */

// ── F13: Source type detection ──

/**
 * Detected source type and optional format.
 */
export interface DetectedSourceType {
	sourceType: "user" | "file" | "web" | "tool-result" | "conversation" | "query-synthesis";
	sourceFormat?: string;
}

const URL_PATTERN = /^https?:\/\//i;

const CODE_PATTERNS = [
	/^(import|export|from|const|let|var|function|class|interface|type|enum|module)\s/m,
	/^\s*(def |class |import |from |return |if |for |while )/m,
	/\b(fn |pub |impl |struct |trait |enum |use |mod )\b/,
	/^\s*<[A-Z]\w+[\s>]/m, // JSX/TSX component
	/\b(async|await|Promise|Observable)\b/,
	/\b(require|module\.exports|console\.\w+)\b/,
	/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s/i, // SQL
	/\b(npm|yarn|pnpm|cargo|pip|apt|dnf)\s+(install|add|run|build)/i,
];

const CONVERSATION_PATTERNS = [
	/^(user|assistant|human|ai|system)\s*:/im,
	/^(You|User|Assistant|Human|AI)\s*:/im,
	/^(>>>|---+)\s*(user|assistant|human)/im,
];

/**
 * Auto-detect the source type and format from content.
 *
 * Detection priority:
 * 1. URL → web
 * 2. Code patterns → file (with language hint)
 * 3. Conversation markers → conversation
 * 4. Default → user
 *
 * This is heuristic-only — no LLM call. False positives are acceptable
 * (a memory that looks like code but is really a user preference about
 * code style is still correctly tagged as "file" sourceType).
 */
export function detectSourceType(content: string): DetectedSourceType {
	const trimmed = content.trim();

	// URL
	if (URL_PATTERN.test(trimmed)) {
		return { sourceType: "web" };
	}

	// Code detection
	let codeScore = 0;
	for (const pattern of CODE_PATTERNS) {
		if (pattern.test(trimmed)) codeScore++;
	}
	if (codeScore >= 2) {
		const format = detectCodeFormat(trimmed);
		return { sourceType: "file", sourceFormat: format };
	}

	// Conversation detection
	for (const pattern of CONVERSATION_PATTERNS) {
		if (pattern.test(trimmed)) {
			return { sourceType: "conversation" };
		}
	}

	// Default
	return { sourceType: "user" };
}

/**
 * Detect programming language from content.
 * Heuristic: match keywords to language families.
 */
function detectCodeFormat(content: string): string | undefined {
	const lower = content.toLowerCase();

	if (/\b(fn |pub |impl |struct |trait |enum |use |mod |crate::)\b/.test(content)) return "rust";
	if (/\b(async|await|Promise|readonly|interface |type |enum )\b/.test(content) && /\.(ts|tsx|js|jsx)\b/.test(content)) return "typescript";
	if (/\b(async|await|Promise|const |let |var |=>)\b/.test(content) && !/\b(fn |pub )\b/.test(content)) return "javascript";
	if (/\b(def |class |import |from |return |if |for |while |lambda)\b/.test(content) && !/\b(fn |pub )\b/.test(content)) return "python";
	if (/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s/i.test(content)) return "sql";
	if (/\b(package |func |import \"|fmt\.|goroutine|chan )\b/.test(content)) return "go";
	if (/\b(public |private |protected |extends |implements |new )\b/.test(content) && /\b(System\.|String\.|int |void )\b/.test(content)) return "java";
	if (/\b(SELECT|INSERT|UPDATE|DELETE)\s/i.test(content) && /\b(VARCHAR|INTEGER|TEXT|BOOLEAN)\b/i.test(content)) return "sql";

	return undefined;
}

// ── F19: Entity extraction ──

/**
 * Known technology names (case-insensitive matching).
 * When a memory mentions one of these, it's added as a tag.
 */
const TECHNOLOGY_NAMES = [
	// Languages
	"typescript", "javascript", "python", "rust", "go", "golang", "java", "kotlin",
	"swift", "c\\+\\+", "c#", "ruby", "php", "scala", "haskell", "elixir", "zig",
	"sql", "html", "css", "scss", "tailwind",
	// Frameworks
	"react", "vue", "svelte", "angular", "next\\.?js", "nuxt", "remix", "astro",
	"express", "fastify", "hono", "nest", "django", "flask", "fastapi", "rails",
	"spring", "actix", "axum", "tokio",
	// Databases
	"postgres(?:ql)?", "mysql", "sqlite", "mongodb", "redis", "elasticsearch",
	"dynamodb", "supabase", "planetscale", "turso", "libsql",
	// Infra
	"docker", "kubernetes", "k8s", "nginx", "caddy", "traefik",
	"aws", "gcp", "azure", "cloudflare", "vercel", "netlify", "railway", "fly\\.io",
	"terraform", "pulumi", "ansible",
	// Tools
	"git", "github", "gitlab", "bitbucket",
	"vim", "neovim", "nvim", "zed", "vscode", "vs code", "emacs", "helix",
	"ghostty", "kitty", "alacritty", "wezterm", "iterm",
	"tmux", "zsh", "bash", "fish", "nushell",
	"node\\.?js", "bun", "deno", "webpack", "vite", "esbuild", "rollup", "turbopack",
	"eslint", "prettier", "biome", "oxlint",
	"pnpm", "npm", "yarn", "bun",
	"obsidian", "notion", "linear", "jira",
];

// Build a single regex from technology names (case-insensitive, word boundary)
const TECH_REGEX = new RegExp(
	`\\b(${TECHNOLOGY_NAMES.join("|")})\\b`,
	"gi",
);

/**
 * File path pattern: /path/to/file.ext or ~/path or ./relative
 */
const PATH_PATTERN = /\b(?:~\/|\.\/|\/[\w.-]+)+\/[\w.-]+\.\w{1,5}\b/g;

/**
 * Extract entities (technologies, file paths) from content.
 * Returns deduplicated lowercase tags.
 *
 * Examples:
 *   "Use vim with postgres" → ["vim", "postgres"]
 *   "Edit src/main.ts" → ["typescript"]
 *   "Configure nginx reverse proxy" → ["nginx"]
 */
export function extractEntities(content: string): string[] {
	const tags = new Set<string>();

	// Technology names
	let match: RegExpExecArray | null;
	TECH_REGEX.lastIndex = 0;
	while ((match = TECH_REGEX.exec(content)) !== null) {
		const name = match[1].toLowerCase()
			.replace(/\\/, "") // remove regex escapes from names like c\+\+
			.replace(/\.\?/g, ""); // remove optional dots from next.?js
		tags.add(name);
	}

	// File paths → infer language from extension
	while ((match = PATH_PATTERN.exec(content)) !== null) {
		const ext = match[0].split(".").pop()?.toLowerCase();
		if (ext) {
			const lang = EXTENSION_TO_LANG[ext];
			if (lang) tags.add(lang);
		}
	}

	return Array.from(tags);
}

/**
 * File extension → language tag mapping.
 */
const EXTENSION_TO_LANG: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	jsx: "javascript",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	rs: "rust",
	go: "go",
	java: "java",
	kt: "kotlin",
	swift: "swift",
	rb: "ruby",
	php: "php",
	html: "html",
	css: "css",
	scss: "css",
	vue: "vue",
	svelte: "svelte",
	sql: "sql",
	md: "markdown",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	sh: "bash",
	zsh: "zsh",
	dockerfile: "docker",
};
