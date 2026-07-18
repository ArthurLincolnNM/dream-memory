/**
 * dream-memory/sanitize/credentials.ts
 * Credential detection and sanitization before memory storage
 */

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
	// OpenAI keys
	{ pattern: /\bsk-[A-Za-z0-9\-]{20,}\b/g, replacement: "[OPENAI_KEY_REDACTED]" },
	// Anthropic keys
	{ pattern: /\bsk-ant-[A-Za-z0-9\-]{20,}\b/g, replacement: "[ANTHROPIC_KEY_REDACTED]" },
	// Bearer tokens (with prefix)
	{ pattern: /Bearer\s+[A-Za-z0-9\-._~+/]{20,}=*/g, replacement: "Bearer [TOKEN_REDACTED]" },
	// Generic API keys/secrets
	{ pattern: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"]?([^\s'"`,;}{]{8,})/gi, replacement: "[SECRET_REDACTED]" },
	// AWS keys
	{ pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[AWS_KEY_REDACTED]" },
	// GitHub tokens (PAT, fine-grained, OAuth, server, refresh)
	{ pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, replacement: "[GITHUB_TOKEN_REDACTED]" },
	// Private keys: match the WHOLE block (header + body + footer) in one go.
	// Previous pattern only caught the BEGIN line, leaving the base64 body in
	// the saved memory. Use [\s\S] (no `s` flag for broad compat) and a
	// non-greedy body so we stop at the first END line.
	{ pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g, replacement: "[PRIVATE_KEY_REDACTED]" },
	// JWT tokens (3 base64url segments separated by dots). Matches naked JWTs
	// (no Bearer prefix). Header.claims.signature — each segment is
	// base64url-safe (A-Z a-z 0-9 - _). Minimum lengths guard against
	// false positives on short dotted identifiers like "1.2.3".
	{ pattern: /\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g, replacement: "[JWT_REDACTED]" },
];

export function sanitizeCredentials(text: string): { sanitized: string; redacted: boolean } {
	let sanitized = text;
	let redacted = false;

	for (const { pattern, replacement } of SECRET_PATTERNS) {
		if (pattern.test(sanitized)) {
			sanitized = sanitized.replace(pattern, replacement);
			redacted = true;
		}
		// Reset regex lastIndex for global patterns
		pattern.lastIndex = 0;
	}

	return { sanitized, redacted };
}

export function hasCredentials(text: string): boolean {
	for (const { pattern } of SECRET_PATTERNS) {
		if (pattern.test(text)) {
			pattern.lastIndex = 0;
			return true;
		}
		pattern.lastIndex = 0;
	}
	return false;
}
