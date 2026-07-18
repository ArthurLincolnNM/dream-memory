/**
 * dream-memory/sanitize/coreference.ts
 *
 * Resolve pronouns to explicit entity names in memory content.
 * Inspired by SimpleMem's context normalization: "resolve all pronouns
 * and implicit references into explicit entity names" so each memory
 * unit is self-contained and interpretable without prior dialogue.
 *
 * Strategy: CONSERVATIVE heuristic. Only resolves when:
 *   1. There's exactly one clear candidate entity in the text
 *   2. The pronoun is in subject position (not object of preposition)
 *   3. The entity appears BEFORE the pronoun (anaphoric reference)
 *
 * False negatives (not resolving) are preferred over false positives
 * (wrong resolution). A wrong resolution is worse than leaving a pronoun
 * because it silently corrupts the memory.
 *
 * Runs in the dream_memory_add pipeline, AFTER sanitizeCredentials but
 * BEFORE normalizeTemporalReferences. Silent: if no resolution possible,
 * returns input unchanged.
 */

export interface CoreferenceResult {
	/** Text with pronouns resolved to explicit entity names */
	resolved: string;
	/** Whether any pronoun was resolved */
	changed: boolean;
	/** Audit trail of resolutions made */
	resolutions: Array<{ pronoun: string; resolvedTo: string }>;
}

// ── Pronoun detection ────────────────────────────────────────────────

interface PronounPattern {
	/** Regex matching the pronoun (word boundaries, case-insensitive) */
	regex: RegExp;
	/** Normalized form for display */
	normalized: string;
	/** Gender hint: "m" = masculine, "f" = feminine, "n" = neutral */
	gender: "m" | "f" | "n";
	/** Language */
	lang: "pt" | "en";
}

const PRONOUN_PATTERNS: PronounPattern[] = [
	// ── Portuguese ──────────────────────────────────────────────────────
	{ regex: /(?<![a-zA-ZÀ-ÿ])ele(?![a-zA-ZÀ-ÿ])/gi, normalized: "ele", gender: "m", lang: "pt" },
	{ regex: /(?<![a-zA-ZÀ-ÿ])ela(?![a-zA-ZÀ-ÿ])/gi, normalized: "ela", gender: "f", lang: "pt" },
	{ regex: /(?<![a-zA-ZÀ-ÿ])isso(?![a-zA-ZÀ-ÿ])/gi, normalized: "isso", gender: "n", lang: "pt" },
	{ regex: /(?<![a-zA-ZÀ-ÿ])isto(?![a-zA-ZÀ-ÿ])/gi, normalized: "isto", gender: "n", lang: "pt" },
	// ── English ─────────────────────────────────────────────────────────
	{ regex: /(?<![a-zA-Z])he(?![a-zA-Z])/gi, normalized: "he", gender: "m", lang: "en" },
	{ regex: /(?<![a-zA-Z])she(?![a-zA-Z])/gi, normalized: "she", gender: "f", lang: "en" },
	{ regex: /(?<![a-zA-Z])it(?![a-zA-Z])/gi, normalized: "it", gender: "n", lang: "en" },
	{ regex: /(?<![a-zA-Z])this(?![a-zA-Z])/gi, normalized: "this", gender: "n", lang: "en" },
	{ regex: /(?<![a-zA-Z])that(?![a-zA-Z])/gi, normalized: "that", gender: "n", lang: "en" },
];

// ── "it" exclusion: don't resolve "it" in object/idiomatic positions ──

/**
 * Patterns where "it"/"isso"/"isto" is NOT a referential pronoun.
 * These are idiomatic or object-position uses that shouldn't be resolved.
 */
