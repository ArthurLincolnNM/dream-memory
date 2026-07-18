/**
 * dream-memory/sanitize/temporal.ts
 *
 * Normalize temporal references in memory content to absolute ISO dates.
 * Inspired by Anthropic Auto Dream Phase 3: convert "yesterday" → "on 2026-06-13"
 * so memories remain interpretable as they age.
 *
 * Runs in the dream_memory_add pipeline, AFTER sanitizeCredentials but BEFORE save.
 * Silent: if no temporal references detected, returns input unchanged.
 */

export interface NormalizeResult {
	normalized: string;
	changed: boolean;
	references: Array<{ original: string; absolute: string; offsetDays: number }>;
}

/**
 * Subtract `days` from a timestamp and return YYYY-MM-DD.
 *
 * Uses the local timezone (getFullYear/Month/Date), NOT UTC. The previous
 * implementation used getUTC* methods, which gave the WRONG date for any
 * user not in UTC: a user in UTC-3 (Brazil) saying "hoje" at 23h local
 * time would have the temporal normalizer return tomorrow's date because
 * UTC had already rolled over. "yesterday" and weekday references had the
 * same off-by-one bug. The fix is one-line but the user-facing impact
 * was real: memories got the wrong date attached.
 */
function isoDate(timestamp: number): string {
	const d = new Date(timestamp);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/**
 * Resolve "last Monday/Tuesday/..." to the most recent occurrence.
 * Uses the local weekday for the same reason as `isoDate`.
 *
 * Edge case: when `diff === 0` (today IS the target weekday), the answer
 * is today (offset 0) — not last week. The previous code did `diff += 7`
 * unconditionally when `diff <= 0`, which produced -7 for "last monday"
 * on a Monday. The test (temporal.test.ts:111) flagged this with
 * `offset should be >= -6, got -7`. The fix: short-circuit on diff=0.
 */
function lastWeekday(weekday: number, now: number): number {
	const today = new Date(now);
	const currentWeekday = today.getDay();
	const diff = currentWeekday - weekday;
	if (diff === 0) return now; // today IS the target weekday
	if (diff < 0) return now - (diff + 7) * 86400000; // today is earlier in the week
	return now - diff * 86400000; // today is later in the week (most common case)
}

const WEEKDAY_MAP: Record<string, number> = {
	sunday: 0, sun: 0,
	monday: 1, mon: 1,
	tuesday: 2, tue: 2, tues: 2,
	wednesday: 3, wed: 3,
	thursday: 4, thu: 4, thurs: 4,
	friday: 5, fri: 5,
	saturday: 6, sat: 6,
};

interface Pattern {
	// Regex must capture a phrase. Case-insensitive. Word boundaries recommended.
	regex: RegExp;
	// Resolver: given the match, return offset days (negative=past, positive=future)
	resolve: (match: RegExpMatchArray, now: number) => number;
	// Replacement formatter: given resolved date and match, return replacement string
	format: (isoDate: string, match: RegExpMatchArray) => string;
}

const PATTERNS: Pattern[] = [
	// ── English: today / yesterday / tomorrow ────────────────────────────
	{
		regex: /(?<!\w)today(?!\w)/gi,
		resolve: () => 0,
		format: (iso) => `on ${iso}`,
	},
	{
		regex: /(?<!\w)yesterday(?!\w)/gi,
		resolve: () => -1,
		format: (iso) => `on ${iso}`,
	},
	{
		regex: /(?<!\w)tomorrow(?!\w)/gi,
		resolve: () => 1,
		format: (iso) => `on ${iso}`,
	},
	// ── English: N <unit> ago (days/weeks/months/years) ──────────────────
	{
		regex: /(?<!\w)(?:a|an|\d+)\s+(?:day|days)\s+ago(?!\w)/gi,
		resolve: (m) => {
			const n = m[0].match(/^(a|an|\d+)/i)?.[0].toLowerCase();
			return n === "a" || n === "an" ? -1 : -parseInt(n!, 10);
		},
		format: (iso) => `on ${iso}`,
	},
	{
		regex: /(?<!\w)(?:a|an|\d+)\s+(?:week|weeks)\s+ago(?!\w)/gi,
		resolve: (m) => {
			const n = m[0].match(/^(a|an|\d+)/i)?.[0].toLowerCase();
			return (n === "a" || n === "an" ? -1 : -parseInt(n!, 10)) * 7;
		},
		format: (iso) => `on ${iso}`,
	},
	{
		regex: /(?<!\w)(?:a|an|\d+)\s+(?:month|months)\s+ago(?!\w)/gi,
		resolve: (m) => {
			const n = m[0].match(/^(a|an|\d+)/i)?.[0].toLowerCase();
			return (n === "a" || n === "an" ? -1 : -parseInt(n!, 10)) * 30;
		},
		format: (iso) => `on ${iso}`,
	},
	{
		regex: /(?<!\w)(?:a|an|\d+)\s+(?:year|years)\s+ago(?!\w)/gi,
		resolve: (m) => {
			const n = m[0].match(/^(a|an|\d+)/i)?.[0].toLowerCase();
			return (n === "a" || n === "an" ? -1 : -parseInt(n!, 10)) * 365;
		},
		format: (iso) => `on ${iso}`,
	},
	// ── English: relative named periods ──────────────────────────────────
	{
		regex: /(?<!\w)last\s+week(?!\w)/gi,
		resolve: () => -7,
		format: (iso) => `in the week of ${iso}`,
	},
	{
		regex: /(?<!\w)this\s+week(?!\w)/gi,
		resolve: () => 0,
		format: (iso) => `in the week of ${iso}`,
	},
	{
		regex: /(?<!\w)last\s+month(?!\w)/gi,
		resolve: () => -30,
		format: (iso) => `in the month of ${iso.slice(0, 7)}`,
	},
	{
		regex: /(?<!\w)this\s+month(?!\w)/gi,
		resolve: () => 0,
		format: (iso) => `in the month of ${iso.slice(0, 7)}`,
	},
	// ── English: last <weekday> ──────────────────────────────────────────
	{
		regex: /(?<!\w)last\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thurs|fri|sat)(?!\w)/gi,
		resolve: (m) => {
			const day = WEEKDAY_MAP[m[1].toLowerCase()];
			if (day === undefined) return 0;
			const ts = lastWeekday(day, Date.now());
			// Return diff in days (negative — "last monday" is in the past).
			// The previous formula `(Date.now() - ts) / 86400000` returned a
			// POSITIVE number for past timestamps, so the resolved date was
			// (referenceTime + positiveDays) = a future date. The negation
			// here fixes the sign so the result matches other past patterns
			// (e.g., "yesterday" returns -1).
			return -Math.round((Date.now() - ts) / 86400000);
		},
		format: (iso) => `on ${iso}`,
	},
	// ── English: in N days/weeks/months (future) ─────────────────────────
	{
		regex: /(?<!\w)in\s+(\d+)\s+(day|days)(?!\w)/gi,
		resolve: (m) => parseInt(m[1], 10),
		format: (iso) => `by ${iso}`,
	},
	{
		regex: /(?<!\w)in\s+(\d+)\s+(week|weeks)(?!\w)/gi,
		resolve: (m) => parseInt(m[1], 10) * 7,
		format: (iso) => `by ${iso}`,
	},
	// ── Portuguese: hoje / ontem / amanhã ────────────────────────────────
	{
		regex: /(?<!\w)hoje(?!\w)/gi,
		resolve: () => 0,
		format: (iso) => `em ${iso}`,
	},
	{
		regex: /(?<!\w)ontem(?!\w)/gi,
		resolve: () => -1,
		format: (iso) => `em ${iso}`,
	},
	{
		regex: /(?<!\w)amanhã(?!\w)/gi,
		resolve: () => 1,
		format: (iso) => `em ${iso}`,
	},
	{
		regex: /(?<!\w)anteontem(?!\w)/gi,
		resolve: () => -2,
		format: (iso) => `em ${iso}`,
	},
	// ── Portuguese: há N <unit> / faz N <unit> ──────────────────────────
	{
		regex: /(?<!\w)há\s+(?:uma?|dois|duas|três|quatro|cinco|\d+)\s+(?:dia|dias)(?!\w)/gi,
		resolve: (m) => {
			const num = m[0].match(/há\s+([\wà-\u00ff]+)/i)?.[1]?.toLowerCase();
			const map: Record<string, number> = {
				"um": 1, "uma": 1, "dois": 2, "duas": 2,
				"três": 3, "tres": 3, "quatro": 4, "cinco": 5,
			};
			const n = map[num!] ?? parseInt(num!, 10);
			return isNaN(n) ? -1 : -n;
		},
		format: (iso) => `em ${iso}`,
	},
	{
		regex: /(?<!\w)há\s+(?:uma?|\d+)\s+(?:semana|semanas)(?!\w)/gi,
		resolve: (m) => {
			const num = m[0].match(/há\s+([\wà-\u00ff]+)/i)?.[1]?.toLowerCase();
			const n = num === "um" || num === "uma" ? 1 : parseInt(num!, 10);
			return isNaN(n) ? -7 : -n * 7;
		},
		format: (iso) => `em ${iso}`,
	},
	{
		regex: /(?<!\w)há\s+(?:um|\d+)\s+(?:mês|meses)(?!\w)/gi,
		resolve: (m) => {
			const num = m[0].match(/há\s+([\wà-\u00ff]+)/i)?.[1]?.toLowerCase();
			const n = num === "um" ? 1 : parseInt(num!, 10);
			return isNaN(n) ? -30 : -n * 30;
		},
		format: (iso) => `em ${iso.slice(0, 7)}`,
	},
	{
		regex: /(?<!\w)há\s+(?:um|\d+)\s+(?:ano|anos)(?!\w)/gi,
		resolve: (m) => {
			const num = m[0].match(/há\s+([\wà-\u00ff]+)/i)?.[1]?.toLowerCase();
			const n = num === "um" ? 1 : parseInt(num!, 10);
			return isNaN(n) ? -365 : -n * 365;
		},
		format: (iso) => `em ${iso.slice(0, 4)}`,
	},
	{
		regex: /(?<!\w)faz\s+(?:uma?|\d+)\s+(?:dia|dias)(?!\w)/gi,
		resolve: (m) => {
			const num = m[0].match(/faz\s+([\wà-\u00ff]+)/i)?.[1]?.toLowerCase();
			const map: Record<string, number> = {
				"um": 1, "uma": 1, "dois": 2, "duas": 2,
				"três": 3, "tres": 3,
			};
			const n = map[num!] ?? parseInt(num!, 10);
			return isNaN(n) ? -1 : -n;
		},
		format: (iso) => `em ${iso}`,
	},
	{
		regex: /(?<!\w)faz\s+(?:uma?|\d+)\s+(?:semana|semanas)(?!\w)/gi,
		resolve: (m) => {
			const num = m[0].match(/faz\s+([\wà-\u00ff]+)/i)?.[1]?.toLowerCase();
			const n = num === "um" || num === "uma" ? 1 : parseInt(num!, 10);
			return isNaN(n) ? -7 : -n * 7;
		},
		format: (iso) => `em ${iso}`,
	},
	// ── Portuguese: named periods ────────────────────────────────────────
	{
		regex: /(?<!\w)semana\s+passada(?!\w)/gi,
		resolve: () => -7,
		format: (iso) => `na semana de ${iso}`,
	},
	{
		regex: /(?<!\w)semana\s+retrasada(?!\w)/gi,
		resolve: () => -14,
		format: (iso) => `na semana de ${iso}`,
	},
	{
		regex: /(?<!\w)mês\s+passado(?!\w)/gi,
		resolve: () => -30,
		format: (iso) => `no mês de ${iso.slice(0, 7)}`,
	},
	{
		regex: /(?<!\w)ano\s+passado(?!\w)/gi,
		resolve: () => -365,
		format: (iso) => `no ano de ${iso.slice(0, 4)}`,
	},
	// ── Portuguese: em N dias (future) ───────────────────────────────────
	{
		regex: /(?<!\w)em\s+(\d+)\s+(?:dia|dias)(?!\w)/gi,
		resolve: (m) => parseInt(m[1], 10),
		format: (iso) => `até ${iso}`,
	},
	// ── Portuguese: daqui a N <unit> ─────────────────────────────────────
	{
		regex: /(?<!\w)daqui\s+a\s+(\d+)\s+(?:dia|dias)(?!\w)/gi,
		resolve: (m) => parseInt(m[1], 10),
		format: (iso) => `até ${iso}`,
	},
	{
		regex: /(?<!\w)daqui\s+a\s+(\d+)\s+(?:semana|semanas)(?!\w)/gi,
		resolve: (m) => parseInt(m[1], 10) * 7,
		format: (iso) => `até ${iso}`,
	},
];

