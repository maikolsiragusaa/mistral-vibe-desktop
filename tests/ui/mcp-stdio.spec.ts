import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchDesktop } from "./launch-desktop";

// Real Electron coverage for the M4.1 MCP mutation path: the stdio dialog,
// the redacted environment editor, edit-with-preservation and two-step
// removal all run against the frozen backend in dev and packaged builds.
// No hosted models, no account, no external network.
test.setTimeout(480_000);

const repo = process.cwd();
const python = path.join(repo, ".runtime/venv/Scripts/python.exe");
const packagedDesktop = process.env.VIBE_TEST_DESKTOP;
const backend =
  (packagedDesktop
    ? path.join(
        path.dirname(packagedDesktop),
        "resources/backend/vibe-app-server/vibe-app-server.exe",
      )
    : process.env.VIBE_TEST_SERVER) ||
  path.join(repo, ".runtime/venv/Scripts/vibe-app-server.exe");

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function safeKill(child: ChildProcess | undefined): void {
  if (child && child.exitCode === null && child.signalCode === null)
    child.kill();
}

async function capture(page: Page, name: string): Promise<void> {
  const directory = path.join(repo, "docs/screenshots");
  await fs.mkdir(directory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: path.join(directory, `desktop-mcp-stdio-${name}.png`),
  });
}

