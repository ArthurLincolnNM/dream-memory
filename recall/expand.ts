/**
 * dream-memory/recall/expand.ts
 *
 * Query expansion via a small static synonym dictionary.
 *
 * Motivation: BM25 over FTS5 is purely lexical. A query "como abro o
 * command palette" doesn't match a memory "Keybinding: Ctrl+P abre
 * command palette no Zed" because the keyword overlap is partial. The
 * other half of the recall pipeline (semantic embeddings) catches
 * paraphrase when the @huggingface/transformers package is installed —
 * but that's a heavy dep, and a fast first-pass signal that works
 * everywhere is still useful.
 *
 * Design:
 *   - Static dictionary, ~100 entries, pt-BR + en. Hand-curated for
 *     concepts that actually appear in dream-memory content: tools,
 *     code/dev actions, common qualifiers, failure synonyms. NOT a
 *     full WordNet — the goal is "fix the top 20 most-missed queries",
 *     not "expand everything".
 *   - Per-token expansion: each input token is looked up; matches
 *     return the token PLUS its synonyms. Deduped (no double entries
 *     when two tokens share a synonym). Case-insensitive matching
 *     because FTS5 tokenization is case-insensitive.
 *   - Bounded: a single token expands to at most MAX_SYNONYMS_PER_TOKEN
 *     entries, and the total expanded list is capped at MAX_EXPANDED_TOKENS
 *     to keep the FTS5 query from exploding on long inputs.
 *   - Deterministic: same input → same output. No LLM, no randomness,
 *     no API. The function is pure.
 *
 * Inspired by Argus's HyDE query expansion, but instead of rewriting
 * the prompt with an LLM, we use a static lookup. Much faster (μs not
 * ms) and works offline. The semantic embedder handles the cases
 * static expansion misses.
 */

/** Max synonyms added per token. Prevents one rich entry from
 *  dominating the FTS5 query. */
const MAX_SYNONYMS_PER_TOKEN = 5;

/** Hard cap on total expanded tokens. BM25 OR-join with hundreds of
 *  terms is slow and noisy; we cap at a number that still gives
 *  meaningful coverage without exploding the query. */
const MAX_EXPANDED_TOKENS = 30;

/**
 * Static synonym dictionary. Keys are normalized (lowercased, no
 * diacritics — see normalizeToken) so lookups are cheap and consistent.
 * Values are lists of synonym strings, each pre-normalized too.
 *
 * Hand-curated. Adding entries: think "would the user actually search
 * for the synonym of this token in a memory?" If yes, add. If not, skip.
 * The dictionary is intentionally narrow — false positives are
 * worse than misses because they pollute every recall.
 */