const NON_REFERENTIAL_PATTERNS: RegExp[] = [
	// English: "make it", "get it", "do it", "love it", etc.
	// No trailing \b — allows matching verb forms like "configured it" (d + space = no boundary)
	/(?:make|get|do|love|hate|want|need|keep|put|take|find|see|try|use|have|give|let|set|run|fix|build|write|read|call|ask|tell|move|stop|start|finish|open|close|push|pull|break|catch|throw|hold|drop|turn|cut|pick|mark|check|save|load|send|grab|drag|copy|paste|type|click|select|delete|install|remove|create|update|modify|change|configure|setup|deploy|debug|test|review|merge|commit|push|pull|clone|fork|star|watch|follow|unfollow|mute|block|ban|kick|invite|add|remove)(?:ed|ing|s)?\s+it\b/gi,
	// English: "it is", "it's", "it was", "it will", "it can", "it should"
	/\bit\s+(?:is|was|will|would|can|could|should|might|may|has|had|have|does|did|do|'s|'ll|'d|'ve|'re)\b/gi,
	// Portuguese: verb + isso (no \b before accented chars — use lookahead/behind with non-word)
	/(?:é|faz|cura|usa|pega|monta|configura|instala|remove|cria|atualiza|modifica|muda|salva|carrega|envia|busca|abre|roda|quebra|segura|solta|corta|marca|checa|recebe|copia|cola|digita|clica|seleciona|deleta)\s+isso\b/gi,
	// English: preposition + it
	/\b(?:with|for|in|on|to|from|by|at|about|into|onto|upon|through|during|before|after|between|among|within|without|against|along|across|behind|below|beneath|beside|beyond|inside|outside|under|over|around|near|past|since|toward|towards|until|via)\s+it\b/gi,
	// Portuguese: preposition + isso
	/(?:com|para|em|no|na|nos|nas|sobre|sob|entre|após|antes|durante|sem|contra|através|por|de|da|do|das|dos|a|à|ao|aos|às)\s+isso\b/gi,
	/\b(?:nisso|disso|assim|por isso|com isso|para isso)\b/gi,
	// English: "it seems", "it appears", "it turns out", "it passes", etc.
	/\bit\s+(?:seems?|appears?|passes?|turns?\s+out|looks?\s+like|happens?|follows?|means?|suggests?|indicates?|implies?|requires?|needs?|involves?|contains?|includes?|remains?|exists?|works?|functions?|operates?|behaves?)\b/gi,
];

// ── Entity extraction ────────────────────────────────────────────────

/**
 * Extract candidate entities from text.
 *
 * Strategy: find ALL words starting with uppercase, then filter out:
 *   - Common words (the, a, is, SQLite, etc.)
 *   - Words that are just the pronoun itself (e.g., "He" when matching "he")
 *
 * We do NOT filter sentence-initial words. In natural language, the first
 * word of a sentence is frequently a proper noun ("Alice went to...").
 * Filtering all sentence-initial caps would miss the most common entity
 * position.
 */
function extractEntities(text: string): string[] {
	const entities: string[] = [];

	// Find all uppercase-starting words
	const wordRegex = /\b([A-Z][a-zA-Z0-9_]{1,30})\b/g;
	let match;
	while ((match = wordRegex.exec(text)) !== null) {
		const word = match[1];

		// Skip common words (including tech terms and pronouns)
		if (COMMON_WORDS.has(word.toLowerCase())) continue;

		// Skip ALL-uppercase words (acronyms: CI, API, SQL, etc.)
		// These are typically not person entities.
		if (word === word.toUpperCase() && word.length >= 2) continue;

		entities.push(word);
	}

	return [...new Set(entities)]; // deduplicate
}

/**
 * Common English and Portuguese words that start with uppercase
 * but are NOT entities. Excluded from entity candidates.
 */
const COMMON_WORDS = new Set([
	// English
	"the", "a", "an", "this", "that", "these", "those", "my", "your", "his",
	"her", "its", "our", "their", "what", "which", "who", "whom", "where",
	"when", "why", "how", "all", "each", "every", "both", "few", "more",
	"most", "other", "some", "such", "no", "not", "only", "own", "same",
	"so", "than", "too", "very", "can", "will", "just", "should", "now",
	"also", "then", "here", "there", "always", "never", "sometimes",
	"often", "already", "still", "even", "well", "back", "new", "first",
	"last", "next", "long", "great", "little", "old", "big", "high",
	"small", "large", "young", "important", "few", "public", "bad", "good",
	"right", "sure", "free", "real", "sure", "true", "false", "yes",
	// Portuguese
	"o", "a", "os", "as", "um", "uma", "uns", "umas", "este", "esta",
	"estes", "estas", "esse", "essa", "esses", "essas", "aquele", "aquela",
	"aqueles", "aquelas", "meu", "minha", "meus", "minhas", "teu", "tua",
	"teus", "tuas", "seu", "sua", "seus", "suas", "nosso", "nossa",
	"nossos", "nossas", "que", "qual", "quais", "quem", "onde", "quando",
	"porque", "como", "quanto", "quanta", "quantos", "quantas", "todo",
	"toda", "todos", "todas", "cada", "muito", "muita", "muitos", "muitas",
	"pouco", "pouca", "poucos", "poucas", "mais", "menos", "outro", "outra",
	"outros", "outras", "mesmo", "mesma", "mesmos", "mesmas", "tão",
	"tanto", "tanta", "tantos", "tantas", "assim", "bem", "mal", "aqui",
	"ali", "lá", "cá", "então", "depois", "antes", "ainda", "sempre",
	"nunca", "às", "vezes", "fazer", "ter", "poder", "dever", "haver",
	// Tech terms that look like entities
	"api", "url", "http", "https", "json", "sql", "html", "css", "js",
	"ts", "py", "git", "ssh", "ssl", "tls", "dns", "ip", "tcp", "udp",
	"npm", "yarn", "pip", "apt", "dnf", "brew", "vim", "neovim", "nvim",
	"emacs", "vscode", "zed", "ghostty", "linux", "fedora", "ubuntu",
	"debian", "arch", "macos", "windows", "ios", "android",
	"sqlite", "postgresql", "mysql", "mongodb", "redis", "docker",
	"kubernetes", "terraform", "ansible", "jenkins", "github", "gitlab",
	"bitbucket", "jira", "confluence", "slack", "discord",
	// Pronouns that start with uppercase
	"he", "she", "it", "this", "that", "ele", "ela", "isso", "isto",
	"him", "her", "his", "them", "they", "we", "you",
	"nos", "vocês", "eles", "elas", "mim", "ti", "si",
]);

// ── Core resolution logic ────────────────────────────────────────────

/**
 * Resolve pronouns in `text` to explicit entity names.
 *
 * Algorithm:
 *   1. Extract candidate entities from the text
 *   2. For each pronoun found:
 *      a. Check if it's in a non-referential pattern → skip
 *      b. Check if there's exactly one entity candidate → resolve
 *      c. If multiple candidates or none → skip (too ambiguous)
 *   3. Replace pronoun with entity (preserving case)
 *
 * @param text Input text (memory content)
 * @returns CoreferenceResult with resolved text and audit trail
 */
export function resolveCoreferences(text: string): CoreferenceResult {
	const resolutions: CoreferenceResult["resolutions"] = [];
	let resolved = text;

	// Step 1: Extract entities
	const entities = extractEntities(text);

	// No entities = nothing to resolve against
	if (entities.length === 0) {
		return { resolved: text, changed: false, resolutions: [] };
	}

	// Step 2: Find and resolve pronouns
	for (const pattern of PRONOUN_PATTERNS) {
		const isNeutral = pattern.gender === "n";

		// Check non-referential patterns for neutral pronouns
		if (isNeutral) {
			const hasNonReferential = NON_REFERENTIAL_PATTERNS.some(p => {
				p.lastIndex = 0;
				return p.test(text);
			});
			if (hasNonReferential) {
				continue;
			}
		}

		// For gendered pronouns, filter entities by gender compatibility
		let candidateEntities = entities;
		if (pattern.gender === "m") {
			candidateEntities = entities.filter(e => !isFeminineEntity(e));
		} else if (pattern.gender === "f") {
			candidateEntities = entities.filter(e => !isMasculineEntity(e));
		}

		// Need exactly one candidate to resolve
		if (candidateEntities.length !== 1) {
			continue;
		}

		const entity = candidateEntities[0];

		// Replace each occurrence of this pronoun.
		// Use the original regex (with i flag) to find ALL occurrences.
		// Both lowercase and capitalized pronouns are resolved — in memory
		// content, capitalized pronouns ("He said...") are still coreferential.
		pattern.regex.lastIndex = 0;
		resolved = resolved.replace(pattern.regex, (match) => {
			resolutions.push({ pronoun: pattern.normalized, resolvedTo: entity });
			// Preserve case: if pronoun starts with uppercase, entity should too
			const replacement = match[0] === match[0].toUpperCase()
				? entity.charAt(0).toUpperCase() + entity.slice(1)
				: entity;
			return replacement;
		});
	}

	return {
		resolved,
		changed: resolutions.length > 0,
		resolutions,
	};
}

// ── Gender heuristics ────────────────────────────────────────────────

/**
 * Check if an entity name looks feminine (Portuguese/English heuristics).
 * Returns true only for CLEARLY feminine names (ending in -a, -ã).
 * Returns false for ambiguous endings (-e, -u, etc.) — better to not
 * filter than to incorrectly exclude a valid entity.
 */
function isFeminineEntity(entity: string): boolean {
	const lower = entity.toLowerCase();
	// Clear masculine exceptions: names ending in -a that are actually masculine
	const masculineExceptions = new Set([
		"marco", "diego", "ugo", "lucas", "matheus", "nicolas",
		"heitor", "valentim", "rafael", "miguel", "davi", "henrique",
	]);
	if (masculineExceptions.has(lower)) return false;
	// Clear feminine: names ending in -a or -ã (Ana, Maria, Paula, Sofia)
	if (lower.endsWith("a") || lower.endsWith("ã")) return true;
	// Ambiguous endings (-e, -u, etc.) → don't filter
	return false;
}

/**
 * Check if an entity name looks masculine (Portuguese/English heuristics).
 * Returns only for CLEARLY masculine names (ending in -o, -ão, -lin).
 * Returns false for ambiguous endings — better to not filter.
 */
function isMasculineEntity(entity: string): boolean {
	const lower = entity.toLowerCase();
	// Clear feminine exceptions
	const feminineExceptions = new Set(["raquel"]);
	if (feminineExceptions.has(lower)) return false;
	// Clear masculine: names ending in -o, -ão, -lin (Paulo, João, Marlin)
	if (lower.endsWith("o") || lower.endsWith("ão") || lower.endsWith("lin")) {
		return true;
	}
	// Ambiguous endings (-e, -u, etc.) → don't filter
	return false;
}

/**
 * Quick check: does this text contain any pronoun worth resolving?
 */
export function hasResolvablePronoun(text: string): boolean {
	for (const pattern of PRONOUN_PATTERNS) {
		pattern.regex.lastIndex = 0;
		if (pattern.regex.test(text)) {
			pattern.regex.lastIndex = 0;
			return true;
		}
		pattern.regex.lastIndex = 0;
	}
	return false;
}
