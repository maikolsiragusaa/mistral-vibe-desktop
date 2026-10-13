import assert from "node:assert/strict";
import test from "node:test";
import {
  parseArgsText,
  parseEnvText,
  statusLabel,
  validMcpEndpoint,
  validMcpName,
  validSkillAlias,
  validSkillId,
  validSkillVersion,
  validScope,
  validStdioCommand,
  validStdioCwd,
} from "../src/renderer/resources/validation.ts";
import {
  componentsFromInfo,
  fieldsFromConfig,
  getErrorMessage,
  listFromCatalog,
  listFromPlugins,
  listFromSkills,
  sourcesFromMcp,
} from "../src/renderer/resources/adapters.ts";
import { capabilityOf } from "../src/renderer/resources/types.ts";

test("MCP endpoint validation stays HTTPS-only without credentials", () => {
  assert.equal(validMcpEndpoint("https://example.com/mcp"), true);
  assert.equal(validMcpEndpoint("http://example.com/mcp"), false);
  assert.equal(validMcpEndpoint("https://user:pass@example.com/mcp"), false);
  assert.equal(validMcpEndpoint("https://example.com/mcp?x=1"), false);
  assert.equal(validMcpEndpoint("https://example.com/mcp#frag"), false);
  assert.equal(validMcpEndpoint("not a url"), false);
});

test("skill identifiers, aliases, versions and scopes validate canonically", () => {
  assert.equal(validSkillId("hf-cli"), true);
  assert.equal(validSkillId(""), false);
  assert.equal(validSkillId("a".repeat(513)), false);
  assert.equal(validSkillAlias("my-alias_1"), true);
  assert.equal(validSkillAlias("bad alias!"), false);
  assert.equal(validSkillVersion("3"), 3);
  assert.equal(validSkillVersion("0"), null);
  assert.equal(validSkillVersion("x"), null);
  assert.equal(validSkillVersion(""), null);
  assert.equal(validScope(""), true);
  assert.equal(validScope("global"), true);
  assert.equal(validScope("project"), true);
  assert.equal(validScope("everywhere"), false);
});

test("stdio command, cwd, args and env reject shell strings and junk", () => {
  assert.equal(validStdioCommand("python"), null);
  assert.equal(typeof validStdioCommand(""), "string");
  assert.equal(typeof validStdioCommand("cmd.exe & evil"), "string");
  assert.equal(typeof validStdioCommand("a;b"), "string");
  assert.equal(typeof validStdioCommand("evil$(id)"), "string");
  assert.equal(validStdioCwd(""), null);
  assert.equal(validStdioCwd("C:\\tools\\srv"), null);
  assert.equal(typeof validStdioCwd("relative/path"), "string");
  assert.equal(typeof validStdioCwd("\\\\server\\share"), "string");
  assert.equal(validMcpName("fixture-stdio"), true);
  assert.equal(validMcpName("bad name!"), false);
  const args = parseArgsText("-V\n--stdio\n");
  assert.deepEqual(args.args, ["-V", "--stdio"]);
  assert.equal(args.error, null);
  assert.equal(parseArgsText("a\n".repeat(65)).error !== null, true);
  const env = parseEnvText("FOO=bar\n# comment\nEMPTY=");
  assert.equal(env.error, null);
  assert.deepEqual(env.entries, [
    { key: "FOO", value: "bar" },
    { key: "EMPTY", value: "" },
  ]);
  assert.equal(parseEnvText("NOEQUALS").error !== null, true);
  assert.equal(parseEnvText("1BAD=x").error !== null, true);
});

test("adapters never use list indexes as identities and tolerate additive fields", () => {
  const skills = listFromSkills({ skills: [{ name: "hf-cli", description: "d" }, { nope: 1 }, null] });
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "hf-cli");
  const catalog = listFromCatalog({ skills: [{ name: "x", skillId: "x", versions: ["1", 2] }] });
  assert.equal(catalog[0].skillId, "x");
  assert.deepEqual(catalog[0].versions, ["1", 2]);
  const sources = sourcesFromMcp({
    mcp: {
      sources: [
        { name: "github_app", kind: "connector", status: "connected", tools: [{ name: "t", enabled: true }] },
        { name: "", kind: "server" },
      ],
    },
  });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].tools?.length, 1);
  const plugins = listFromPlugins({ plugins: [{ name: "vibe", components: [{ kind: "skill", name: "s" }] }] }, "plugins");
  assert.equal(plugins[0].name, "vibe");
  const components = componentsFromInfo({ info: { components: [{ kind: "skill", name: "a", sourcePath: "p", config: { x: 1 } }] } });
  assert.equal(components[0].name, "a");
  const fields = fieldsFromConfig({ targets: ["user-toml"], fields: [{ name: "mcp_servers", layerValues: [{ layer: "user-toml", value: [] }] }] });
  assert.deepEqual(fields.targets, ["user-toml"]);
  assert.equal(fields.fields[0].name, "mcp_servers");
});

test("capability states distinguish configured/enabled/connected/usable", () => {
  assert.equal(capabilityOf({ name: "a", status: "connected", tools: [{ name: "t" }] }).usable.includes("usable"), true);
  assert.equal(capabilityOf({ name: "a", status: "disabled", tools: [] }).usable, "disabled");
  assert.equal(capabilityOf({ name: "a", status: "needs_auth", tools: [] }).usable, "awaits authentication");
  assert.equal(capabilityOf({ name: "a", status: "connected", tools: [] }).usable.includes("connected"), true);
  assert.equal(capabilityOf({ name: "a", status: "weird", tools: [{ name: "t" }] }).usable.includes("not verified"), true);
});

test("status labels never rely on color alone", () => {
  assert.equal(statusLabel("connected"), "Connected");
  assert.equal(statusLabel("needs_auth"), "Awaiting auth");
  assert.equal(statusLabel("disabled"), "Disabled");
  assert.equal(statusLabel("bogus"), "Unknown");
});

test("error redaction removes tokens and URLs", () => {
  const message = getErrorMessage(new Error("Bearer abc123 failed at https://example.com/secret?x=1"));
  assert.equal(message.includes("abc123"), false);
  assert.equal(message.includes("example.com/secret"), false);
});
