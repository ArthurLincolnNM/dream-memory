/**
 * Tests for multi-ecosystem project marker detection (Phase 1 audit
 * finding: `isRealProject` was too narrow — only .git and package.json).
 *
 * Python (pyproject.toml), Rust (Cargo.toml), Go (go.mod), PHP
 * (composer.json) projects need their manifest names extracted, not just
 * the basename fallback. Marker-only entries (pom.xml, build.gradle,
 * Gemfile, mix.exs, Package.swift) should at least qualify the directory
 * as a project so a basename fallback kicks in.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRealProject, detectProject, PROJECT_MARKER_FILES } from "../scope/resolver.js";

function makeProjectDir(files: Record<string, string>): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "dm-marker-test-"));
	for (const [name, content] of Object.entries(files)) {
		if (name.endsWith("/")) {
			mkdirSync(join(dir, name), { recursive: true });
		} else {
			writeFileSync(join(dir, name), content);
		}
	}
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("isRealProject: true for .git", () => {
	const { dir, cleanup } = makeProjectDir({ ".git/": "" });
	try {
		assert.equal(isRealProject(dir), true);
	} finally {
		cleanup();
	}
});

test("isRealProject: true for package.json", () => {
	const { dir, cleanup } = makeProjectDir({ "package.json": '{"name":"x"}' });
	try {
		assert.equal(isRealProject(dir), true);
	} finally {
		cleanup();
	}
});

test("isRealProject: true for pyproject.toml", () => {
	const { dir, cleanup } = makeProjectDir({ "pyproject.toml": '[project]\nname = "x"' });
	try {
		assert.equal(isRealProject(dir), true);
	} finally {
		cleanup();
	}
});

test("isRealProject: true for Cargo.toml", () => {
	const { dir, cleanup } = makeProjectDir({ "Cargo.toml": '[package]\nname = "x"' });
	try {
		assert.equal(isRealProject(dir), true);
	} finally {
		cleanup();
	}
});

test("isRealProject: true for go.mod", () => {
	const { dir, cleanup } = makeProjectDir({ "go.mod": "module github.com/foo/bar\n" });
	try {
		assert.equal(isRealProject(dir), true);
	} finally {
		cleanup();
	}
});

test("isRealProject: true for composer.json", () => {
	const { dir, cleanup } = makeProjectDir({ "composer.json": '{"name":"vendor/pkg"}' });
	try {
		assert.equal(isRealProject(dir), true);
	} finally {
		cleanup();
	}
});

test("isRealProject: true for marker-only manifests (no name extractor)", () => {
	// These qualify as projects but won't have a name extracted by
	// MANIFEST_EXTRACTORS. detectProject should fall back to basename.
	for (const file of ["pom.xml", "build.gradle", "Gemfile", "mix.exs", "Package.swift"]) {
		const { dir, cleanup } = makeProjectDir({ [file]: "stub" });
		try {
			assert.equal(isRealProject(dir), true, `expected ${file} to qualify`);
		} finally {
			cleanup();
		}
	}
});

test("isRealProject: false for empty temp dir", () => {
	const dir = mkdtempSync(join(tmpdir(), "dm-empty-test-"));
	try {
		assert.equal(isRealProject(dir), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("PROJECT_MARKER_FILES is exported and non-empty", () => {
	assert.ok(Array.isArray(PROJECT_MARKER_FILES));
	assert.ok(PROJECT_MARKER_FILES.length >= 5);
	assert.ok(PROJECT_MARKER_FILES.includes(".git"));
	assert.ok(PROJECT_MARKER_FILES.includes("package.json"));
	assert.ok(PROJECT_MARKER_FILES.includes("pyproject.toml"));
	assert.ok(PROJECT_MARKER_FILES.includes("Cargo.toml"));
	assert.ok(PROJECT_MARKER_FILES.includes("go.mod"));
});

test("detectProject: extracts name from package.json", () => {
	const { dir, cleanup } = makeProjectDir({ "package.json": '{"name":"my-app"}' });
	try {
		// No git remote in a temp dir, so we fall through to manifest.
		assert.equal(detectProject(dir), "my-app");
	} finally {
		cleanup();
	}
});

test("detectProject: extracts name from pyproject.toml [project] section", () => {
	const { dir, cleanup } = makeProjectDir({
		"pyproject.toml": '[build-system]\nrequires = ["setuptools"]\n\n[project]\nname = "cool-pkg"\nversion = "0.1.0"\n',
	});
	try {
		assert.equal(detectProject(dir), "cool-pkg");
	} finally {
		cleanup();
	}
});

test("detectProject: extracts name from Cargo.toml [package] section", () => {
	const { dir, cleanup } = makeProjectDir({
		"Cargo.toml": '[package]\nname = "rust-crate"\nversion = "0.1.0"\nedition = "2021"\n',
	});
	try {
		assert.equal(detectProject(dir), "rust-crate");
	} finally {
		cleanup();
	}
});

test("detectProject: extracts name from go.mod module path's last segment", () => {
	const { dir, cleanup } = makeProjectDir({
		"go.mod": "module github.com/user/cool-service\n\ngo 1.22\n",
	});
	try {
		assert.equal(detectProject(dir), "cool-service");
	} finally {
		cleanup();
	}
});

test("detectProject: extracts name from composer.json", () => {
	const { dir, cleanup } = makeProjectDir({ "composer.json": '{"name":"vendor/composer-pkg"}' });
	try {
		assert.equal(detectProject(dir), "vendor/composer-pkg");
	} finally {
		cleanup();
	}
});

test("detectProject: marker-only manifest falls back to basename", () => {
	const { dir, cleanup } = makeProjectDir({ "pom.xml": "<project></project>" });
	try {
		const name = detectProject(dir);
		// basename of mkdtemp prefix is unpredictable; just check that we got *some* name.
		assert.ok(name && name.length > 0, "expected basename fallback to yield a name");
	} finally {
		cleanup();
	}
});

test("detectProject: returns undefined for non-project dir", () => {
	const dir = mkdtempSync(join(tmpdir(), "dm-no-marker-"));
	try {
		assert.equal(detectProject(dir), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("detectProject: prefers package.json name over Cargo.toml", () => {
	// Edge case: a polyglot repo with both manifests. package.json is
	// first in MANIFEST_EXTRACTORS, so it wins. This matches user
	// expectation: a JS+Rust project usually has the JS package name as
	// the "primary" identifier.
	const { dir, cleanup } = makeProjectDir({
		"package.json": '{"name":"js-name"}',
		"Cargo.toml": '[package]\nname = "rs-name"\n',
	});
	try {
		assert.equal(detectProject(dir), "js-name");
	} finally {
		cleanup();
	}
});
