import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedPreviewUrl, previewUrlProblem } from "../src/renderer/preview-url.ts";

test("only explicit loopback http origins are previewable", () => {
  assert.equal(isAllowedPreviewUrl("http://localhost:3000/"), true);
  assert.equal(isAllowedPreviewUrl("http://127.0.0.1:5173/app?x=1"), true);
  assert.equal(isAllowedPreviewUrl("http://[::1]:8080/"), true);
  assert.equal(isAllowedPreviewUrl("https://localhost:3000/"), false);
  assert.equal(isAllowedPreviewUrl("http://example.com/"), false);
  assert.equal(isAllowedPreviewUrl("http://192.168.1.10:3000/"), false);
  assert.equal(isAllowedPreviewUrl("http://user:pass@localhost:3000/"), false);
  assert.equal(isAllowedPreviewUrl("file:///etc/passwd"), false);
  assert.equal(isAllowedPreviewUrl("javascript:alert(1)"), false);
  assert.equal(typeof previewUrlProblem("http://example.com/"), "string");
  assert.equal(previewUrlProblem("http://localhost:3000/"), null);
});