/**
 * Normalize all relative temporal references in `text` to absolute ISO dates.
 * @param text Input text
 * @param referenceTime Optional reference timestamp (default: Date.now())
 */
export function normalizeTemporalReferences(text: string, referenceTime: number = Date.now()): NormalizeResult {
	let normalized = text;
	const references: NormalizeResult["references"] = [];
	let changed = false;

	for (const pattern of PATTERNS) {
		// Reset regex state for global flag
		pattern.regex.lastIndex = 0;

		normalized = normalized.replace(pattern.regex, (match, ...args) => {
			// `args` is [...captureGroups, offset, fullString] for the replace
			// callback. We rebuild a real RegExpMatchArray so the resolver can
			// access capture groups (m[1], m[2], ...) — the previous code passed
			// `[match]` which dropped every capture, breaking patterns like
			// `/in (\d+) days/` that depend on m[1] for the offset.
			const offsetIdx = args.length - 2;
			const captureGroups = args.slice(0, offsetIdx);
			const matchArray = [match, ...captureGroups] as RegExpMatchArray;
			// Index + input + groups are part of the RegExpMatchArray shape; some
			// resolvers inspect them, so populate what we can.
			(matchArray as any).index = typeof args[offsetIdx] === "number" ? args[offsetIdx] : 0;
			(matchArray as any).input = typeof args[args.length - 1] === "string" ? args[args.length - 1] : "";

			const offsetDays = pattern.resolve(matchArray, referenceTime);
			const ts = referenceTime + offsetDays * 86400000;
			const iso = isoDate(ts);
			references.push({ original: match, absolute: iso, offsetDays });
			changed = true;
			return pattern.format(iso, matchArray);
		});
	}

	return { normalized, changed, references };
}

/**
 * Quick check: does this text contain any temporal reference worth normalizing?
 */
export function hasTemporalReference(text: string): boolean {
	for (const pattern of PATTERNS) {
		pattern.regex.lastIndex = 0;
		if (pattern.regex.test(text)) {
			pattern.regex.lastIndex = 0;
			return true;
		}
		pattern.regex.lastIndex = 0;
	}
	return false;
}