const SYNONYMS: Readonly<Record<string, ReadonlyArray<string>>> = {
	// ── Actions / verbs ────────────────────────────────────────────────
	open: ["abrir", "abre", "mostrar", "show"],
	abrir: ["open", "abre"],
	abre: ["abrir", "open"],
	show: ["mostrar", "exibir", "open"],
	usar: ["use", "using", "used", "utilizar", "uso"],
	uso: ["use", "using", "used", "usar"],
	use: ["usar", "using", "used", "uso", "using"],
	prefer: ["gosto", "prefiro", "adoro", "like", "want"],
	prefiro: ["prefer", "gosto", "like"],
	gosto: ["prefer", "like", "adoro"],
	like: ["prefer", "gosto"],
	buscar: ["find", "search", "procurar", "look"],
	procurar: ["find", "search", "buscar", "look"],
	lembrar: ["remember", "recall", "lembra"],
	lembra: ["remember", "recall", "lembrar"],
	esquecer: ["forget"],
	configure: ["configurar", "setup", "config"],
	configurar: ["configure", "config", "setup"],
	instalar: ["install", "setup"],
	install: ["instalar", "setup"],

	// ── Failures / errors ─────────────────────────────────────────────
	bug: ["erro", "error", "fail", "failure", "broken", "crash", "falha"],
	erro: ["bug", "error", "fail", "failure", "broken", "falha"],
	error: ["bug", "erro", "fail", "failure", "broken", "falha"],
	fail: ["bug", "erro", "error", "failure", "broken", "falha"],
	failure: ["bug", "erro", "error", "fail", "broken", "falha"],
	falha: ["bug", "erro", "error", "fail", "failure"],
	broken: ["bug", "erro", "quebrado", "fail"],
	quebrado: ["broken", "bug", "erro"],
	crash: ["bug", "erro", "trave", "travou"],
	fix: ["consertar", "corrigir", "resolve", "repair", "consertou"],
	consertar: ["fix", "corrigir", "repair"],
	corrigir: ["fix", "consertar", "repair"],

	// ── Tools / editors / software ────────────────────────────────────
	editor: ["ide", "vscode", "zed", "vim", "neovim", "nvim", "sublime", "emacs"],
	ide: ["editor", "vscode", "zed", "vim", "neovim"],
	vscode: ["editor", "ide", "code", "vs-code"],
	zed: ["editor", "ide"],
	vim: ["editor", "ide", "neovim", "nvim"],
	neovim: ["vim", "nvim", "editor", "ide"],
	nvim: ["neovim", "vim", "editor"],
	emacs: ["editor", "ide"],
	sublime: ["editor", "ide"],
	terminal: ["console", "shell", "bash", "zsh", "fish", "powershell", "iterm"],
	console: ["terminal", "shell"],
	shell: ["terminal", "bash", "zsh", "fish"],
	bash: ["shell", "terminal", "zsh"],
	zsh: ["shell", "terminal", "bash"],
	fish: ["shell", "terminal"],
	browser: ["navegador", "chrome", "firefox", "edge", "safari", "brave", "chromium"],
	navegador: ["browser", "chrome", "firefox"],
	chrome: ["browser", "navegador", "chromium"],
	firefox: ["browser", "navegador"],

	// ── Concepts ──────────────────────────────────────────────────────
	keybinding: ["shortcut", "atalho", "hotkey", "binding"],
	shortcut: ["keybinding", "atalho", "hotkey"],
	atalho: ["keybinding", "shortcut", "hotkey"],
	hotkey: ["keybinding", "shortcut", "atalho"],
	theme: ["tema", "color", "cor", "dark", "light"],
	tema: ["theme", "color", "cor"],
	color: ["cor", "theme", "tema"],
	cor: ["color", "theme", "tema"],
	font: ["fonte", "typography", "tipografia"],
	fonte: ["font", "typography"],
	language: ["linguagem", "lingua", "lang", "idioma"],
	linguagem: ["language", "lang"],
	lang: ["language", "linguagem"],
	framework: ["lib", "library", "biblioteca"],
	package: ["pacote", "module", "lib"],
	pacote: ["package", "module"],
	config: ["configuration", "configuracao", "settings", "setting", "setup"],
	configuracao: ["config", "configuration", "settings", "setup"],
	settings: ["config", "configuration", "configuracao", "preferences"],
	setting: ["config", "settings", "preferences"],
	preferences: ["config", "settings", "configuracao", "preferencias"],
	preferencias: ["preferences", "settings", "config"],
	project: ["projeto", "repo", "repository"],
	projeto: ["project", "repo"],
	repo: ["project", "projeto", "repository"],
	test: ["teste", "spec", "testing"],
	teste: ["test", "spec"],
	build: ["compilar", "compile", "construir"],
	deploy: ["publicar", "publish", "release"],
	database: ["db", "banco", "postgres", "sqlite", "mysql"],
	db: ["database", "banco"],
	banco: ["database", "db"],
	debug: ["depurar", "debugar", "investigate", "investigar"],
	debugar: ["debug", "depurar"],
	refactor: ["refatorar", "rewrite", "reescrever"],
	refatorar: ["refactor", "rewrite"],
	log: ["logs", "logging", "registro"],
	logs: ["log", "registro"],
	cache: ["cached", "memoize", "memoizar"],
	cached: ["cache", "memoize"],
	backup: ["snapshot", "restore"],
	restore: ["backup", "recuperar", "restaurar"],
	restaurar: ["restore", "recuperar"],

	// ── Common qualifiers ─────────────────────────────────────────────
	fast: ["rapido", "veloz", "quick"],
	rapido: ["fast", "quick", "veloz"],
	slow: ["lento", "devagar"],
	lento: ["slow", "devagar"],
	best: ["melhor", "ideal", "preferred"],
	melhor: ["best", "ideal", "preferred"],
	worst: ["pior", "evitar", "avoid"],
	evitar: ["avoid", "worst"],
	avoid: ["evitar", "worst"],
};

/**
 * Normalize a token for dictionary lookup. Lowercase + NFD-strip
 * diacritics so "não" / "nao" / "Não" all hit the same entry.
 *
 * Note: the SYNONYMS keys are also stored in this normalized form.
 * If you add a new key, run it through this function first.
 */
export function normalizeToken(token: string): string {
	return token.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Expand a list of tokens using the synonym dictionary.
 *
 * Behavior:
 *   - Each token is looked up (case-insensitive, diacritic-stripped)
 *   - If found, the original token PLUS its synonyms are added
 *   - If not found, just the original token is added
 *   - Deduplication: a token appears at most once in the output, even
 *     if multiple input tokens share it as a synonym
 *   - Synonym count is bounded per-token to keep the expansion focused
 *   - Total output is bounded by MAX_EXPANDED_TOKENS
 *
 * Returns a NEW array; the input is not mutated.
 *
 * @param tokens  Input tokens (raw, NOT pre-normalized — we normalize here)
 * @returns Expanded tokens in encounter order, deduplicated
 */
export function expandQueryTokens(tokens: ReadonlyArray<string>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const raw of tokens) {
		if (!raw) continue;
		const original = raw.toLowerCase();
		const normalized = normalizeToken(raw);

		// Always include the original token (in its original case to
		// preserve user intent: "Zed" should stay "Zed", not become "zed").
		// Dedupe is by lowercased form.
		const key = original;
		if (!seen.has(key)) {
			seen.add(key);
			result.push(raw);
			if (result.length >= MAX_EXPANDED_TOKENS) return result;
		}

		// Look up synonyms by normalized form
		const syns = SYNONYMS[normalized];
		if (!syns) continue;

		// Take up to MAX_SYNONYMS_PER_TOKEN synonyms
		const limit = Math.min(syns.length, MAX_SYNONYMS_PER_TOKEN);
		for (let i = 0; i < limit; i++) {
			const syn = syns[i];
			const synKey = syn.toLowerCase();
			if (seen.has(synKey)) continue;
			seen.add(synKey);
			result.push(syn);
			if (result.length >= MAX_EXPANDED_TOKENS) return result;
		}
	}

	return result;
}

/**
 * For tests / debugging: total number of dictionary entries.
 * Useful for the eval suite to warn if the dictionary shrinks/grows
 * significantly (a silently-broken expansion is hard to detect
 * otherwise).
 */
export function dictionarySize(): number {
	return Object.keys(SYNONYMS).length;
}
