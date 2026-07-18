/**
 * dream-memory/distill/skill-gen.ts
 * Auto-generate skills from tool usage patterns
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";

export interface SkillPattern {
	tool: string;
	argsHash: string;
	argsPreview: string;
	frequency: number;
	confidence: number;
}

/**
 * Validate a tool name is safe for filesystem use.
 * Tool names must be ASCII alphanumeric + underscore + hyphen; no path separators,
 * no relative-path tokens. Anything else is hashed into a safe form.
 */
export function sanitizeToolName(tool: string): string {
	if (typeof tool !== "string" || tool.length === 0) {
		return "unknown";
	}
	if (/^[a-zA-Z0-9_-]+$/.test(tool)) {
		return tool;
	}
	// Hash unsafe tool names (e.g., "cmd/exec", "../escape", unicode) so they
	// cannot escape the skills directory. Keep short, filesystem-safe form.
	return `safe-${createHash("sha256").update(tool).digest("hex").slice(0, 12)}`;
}

/**
 * Generate SKILL.md content from a pattern
 */
export function generateSkillContent(pattern: SkillPattern): string {
	const safeTool = sanitizeToolName(pattern.tool);
	const skillName = `auto-${safeTool}-${pattern.argsHash.slice(0, 8)}`;

	return `---
name: ${skillName}
description: Auto-generated from ${pattern.frequency} uses of ${pattern.tool}
---

# ${pattern.tool} Pattern

## When to Use

This skill was automatically detected from repeated usage of \`${pattern.tool}\`.
Used ${pattern.frequency} times with similar arguments (confidence: ${(pattern.confidence * 100).toFixed(0)}%).

## Procedure

1. Use the \`${pattern.tool}\` tool
2. Arguments pattern: \`${pattern.argsPreview.slice(0, 100)}\`

## Examples

Pattern detected from session history. Review and refine this skill as needed.
`;
}

/**
 * Save skill to disk
 *
 * SECURITY: `pattern.tool` is sanitized before being used as a directory name.
 * Unsanitized, a tool name like `../../etc/passwd` or `cmd/exec` could write
 * files outside `skillsDir` (path traversal / unintended parent directories).
 */
export function saveSkill(pattern: SkillPattern, skillsDir: string): string {
	const safeTool = sanitizeToolName(pattern.tool);
	const skillName = `auto-${safeTool}-${pattern.argsHash.slice(0, 8)}`;
	const skillDir = join(skillsDir, skillName);

	// Defense in depth: verify the resolved path stays inside skillsDir.
	// `basename` ensures the final segment has no slashes; if the
	// sanitized tool name itself was somehow malicious, basename still
	// strips any embedded path components.
	const safeName = basename(skillName);
	if (safeName !== skillName || safeName.includes("/") || safeName.includes("..")) {
		throw new Error(`Refusing to write skill with unsafe name: ${skillName}`);
	}
	const safeDir = join(skillsDir, safeName);

	mkdirSync(safeDir, { recursive: true });

	const content = generateSkillContent(pattern);
	const filePath = join(safeDir, "SKILL.md");

	writeFileSync(filePath, content, "utf-8");

	return filePath;
}

/**
 * Check if skill already exists
 */
export function skillExists(pattern: SkillPattern, skillsDir: string): boolean {
	const safeTool = sanitizeToolName(pattern.tool);
	const skillName = `auto-${safeTool}-${pattern.argsHash.slice(0, 8)}`;
	const filePath = join(skillsDir, basename(skillName), "SKILL.md");

	return existsSync(filePath);
}
