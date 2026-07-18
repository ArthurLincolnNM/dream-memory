/**
 * dream-memory/dream/instructions.ts
 * Parse and apply steerable instructions for Dream
 */

export interface DreamInstructions {
	raw: string;
	focus: string[];
	preserve: string[];
	ignore: string[];
	merge: boolean;
	outputFormat: "flat" | "categorized";
}

/**
 * Parse instructions string into structured format
 *
 * Multi-term parsing: "focus on X, Y and Z" yields three focus terms
 * ["X", "Y", "Z"]. The previous non-greedy regex stopped at the first
 * delimiter, silently dropping everything after the comma.
 */
export function parseInstructions(raw: string): DreamInstructions {
	const instructions: DreamInstructions = {
		raw,
		focus: [],
		preserve: [],
		ignore: [],
		merge: true,
		outputFormat: "categorized",
	};

	if (!raw || raw.trim() === "") {
		return instructions;
	}

	const lower = raw.toLowerCase();

	// Split a trailing clause into individual terms. Handles "X, Y, Z" and
	// "X, Y and Z" (the trailing "and" is dropped). The " e " (PT-BR "and")
	// alternation uses a negative lookbehind on \w so it does NOT match
	// inside compound words like "Enterprise", "email", or "decide" — the
	// previous split on bare `\s+e\s+` would break such words, silently
	// losing the second half ("decide coisas" → ["d", "coisas"]).
	function splitTerms(clause: string): string[] {
		return clause
			.split(/[;,.]|\s+and\s+|(?<!\w)e\s+/i)
			.map((t) => t.trim())
			.filter((t) => t.length > 0);
	}

	// Match the verb (non-greedy) and capture the rest of the sentence.
	// The captured group can include commas / "and" — splitTerms handles those.
	const focusVerbs = ["focus on", "concentrate on", "prioritize", "emphasize"];
	for (const verb of focusVerbs) {
		const re = new RegExp(verb + "\\s+(.+?)(?:\\.|$)", "i");
		const m = raw.match(re);
		if (m) {
			instructions.focus.push(...splitTerms(m[1]));
		}
	}

	const preserveVerbs = ["preserve", "keep", "maintain", "don't remove", "do not remove"];
	for (const verb of preserveVerbs) {
		const re = new RegExp(verb + "\\s+(.+?)(?:\\.|$)", "i");
		const m = raw.match(re);
		if (m) {
			instructions.preserve.push(...splitTerms(m[1]));
		}
	}

	const ignoreVerbs = ["ignore", "skip", "remove", "discard"];
	for (const verb of ignoreVerbs) {
		const re = new RegExp(verb + "\\s+(.+?)(?:\\.|$)", "i");
		const m = raw.match(re);
		if (m) {
			instructions.ignore.push(...splitTerms(m[1]));
		}
	}

	// Deduplicate terms (same focus area mentioned twice should only appear once)
	instructions.focus = Array.from(new Set(instructions.focus));
	instructions.preserve = Array.from(new Set(instructions.preserve));
	instructions.ignore = Array.from(new Set(instructions.ignore));

	// Check for merge preference
	if (lower.includes("don't merge") || lower.includes("do not merge") || lower.includes("keep duplicates")) {
		instructions.merge = false;
	}

	// Check for output format
	if (lower.includes("flat") || lower.includes("simple")) {
		instructions.outputFormat = "flat";
	}

	return instructions;
}

/**
 * Apply instructions to memories and return them tagged with shouldKeep.
 * Memories matching an `ignore` pattern are marked shouldKeep=false.
 * Memories not matching any focus/preserve term get a "low priority" reason
 * (but are still kept).
 *
 * Use `filterMemories` if you want a pre-filtered list.
 */
export function applyInstructions(
	memories: Array<{ content: string; target: string; category?: string; scope: string }>,
	instructions: DreamInstructions,
): Array<{ content: string; target: string; category?: string; scope: string; shouldKeep: boolean; reason?: string }> {
	return memories.map((memory) => {
		const result = { ...memory, shouldKeep: true as boolean, reason: undefined as string | undefined };

		// Check if memory should be ignored
		for (const ignoreTerm of instructions.ignore) {
			if (memory.content.toLowerCase().includes(ignoreTerm.toLowerCase())) {
				result.shouldKeep = false;
				result.reason = `Matches ignore pattern: "${ignoreTerm}"`;
				return result;
			}
		}

		// Check if memory matches focus areas
		const matchesFocus = instructions.focus.some((t) =>
			memory.content.toLowerCase().includes(t.toLowerCase()),
		);
		// Check if memory matches preserve areas
		const matchesPreserve = instructions.preserve.some((t) =>
			memory.content.toLowerCase().includes(t.toLowerCase()),
		);

		// If we have focus areas and memory doesn't match any, mark low priority
		if (instructions.focus.length > 0 && !matchesFocus && !matchesPreserve) {
			result.reason = "Does not match focus areas";
		}

		return result;
	});
}

/**
 * Filter memories by instructions. Returns the list with `shouldKeep=false`
 * entries removed. Convenience wrapper around `applyInstructions`.
 */
export function filterMemories<T extends { content: string; target: string; category?: string; scope: string }>(
	memories: T[],
	instructions: DreamInstructions,
): T[] {
	const tagged = applyInstructions(memories, instructions);
	// Cast through `unknown` because the tagged objects are structurally
	// compatible with T but the compiler can't verify that (T may have
	// extra fields that `applyInstructions` doesn't set). We trust that
	// the spread in `applyInstructions` preserves all T fields.
	return tagged.filter((m) => m.shouldKeep) as unknown as T[];
}

/**
 * Get default instructions
 */
export function getDefaultInstructions(): DreamInstructions {
	return {
		raw: "",
		focus: [],
		preserve: [],
		ignore: [],
		merge: true,
		outputFormat: "categorized",
	};
}