test("real desktop manages a stdio MCP server without touching neighbors or secrets", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "vibe-desktop-mcp-stdio-")),
  );
  const userData = path.join(root, "app-data");
  const vibeHome = path.join(root, "vibe-home");
  // A workspace without .vibe needs no trust decision.
  const workspace = path.join(root, "stdio project");
  await Promise.all([
    fs.mkdir(userData),
    fs.mkdir(vibeHome),
    fs.mkdir(workspace, { recursive: true }),
  ]);

  let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  let provider: ChildProcess | undefined;
  try {
    const loopback = spawn(python, [path.join(repo, "scripts/test-provider.py")], {
      cwd: repo,
      env: {
        ...process.env,
        TEST_PROVIDER_REASONING_SCENARIO: "1",
        TEST_PROVIDER_DELAY_SECONDS: "10",
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    provider = loopback;
    const providerUrl = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("Loopback provider did not start")), 10_000);
      loopback.stdout!.on("data", (chunk) => {
        output += chunk.toString();
        const newline = output.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(output.slice(0, newline)).url as string);
        } catch {
          reject(new Error("Loopback provider returned invalid startup data"));
        }
      });
      loopback.once("error", reject);
    });

    await fs.writeFile(
      path.join(vibeHome, "config.toml"),
      [
        "enable_telemetry = false",
        "enable_update_checks = false",
        "enable_connectors = false",
        "include_project_context = false",
        'active_model = "fixture-model"',
        "[[providers]]",
        'name = "fixture"',
        `api_base = ${tomlString(providerUrl)}`,
        'api_key_env_var = "VIBE_TEST_KEY"',
        "[[models]]",
        'name = "fixture-model"',
        'alias = "fixture-model"',
        'provider = "fixture"',
        'thinking = "off"',
        "",
      ].join("\n"),
    );

    desktop = await launchDesktop({
      ...(packagedDesktop ? { executablePath: packagedDesktop } : {}),
      args: packagedDesktop
        ? [
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-background-timer-throttling",
          ]
        : [repo],
      env: {
        ...process.env,
        VIBE_APP_SERVER: packagedDesktop ? "" : backend,
        VIBE_HOME: vibeHome,
        VIBE_DESKTOP_USER_DATA: userData,
        VIBE_TEST_KEY: "local-fixture-key-only",
        MISTRAL_API_KEY: "",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
      timeout: 60_000,
    });
    await desktop.evaluate(({ dialog }, projectPath) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [projectPath],
      });
    }, workspace);
    const page = await desktop.firstWindow();
    page.on("pageerror", (error) => {
      console.log("PAGE ERROR", error.message);
    });
    page.on("console", (message) => {
      if (message.type() === "error")
        console.log("RENDERER ERROR", message.text());
    });
    await expect(
      page.getByText("Make room for good code.", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".engine-status")).toContainText("2.26.1", {
      timeout: 30_000,
    });
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await palette.getByLabel("Search commands").fill("Open project");
    await expect(palette).toContainText("Open project");
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Prompt", { exact: true })).toBeEnabled({
      timeout: 30_000,
    });

    await page.getByRole("button", { name: "Resources", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "Workspace management", exact: true }),
    ).toBeVisible();
    const resources = page.getByRole("region", {
      name: "Vibe resources and configuration",
    });
    await resources
      .getByRole("button", { name: "Add stdio server", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Add stdio server" });
    await expect(dialog).toBeVisible();
    await capture(page, "dialog");
    await dialog.getByLabel("Stdio server name").fill("mcp-stdio-check");
    await dialog.getByLabel("Stdio command").fill(python);
    await dialog
      .getByLabel("Stdio arguments")
      .fill(path.join(repo, "scripts/test-mcp.py"));
    await dialog.getByLabel("Tool timeout seconds").fill("45");
    await dialog.getByLabel("New variable name").fill("MCP_STDIO_FIXTURE_TOKEN");
    await dialog.getByLabel("New variable value").fill("fixture-secret-ui");
    await dialog
      .getByRole("button", { name: "Add variable", exact: true })
      .click();
    await expect(dialog).toContainText("new variable");
    await dialog.getByText("I understand this executes", { exact: false }).click();
    await dialog
      .getByRole("button", { name: "Add server", exact: true })
      .click();
    const card = resources
      .locator(".rw-stdio-list .rw-card")
      .filter({ hasText: "mcp-stdio-check" });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText("1 env var(s) configured");
    // The existing secret value must never be rendered, even as a field value.
    await expect(page.locator('input[value="fixture-secret-ui"]')).toHaveCount(0);
    await expect(page.getByText("fixture-secret-ui")).toHaveCount(0);
    await capture(page, "added");

    await card
      .getByRole("button", { name: "Edit stdio server", exact: true })
      .click();
    const editDialog = page.getByRole("dialog", { name: /Edit stdio server/ });
    await expect(editDialog).toBeVisible();
    // Redaction holds in edit mode: names are shown, values are not.
    await expect(editDialog).toContainText("MCP_STDIO_FIXTURE_TOKEN");
    await expect(editDialog).toContainText("configured");
    await expect(page.locator('input[value="fixture-secret-ui"]')).toHaveCount(0);
    await expect(page.getByText("fixture-secret-ui")).toHaveCount(0);
    // Change only the startup timeout; every other field stays as-is.
    await editDialog.getByLabel("Startup timeout seconds").fill("33");
    await editDialog.getByText("I understand this executes", { exact: false }).click();
    await editDialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(resources).toContainText("Updated mcp-stdio-check", {
      timeout: 30_000,
    });
    await capture(page, "edited");

    // The authoritative layer must show the edit while the secret survives
    // byte-for-byte (read through the bridge, never rendered).
    const sessionId = await page.locator(".workspace").getAttribute("data-session-id");
    const layer = await page.evaluate(async (sid) => {
      const bridge = (window as any).vibe;
      return bridge.request("config/fields/read", { sessionId: sid });
    }, sessionId);
    const values = layer.fields.find((field: any) => field.name === "mcp_servers")
      .layerValues[0].value;
    const entry = values.find((item: any) => item?.name === "mcp-stdio-check");
    expect(entry.startup_timeout_sec).toBe(33);
    expect(entry.tool_timeout_sec).toBe(45);
    expect(entry.command).toBe(python);
    expect(entry.env.MCP_STDIO_FIXTURE_TOKEN).toBe("fixture-secret-ui");

    await page.setViewportSize({ width: 900, height: 700 });
    await card
      .getByRole("button", { name: "Remove stdio server", exact: true })
      .click();
    await card
      .getByRole("button", { name: "Confirm remove", exact: true })
      .click();
    await expect(card).toHaveCount(0, { timeout: 30_000 });
    await capture(page, "removed-narrow");
  } finally {
    safeKill(provider);
    await desktop?.close();
  }
});
