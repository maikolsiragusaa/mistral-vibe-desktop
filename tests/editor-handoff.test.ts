import assert from "node:assert/strict";
import test from "node:test";
import {
  ACP_HANDOFF_NOTE,
  buildEditorArgv,
  editorDisplayLabel,
  validateCustomEditorPath,
  validateHandoffTarget,
} from "../src/renderer/editor-handoff.ts";

test("custom editor paths accept absolute exes and refuse shells/URLs/relative", () => {
  assert.equal(validateCustomEditorPath("C:\\Program Files\\VSCode\\Code.exe"), "C:\\Program Files\\VSCode\\Code.exe");
  assert.equal(validateCustomEditorPath("/usr/bin/code"), "/usr/bin/code");
  assert.equal(validateCustomEditorPath("code"), null);
  assert.equal(validateCustomEditorPath("https://example.com/code.exe"), null);
  assert.equal(validateCustomEditorPath("C:\\tools\\a.exe; rm -rf"), null);
  assert.equal(validateCustomEditorPath("C:\\tools\\a.exe | evil"), null);
  assert.equal(validateCustomEditorPath(""), null);
  assert.equal(validateCustomEditorPath(null), null);
});

test("handoff targets stay inside the workspace", () => {
  assert.equal(validateHandoffTarget({ folder: "C:\\repo" }), null);
  assert.equal(validateHandoffTarget({ folder: "C:\\repo", file: "src/a.ts", line: 10 }), null);
  assert.match(validateHandoffTarget({ folder: "repo" }) ?? "", /absolute/);
  assert.match(validateHandoffTarget({ folder: "C:\\repo", file: "../escape" }) ?? "", /inside/);
  assert.match(validateHandoffTarget({ folder: "C:\\repo", file: "C:\\other\\a" }) ?? "", /inside/);
  assert.match(validateHandoffTarget({ folder: "C:\\repo", file: ".git/config" }) ?? "", /inside/);
  assert.match(validateHandoffTarget({ folder: "C:\\repo", file: "a.ts", line: 0 }) ?? "", /Line/);
});

test("argv is structured with no shell interpolation", () => {
  assert.deepEqual(buildEditorArgv("vscode", { folder: "C:\\repo" }), ["C:\\repo"]);
  const goto = buildEditorArgv("vscode", { folder: "C:\\repo", file: "src/a.ts", line: 12 });
  assert.ok(goto && goto[0] === "C:\\repo" && goto[1] === "--goto" && goto[2].endsWith("a.ts:12"));
  assert.equal(buildEditorArgv("vscode", { folder: "repo" }), null);
});

test("editor labels never promise unverified editors; ACP note denies session sharing", () => {
  assert.equal(editorDisplayLabel({ id: "vscode", label: "Visual Studio Code", exePath: "C:\\x\\Code.exe", verified: true }), "Visual Studio Code");
  assert.match(editorDisplayLabel({ id: "cursor", label: "Cursor", exePath: null, verified: false }), /not found/);
  assert.match(ACP_HANDOFF_NOTE, /does not attach/);
  assert.match(ACP_HANDOFF_NOTE, /vibe-acp/);
});
