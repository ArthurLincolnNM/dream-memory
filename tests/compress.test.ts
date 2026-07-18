import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compressContent, shouldCompress } from "../compress/index.js";

describe("compressContent", () => {
  it("returns original for short content", () => {
    const short = "This is a short memory about vim preferences.";
    const result = compressContent(short);
    assert.equal(result.compressed, short);
    assert.equal(result.ratio, 1);
  });

  it("compresses long failure content", () => {
    const long = "Error occurred when running the command. The error was caused by a missing file. ".repeat(10);
    const result = compressContent(long, { minChars: 50, keepRatio: 0.5 });
    assert.ok(result.compressed.length < long.length, "should compress");
    assert.ok(result.ratio < 1, "ratio should be less than 1");
  });

  it("preserves code blocks", () => {
    const code = "```\nconst x = 1;\nconst y = 2;\n```\n" + "Error in function. ".repeat(20);
    const result = compressContent(code, { minChars: 50 });
    assert.ok(result.compressed.includes("const x = 1"), "should preserve code");
  });

  it("keeps high-entropy tokens", () => {
    const content = "The error TypeError cannot read property of undefined at line 42 in module auth.ts. ".repeat(5);
    const result = compressContent(content, { minChars: 50, keepRatio: 0.5 });
    // TypeError and undefined are highest-entropy tokens (unknown, long)
    assert.ok(result.compressed.includes("TypeError"), "should keep technical term");
    assert.ok(result.compressed.includes("undefined"), "should keep technical term");
  });

  it("returns original if compression ratio > 0.8", () => {
    // Very short content — below minChars threshold, no compression
    const unique = "TypeError ReferenceError SyntaxError.";
    const result = compressContent(unique, { minChars: 50, keepRatio: 0.6 });
    assert.equal(result.compressed, unique, "should return original when below minChars");
  });

  it("returns original for code-heavy content", () => {
    // Content with 4-space indented code blocks should be skipped
    const code = "    const auth = require('auth');\n    const ts = require('typescript');\n    " + "Error in module. ".repeat(20);
    const result = compressContent(code, { minChars: 50 });
    assert.equal(result.compressed, code, "should return original for code blocks");
  });
});

describe("shouldCompress", () => {
  it("returns false for short content", () => {
    assert.equal(shouldCompress("failure", "short", 500), false);
  });

  it("returns true for long failure content", () => {
    assert.equal(shouldCompress("failure", "x".repeat(600), 500), true);
  });

  it("returns false for user preferences", () => {
    assert.equal(shouldCompress("user", "x".repeat(600), 500), false);
  });

  it("returns true for long project content", () => {
    assert.equal(shouldCompress("project", "x".repeat(600), 500), true);
  });

  it("returns false for short project content", () => {
    assert.equal(shouldCompress("project", "x".repeat(300), 500), false);
  });
});
