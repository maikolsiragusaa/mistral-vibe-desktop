import { test, expect, _electron, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The M2.1 worktree/preview coverage adds minutes of real interaction
// (creation, removal gate, isolated window, redirect block) on top of the
// M1 flow; loaded CI runners need headroom below the 45-minute job cap.
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

function runGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

async function startProvider(
  scenario: "text" | "write-file" | "subagent",
  options: { delaySeconds?: number; writePath?: string } = {},
): Promise<{ process: ChildProcess; url: string }> {
  const child = spawn(python, [path.join(repo, "scripts/test-provider.py")], {
    cwd: repo,
    env: {
      ...process.env,
      TEST_PROVIDER_TOOL_SCENARIO: scenario === "write-file" ? "1" : "0",
      TEST_PROVIDER_SUBAGENT_SCENARIO: scenario === "subagent" ? "1" : "0",
      TEST_PROVIDER_REASONING_SCENARIO: scenario === "text" ? "1" : "0",
      TEST_PROVIDER_DELAY_SECONDS: String(options.delaySeconds ?? 1.25),
      ...(options.writePath
        ? { TEST_PROVIDER_WRITE_PATH: options.writePath }
        : {}),
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });

  const url = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("The loopback Vibe test provider did not start"));
    }, 10_000);
    child.stdout!.on("data", (chunk) => {
      output += chunk.toString();
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(output.slice(0, newline)).url as string);
      } catch {
        reject(
          new Error(
            "The loopback Vibe test provider returned invalid startup data",
          ),
        );
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `The loopback Vibe test provider exited (${code ?? "unknown"})`,
        ),
      );
    });
  });
  return { process: child, url };
}

async function providerRequestCount(url: string): Promise<number> {
  const response = await fetch(`${url.replace(/\/v1\/?$/, "")}/health`);
  if (!response.ok) throw new Error("The local provider health check failed");
  const body = (await response.json()) as { requests?: unknown };
  return typeof body.requests === "number" ? body.requests : 0;
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
    path: path.join(directory, `desktop-expansion-${name}.png`),
  });
}

function directBackendProcessId(mainProcessId: number): number {
  const escapedBackend = path.resolve(backend).replace(/'/g, "''");
  const script = [
    `$expected='${escapedBackend}'`,
    `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${mainProcessId}' | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $expected } | Select-Object -ExpandProperty ProcessId | ConvertTo-Json -Compress`,
  ].join("; ");
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  ).trim();
  if (!output)
    throw new Error("The packaged Vibe app-server child was not found");
  const parsed = JSON.parse(output) as number | number[];
  const processId = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!Number.isInteger(processId))
    throw new Error("The Vibe app-server process id was invalid");
  return processId;
}

type ProcessSample = {
  Id: number;
  ProcessName: string;
  CPU: number | null;
  WorkingSet64: number;
};

function sampleProcesses(mainProcessId: number): ProcessSample[] {
  if (!Number.isInteger(mainProcessId))
    throw new Error("Invalid process owner");
  const script = `$rows = @(Get-CimInstance Win32_Process); $owned = [System.Collections.Generic.HashSet[int]]::new(); [void]$owned.Add(${mainProcessId}); do { $added = $false; foreach ($row in $rows) { if ($owned.Contains([int]$row.ParentProcessId) -and $owned.Add([int]$row.ProcessId)) { $added = $true } } } while ($added); Get-Process -Id @($owned) -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,CPU,WorkingSet64 | ConvertTo-Json -Compress`;
  // WMI sampling flakes occasionally under load: one delayed retry keeps a
  // green run green without masking real leaks (the shutdown poll below still
  // verifies every owned process exits).
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const output = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", windowsHide: true },
      ).trim();
      if (!output) return [];
      const parsed = JSON.parse(output) as ProcessSample | ProcessSample[];
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (error) {
      lastError = error;
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 10"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: "ignore",
      });
    }
  }
  throw lastError;
}

function totalWorkingSet(samples: ProcessSample[]): number {
  return samples.reduce((total, item) => total + item.WorkingSet64, 0);
}

function totalCpuSeconds(samples: ProcessSample[]): number {
  return samples.reduce((total, item) => total + (item.CPU ?? 0), 0);
}

test("real desktop keeps Git, configured models, approvals and sessions grounded in Vibe", async () => {
  // Use the same canonical root that the native project picker authorizes.
  // Windows CI exposes TEMP through short names; the loopback provider must
  // return paths under the selected project rather than that filesystem alias.
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "vibe-desktop-expansion-")),
  );
  const userData = path.join(root, "app-data");
  const vibeHome = path.join(root, "vibe-home");
  const workspace = path.join(root, "a local git project");
  const writtenByAgent = path.join(workspace, "agent-created.txt");
  await Promise.all([
    fs.mkdir(userData),
    fs.mkdir(vibeHome),
    fs.mkdir(path.join(workspace, ".vibe"), { recursive: true }),
  ]);
  await fs.mkdir(path.join(vibeHome, "skills/desktop-check"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(vibeHome, "skills/desktop-check/SKILL.md"),
    "---\nname: desktop-check\ndescription: Inspect a disposable desktop fixture.\n---\nRead the fixture and report what you observed.\n",
  );

  let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  let plainProvider: ChildProcess | undefined;
  let toolProvider: ChildProcess | undefined;
  let subagentProvider: ChildProcess | undefined;
  let mcpProcess: ChildProcess | undefined;
  let previewServer: Server | undefined;
  let page: Page | undefined;
  const pageErrors: string[] = [];
  try {
    runGit(workspace, "init", "--quiet", "--initial-branch=main");
    runGit(workspace, "config", "user.name", "Vibe Expansion Test");
    runGit(workspace, "config", "user.email", "vibe-expansion@example.invalid");
    await fs.writeFile(
      path.join(workspace, ".vibe/config.toml"),
      'active_model = "glm-5.2"\n[[mcp_servers]]\nname = "desktop-fixture"\ntransport = "stdio"\ncommand = ' +
        tomlString(python) +
        "\nargs = [" +
        tomlString(path.join(repo, "scripts/test-mcp.py")) +
        "]\n",
    );
    await fs.writeFile(
      path.join(workspace, "README.md"),
      "Initial version for the local desktop fixture.\n",
    );
    runGit(workspace, "add", ".");
    runGit(workspace, "commit", "--quiet", "-m", "Initial local fixture");
    await fs.writeFile(
      path.join(workspace, "README.md"),
      "Initial version for the local desktop fixture.\nA pre-existing local edit.\n",
    );
    await fs.writeFile(
      path.join(workspace, "notes with spaces.txt"),
      "An untracked file with spaces in its name.\n",
    );

    const plain = await startProvider("text", { delaySeconds: 10 });
    plainProvider = plain.process;
    const tools = await startProvider("write-file", {
      delaySeconds: 1.5,
      writePath: writtenByAgent,
    });
    toolProvider = tools.process;
    const agents = await startProvider("subagent", { delaySeconds: 2 });
    subagentProvider = agents.process;
    mcpProcess = spawn(
      python,
      [path.join(repo, "scripts/test-mcp.py"), "--http"],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const mcpUrl = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error("MCP fixture startup failed")),
        10000,
      );
      mcpProcess!.stdout!.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("\n")) {
          clearTimeout(timer);
          resolve(JSON.parse(output.split("\n")[0]).url);
        }
      });
      mcpProcess!.once("error", reject);
    });
    await fs.writeFile(
      path.join(workspace, ".vibe/config.toml"),
      'active_model = "glm-5.2"\n[[mcp_servers]]\nname="desktop-fixture"\ntransport="streamable-http"\nurl=' +
        tomlString(mcpUrl) +
        "\n",
    );

    const config = [
      "enable_telemetry = false",
      "enable_update_checks = false",
      "enable_connectors = false",
      "include_project_context = false",
      'active_model = "glm-5.2"',
      "",
      "[[providers]]",
      'name = "mistral"',
      `api_base = ${tomlString(plain.url)}`,
      'api_key_env_var = "VIBE_TEST_KEY"',
      "[[providers]]",
      'name = "fixture"',
      `api_base = ${tomlString(plain.url)}`,
      'api_key_env_var = "VIBE_TEST_KEY"',
      "",
      "[[providers]]",
      'name = "fixture-tools"',
      `api_base = ${tomlString(tools.url)}`,
      'api_key_env_var = "VIBE_TEST_KEY"',
      "",
      "[[models]]",
      'name = "glm-5.2"',
      'alias = "glm-5.2"',
      'display_name = "GLM 5.2"',
      'provider = "fixture"',
      "supports_images = true",
      'thinking = "low"',
      'thinking_levels = ["off", "low", "high"]',
      "max_context_length = 200000",
      "",
      "[[providers]]",
      'name = "fixture-agents"',
      `api_base = ${tomlString(agents.url)}`,
      'api_key_env_var = "VIBE_TEST_KEY"',
      "[[models]]",
      'name = "local-agent-model"',
      'alias = "local-agent-model"',
      'display_name = "Local agents"',
      'provider = "fixture-agents"',
      'thinking = "off"',
      "[[models]]",
      'name = "glm-5.3"',
      'alias = "glm-5.3"',
      'display_name = "GLM 5.3"',
      'provider = "fixture-tools"',
      'thinking = "low"',
      'thinking_levels = ["off", "low", "high"]',
      "max_context_length = 200000",
      "",
    ].join("\n");
    await fs.writeFile(path.join(vibeHome, "config.toml"), config);

    const launchStarted = performance.now();
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
    page = await desktop.firstWindow();
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
      console.log("PAGE ERROR", error.message);
    });
    page.on("console", (message) => {
      if (message.type() === "error")
        console.log("RENDERER ERROR", message.text());
    });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(
      page.getByText("Make room for good code.", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".engine-status")).toContainText("2.26.1", {
      timeout: 30_000,
    });
    const coldStartupMs = Math.round(performance.now() - launchStarted);
    console.log(
      `[vibe-perf] packagedOrInstalledColdStartupMs=${coldStartupMs}`,
    );
    await capture(page, "home-empty");
    await expect(page.locator(".context-panel")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Chat", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Toggle context panel" }).click();
    await expect(page.locator(".context-panel")).toBeVisible();
    await page
      .getByRole("button", { name: "Collapse project sidebar" })
      .click();
    await expect(page.locator(".rail")).toBeHidden();
    const leftEdge = page.getByRole("separator", {
      name: "Resize project sidebar",
    });
    // Wait for a stable, visible handle before sampling its box: the known
    // sidebar-drag flake races pointer setup against layout, so assert state
    // first instead of inflating timeouts.
    await expect(leftEdge).toBeVisible();
    let edge = (await leftEdge.boundingBox())!;
    await page.mouse.move(edge.x + 3, edge.y + 120);
    await page.mouse.down();
    await page.mouse.move(260, edge.y + 120, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator(".rail")).toBeVisible();
    await expect(leftEdge).toHaveAttribute("aria-valuenow", /2\d\d/);
    const rightEdge = page.getByRole("separator", {
      name: "Resize context sidebar",
    });
    await expect(rightEdge).toBeVisible();
    edge = (await rightEdge.boundingBox())!;
    const clientWidth = await page.evaluate(() => innerWidth);
    await page.mouse.move(edge.x + 3, edge.y + 120);
    await page.mouse.down();
    await page.mouse.move(clientWidth - 2, edge.y + 120, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator(".context-panel")).toHaveCount(0);
    edge = (await rightEdge.boundingBox())!;
    await page.mouse.move(edge.x + 3, edge.y + 120);
    await page.mouse.down();
    await page.mouse.move(clientWidth - 290, edge.y + 120, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator(".context-panel")).toBeVisible();
    await page
      .getByRole("button", { name: "Collapse project sidebar" })
      .click();
    await page.getByRole("button", { name: "Expand project sidebar" }).click();
    await expect(page.locator(".rail")).toBeVisible();

    const security = await desktop.evaluate(({ BrowserWindow }) => {
      const nativeWindow = BrowserWindow.getAllWindows()[0];
      const preferences = nativeWindow.webContents.getLastWebPreferences();
      return {
        sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
        mainPid: process.pid,
        rendererPid: nativeWindow.webContents.getOSProcessId(),
      };
    });
    expect(security).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    const idleBefore = sampleProcesses(security.mainPid);
    const idleStarted = performance.now();
    await page.waitForTimeout(5_000);
    const idleAfter = sampleProcesses(security.mainPid);
    const idleSeconds = (performance.now() - idleStarted) / 1000;
    const idleCpuPct =
      ((totalCpuSeconds(idleAfter) - totalCpuSeconds(idleBefore)) /
        idleSeconds) *
      100;
    const workingSetMb = totalWorkingSet(idleAfter) / (1024 * 1024);
    expect(idleAfter.length).toBeGreaterThan(0);
    expect(Number.isFinite(idleCpuPct)).toBe(true);
    expect(Number.isFinite(workingSetMb)).toBe(true);
    console.log(
      `[vibe-perf] ownedProcesses=${idleAfter.length} workingSetMb=${workingSetMb.toFixed(1)} idleCpuPct=${idleCpuPct.toFixed(2)} intervalSeconds=${idleSeconds.toFixed(2)}`,
    );
    const launchMode = packagedDesktop
      ? "packaged"
      : process.env.VIBE_TEST_SERVER
        ? "frozen"
        : "installed";
    await fs.mkdir(path.join(repo, "docs/performance"), { recursive: true });
    await fs.writeFile(
      path.join(repo, "docs/performance", `${launchMode}.json`),
      JSON.stringify(
        {
          launchMode,
          measuredAt: new Date().toISOString(),
          coldStartupMs,
          workingSetMiB: Number(workingSetMb.toFixed(1)),
          idleCpuPercentOfOneCore: Number(idleCpuPct.toFixed(2)),
          sampleIntervalSeconds: Number(idleSeconds.toFixed(2)),
          scope:
            "Main Electron process and all recursive descendants, including renderer, GPU, utility and Vibe runtime children. Working sets can include shared pages.",
          processes: idleAfter.map(({ ProcessName, WorkingSet64 }) => ({
            name: ProcessName,
            workingSetMiB: Number((WorkingSet64 / 1048576).toFixed(1)),
          })),
        },
        null,
        2,
      ) + "\n",
    );

    // The native titlebar overlay must keep usable Windows window controls.
    const overlay = await page.evaluate(() => {
      const overlay = (navigator as any).windowControlsOverlay;
      return {
        visible: overlay?.visible,
        height: overlay?.getTitlebarAreaRect().height,
      };
    });
    expect(overlay.visible).toBe(true);
    expect(overlay.height).toBeGreaterThan(0);
    const safeTitlebar = await page.locator(".titlebar-safe").boundingBox();
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    expect(safeTitlebar).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(safeTitlebar!.x + safeTitlebar!.width).toBeLessThanOrEqual(
      viewport!.width - 96,
    );
    const windowControls = await desktop.evaluate(({ BrowserWindow }) => {
      const nativeWindow = BrowserWindow.getAllWindows()[0];
      nativeWindow.maximize();
      const maximized = nativeWindow.isMaximized();
      nativeWindow.unmaximize();
      const restored = !nativeWindow.isMaximized();
      nativeWindow.minimize();
      const minimized = nativeWindow.isMinimized();
      nativeWindow.restore();
      return { maximized, restored, minimized };
    });
    expect(windowControls).toEqual({
      maximized: true,
      restored: true,
      minimized: true,
    });
    await expect(page.locator(".rail")).toBeVisible();

    await page.keyboard.press("Control+k");
    const commandDialog = page.getByRole("dialog", {
      name: "Command palette",
    });
    await expect(commandDialog).toBeVisible();
    await expect(commandDialog.getByLabel("Search commands")).toBeFocused();
    await commandDialog.getByLabel("Search commands").fill("Git workspace");
    await expect(commandDialog).toContainText("Git workspace");
    await page.keyboard.press("Escape");
    await expect(commandDialog).toHaveCount(0);

    await page.keyboard.press("Control+k");
    await page
      .getByRole("dialog", { name: "Command palette" })
      .getByLabel("Search commands")
      .fill("Open project");
    await page.keyboard.press("Enter");
    await expect(
      page.getByText("Review this project's Vibe configuration"),
    ).toBeVisible({ timeout: 30_000 });
    await page
      .getByRole("button", { name: "Trust this project", exact: true })
      .click();
    await expect(page.getByLabel("Prompt", { exact: true })).toBeEnabled({
      timeout: 30_000,
    });
    await expect(page.locator(".breadcrumbs")).toContainText(
      "a local git project",
    );
    await capture(page, "home-with-project");
    await expect(page.locator(".desktop-titlebar")).not.toContainText("Ready");
    await page.getByRole("button", { name: "MCP status", exact: true }).click();
    const mcpStatus = page.getByRole("dialog", { name: "MCP status details" });
    await expect(mcpStatus).toContainText("desktop-fixture");
    await capture(page, "mcp-status");
    await mcpStatus.getByRole("button", { name: "Manage MCP" }).click();
    await expect(
      page.getByRole("dialog", { name: "Workspace management", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Close workspace management" })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Workspace management", exact: true }),
    ).toHaveCount(0);

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settingsDialog = page.getByRole("dialog", { name: "Settings" });
    await expect(settingsDialog).toBeVisible();
    await settingsDialog.getByLabel("Pixel companion").uncheck();
    await settingsDialog.getByLabel("Decorative motion").uncheck();
    await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
    await expect(page.locator(".pixel-companion")).toHaveCount(0);
    await capture(page, "appearance-settings");
    const storedAppearance = await page.evaluate(async () =>
      (window as any).vibe.readPreferences(),
    );
    expect(storedAppearance).toMatchObject({ mascot: false, motion: false });
    await settingsDialog.getByLabel("Pixel companion").check();
    await settingsDialog.getByLabel("Decorative motion").check();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator(".pixel-companion")).toHaveCount(2);
    await expect(page.locator("html")).toHaveAttribute("data-motion", "on");

    const initialSessionId = await page
      .locator(".workspace")
      .getAttribute("data-session-id");
    expect(initialSessionId).toBeTruthy();
    await page.getByRole("button", { name: /^Reasoning level:/ }).click();
    const reasoningMenu = page.getByRole("menu", {
      name: "Choose reasoning level",
    });
    await expect(reasoningMenu).toContainText("Thinking effort");
    await capture(page, "reasoning-picker");
    await reasoningMenu
      .getByRole("menuitemradio", { name: "High", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Reasoning level: High", exact: true }),
    ).toBeEnabled();
    await capture(page, "reasoning-level");
    await page
      .getByLabel("Prompt", { exact: true })
      .fill("Reply with the local fixture response.");
    await page
      .getByRole("button", { name: "Send prompt", exact: true })
      .click();
    await expect(page.locator(".activity-status")).toContainText("Thinking");
    await expect(
      page.getByRole("button", { name: /^Reasoning level:/ }),
    ).toBeDisabled();
    await capture(page, "thinking-active");
    await expect(page.locator(".message.assistant").last()).toContainText(
      "Local fixture response.",
      { timeout: 30_000 },
    );
    expect(await providerRequestCount(plain.url)).toBeGreaterThan(0);
    const reasoning = page.locator(".reasoning").last();
    await expect(reasoning).toBeVisible();
    await reasoning.locator("summary").click();
    await expect(reasoning).toContainText("Local fixture reasoning");
    await capture(page, "reasoning");
    await expect(
      page.getByRole("button", { name: "Send prompt", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Context and token usage", exact: true })
      .click();
    const usage = page.getByRole("dialog", {
      name: "Context and token usage details",
    });
    await expect(usage).toContainText("132");
    await expect(usage).toContainText("120");
    await expect(usage).toContainText("12");
    await expect(usage).not.toContainText("t/s");
    const contextAnchor = (await page
      .getByRole("button", { name: "Context and token usage", exact: true })
      .boundingBox())!;
    const contextPopup = (await usage.boundingBox())!;
    expect(contextPopup.width).toBeLessThan(400);
    expect(Math.abs(contextPopup.x - contextAnchor.x)).toBeLessThan(16);
    expect(contextPopup.y + contextPopup.height).toBeLessThanOrEqual(
      contextAnchor.y,
    );
    await expect(usage).not.toHaveAttribute("aria-modal", "true");
    await capture(page, "context-tokens");
    await page.getByRole("button", { name: "Close context usage" }).click();
    await expect(page.locator(".response-metrics")).toHaveCount(0);
    await expect(page.locator(".composer-meta")).not.toContainText("t/s");

    await page.getByRole("button", { name: "Resources", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "Workspace management", exact: true }),
    ).toBeVisible();
    const resources = page.getByRole("region", {
      name: "Vibe resources and configuration",
    });
    await expect(resources).toContainText("desktop-fixture", {
      timeout: 30_000,
    });
    await resources
      .getByRole("button", { name: "Refresh catalog", exact: true })
      .click();
    await expect(resources).toContainText("fixture_ping", { timeout: 30_000 });
    const mcpCard = resources
      .locator(".rw-card")
      .filter({ hasText: "desktop-fixture" });
    await capture(page, "mcp");
    await mcpCard
      .getByRole("button", { name: "Disable server", exact: true })
      .click();
    await expect(
      mcpCard.getByRole("button", { name: "Enable server", exact: true }),
    ).toBeVisible();
    await mcpCard
      .getByRole("button", { name: "Enable server", exact: true })
      .click();
    await resources
      .getByRole("button", { name: "Add HTTP server", exact: true })
      .click();
    const addServer = page.getByRole("dialog", { name: "Add HTTP server" });
    await addServer.getByLabel("Server URL").fill("https://127.0.0.1:9/mcp");
    await addServer.getByLabel(/Display name/).fill("Disposable HTTP fixture");
    await addServer
      .getByRole("button", { name: "Add server", exact: true })
      .click();
    await expect(resources).toContainText("Disposable_HTTP_fixture", {
      timeout: 30_000,
    });
    const httpCard = resources
      .locator(".rw-card")
      .filter({ hasText: "Disposable_HTTP_fixture" });
    await httpCard
      .getByRole("button", {
        name: "Remove Disposable_HTTP_fixture",
        exact: true,
      })
      .click();
    await page
      .getByRole("dialog", { name: /Remove/ })
      .getByRole("button", { name: "Remove server", exact: true })
      .click();
    await expect(httpCard).toHaveCount(0);
    await resources.getByRole("tab", { name: "Skills", exact: true }).click();
    await resources.getByLabel("Search skills").fill("desktop-check");
    await expect(resources).toContainText(
      "Inspect a disposable desktop fixture.",
    );
    await resources
      .getByRole("switch", { name: "Disable desktop-check", exact: true })
      .click();
    await expect(
      resources.getByRole("switch", {
        name: "Enable desktop-check",
        exact: true,
      }),
    ).toBeVisible();
    await resources
      .getByRole("switch", { name: "Enable desktop-check", exact: true })
      .click();
    await expect(
      resources.getByRole("switch", {
        name: "Disable desktop-check",
        exact: true,
      }),
    ).toBeVisible();
    await capture(page, "skills");
    await resources.getByRole("tab", { name: "Plugins", exact: true }).click();
    await resources
      .getByRole("button", { name: "Reload discovery", exact: true })
      .click();
    await expect(resources).toContainText("Plugin discovery reloaded");
    await capture(page, "plugins");
    await resources
      .getByRole("tab", { name: "Providers", exact: true })
      .click();
    await resources
      .getByRole("button", { name: "Add provider", exact: true })
      .click();
    const providerDialog = page.getByRole("dialog", {
      name: "Add provider",
      exact: true,
    });
    await providerDialog
      .getByLabel("Provider name", { exact: true })
      .fill("desktop-extra");
    await providerDialog
      .getByLabel("API base URL", { exact: true })
      .fill(plain.url);
    await providerDialog
      .getByRole("button", { name: "Save provider", exact: true })
      .click();
    await expect(providerDialog).toHaveCount(0);
    const extraProvider = resources
      .locator(".rw-card")
      .filter({ hasText: "desktop-extra" });
    await expect(extraProvider).toContainText(plain.url);
    await extraProvider.getByLabel(/Change API base/).fill(`${plain.url}/`);
    await extraProvider
      .getByRole("button", { name: "Save API base", exact: true })
      .click();
    await expect(extraProvider.locator(".rw-facts")).toContainText(
      `${plain.url}/`,
    );
    await resources
      .getByRole("button", { name: "Add model", exact: true })
      .click();
    const addModelDialog = page.getByRole("dialog", {
      name: "Add model",
      exact: true,
    });
    await addModelDialog
      .getByLabel("API model ID", { exact: true })
      .fill("fixture-custom-001");
    await addModelDialog
      .getByLabel("Vibe alias", { exact: true })
      .fill("desktop-secondary");
    await addModelDialog
      .getByLabel("Provider", { exact: true })
      .selectOption("fixture");
    await addModelDialog
      .getByRole("button", { name: "Save model", exact: true })
      .click();
    await expect(addModelDialog).toHaveCount(0);
    await expect(resources).toContainText("desktop-secondary");
    await capture(page, "providers");
    await resources
      .getByRole("tab", { name: "Diagnostics", exact: true })
      .click();
    await expect(resources).toContainText("132");
    await capture(page, "diagnostics");
    await resources
      .getByRole("tab", { name: "Quota & usage", exact: true })
      .click();
    await expect(resources).toContainText("does not expose numerical");
    await capture(page, "quota");
    await desktop.evaluate(({ BrowserWindow }) => {
      const original = BrowserWindow.prototype.loadURL;
      (globalThis as any).quotaLoadOriginal = original;
      BrowserWindow.prototype.loadURL = function (url, ...args) {
        if (url.startsWith("https://")) {
          (globalThis as any).quotaLoadedUrl = url;
          return Promise.resolve();
        }
        return original.call(this, url, ...args);
      };
    });
    try {
      await resources
        .locator(".rw-dashboard-grid article")
        .filter({ hasText: "Vibe quota" })
        .getByRole("button", { name: "Open", exact: true })
        .click();
      const quotaSecurity = await desktop.evaluate(
        async ({ BrowserWindow }) => {
          const quota = BrowserWindow.getAllWindows().find(
            (window) => !window.webContents.getLastWebPreferences().preload,
          )!;
          const prefs = quota.webContents.getLastWebPreferences();
          return {
            url: (globalThis as any).quotaLoadedUrl,
            sandbox: prefs.sandbox,
            isolated: prefs.contextIsolation,
            node: prefs.nodeIntegration,
            preload: prefs.preload || null,
          };
        },
      );
      expect(quotaSecurity).toEqual({
        url: "https://console.mistral.ai/codestral/cli",
        sandbox: true,
        isolated: true,
        node: false,
        preload: null,
      });
      await expect(
        page.evaluate(() =>
          (window as any).vibe.openQuotaDashboard("arbitrary"),
        ),
      ).rejects.toThrow(/Unsupported quota/);
    } finally {
      await desktop.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((window) => !window.webContents.getLastWebPreferences().preload)
          ?.close();
        BrowserWindow.prototype.loadURL = (globalThis as any).quotaLoadOriginal;
      });
    }
    await page
      .getByRole("button", { name: "Close workspace management", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Workspace management", exact: true }),
    ).toHaveCount(0);
    // Exercise two separate, substantial Vibe turns, switching sessions while
    // the first local model request is still running.
    const sourceFixture = Array.from(
      { length: 650 },
      (_, index) =>
        `export function fixtureLine${index}(value: number) { return value + ${index}; }`,
    ).join("\n");
    const firstLongTurn = `Review this local source for clarity:\n\n${sourceFixture}`;
    await page.getByLabel("Prompt", { exact: true }).fill(firstLongTurn);
    await page
      .getByRole("button", { name: "Send prompt", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Stop turn", exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Prompt", { exact: true })
      .fill("Remove this queued fixture prompt before it runs.");
    await page.getByRole("button", { name: "Steer", exact: true }).click();
    await page
      .getByRole("button", { name: "Queue prompt", exact: true })
      .click();
    const queue = page.getByRole("region", {
      name: "Prompt queue",
      exact: true,
    });
    await expect(queue).toContainText("Remove this queued fixture prompt");
    await queue.getByRole("button", { name: /^Remove queued prompt/ }).click();
    await expect(queue).toHaveCount(0);
    const firstLongSession = await page
      .locator(".workspace")
      .getAttribute("data-session-id");
    expect(firstLongSession).toBeTruthy();
    await page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await expect(page.locator(".workspace")).not.toHaveAttribute(
      "data-session-id",
      firstLongSession!,
    );
    await expect(page.getByLabel("Prompt", { exact: true })).toBeEnabled({
      timeout: 30_000,
    });
    const secondSession = await page
      .locator(".workspace")
      .getAttribute("data-session-id");
    expect(secondSession).toBeTruthy();
    const secondLongTurn = `Compare these fixture functions:\n\n${sourceFixture}`;
    await page.getByLabel("Prompt", { exact: true }).fill(secondLongTurn);
    await page
      .getByRole("button", { name: "Send prompt", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Stop turn", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".message.assistant").last()).toContainText(
      "Local fixture response.",
      { timeout: 30_000 },
    );
    await expect(
      page.locator(`.session-row[data-session-id="${firstLongSession}"]`),
    ).toBeVisible();
    await page
      .locator(`.session-row[data-session-id="${firstLongSession}"]`)
      .click();
    await expect(page.locator(".workspace")).toHaveAttribute(
      "data-session-id",
      firstLongSession!,
    );
    await expect(page.locator(".message.assistant").last()).toContainText(
      "Local fixture response.",
      { timeout: 30_000 },
    );
    expect(firstLongSession).not.toBe(secondSession);
    const secondShelf = page
      .locator(`.session-row[data-session-id="${secondSession}"]`)
      .locator("..");
    await secondShelf.getByRole("button", { name: /^Pin session/ }).click();
    await expect(
      secondShelf.getByRole("button", { name: /^Unpin session/ }),
    ).toBeVisible();
    await secondShelf.getByRole("button", { name: /^Archive session/ }).click();
    await expect(
      page.locator(`.session-row[data-session-id="${secondSession}"]`),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Show archive", exact: true })
      .click();
    await expect(secondShelf).toContainText("Archived");
    await secondShelf.getByRole("button", { name: /^Restore session/ }).click();
    await expect(secondShelf).not.toContainText("Archived");
    await page
      .getByRole("button", { name: "Hide archive", exact: true })
      .click();

    // A real config/model/write changes the official runtime but keeps this
    // session's history and turns intact. Both API ids only exist in fixture config.
    const modelButton = page.getByRole("button", { name: /^Model: GLM 5\.2$/ });
    await modelButton.click();
    const modelDialog = page.getByRole("menu", { name: "Choose a model" });
    await expect(modelDialog).toBeVisible();
    const searchModels = modelDialog.getByLabel("Search configured models");
    await expect(searchModels).toBeFocused();
    await capture(page, "models-configured");
    await searchModels.fill("glm-5.3");
    const modelOption = modelDialog.getByRole("menuitemradio", {
      name: /GLM 5\.3/,
    });
    await expect(modelOption).toBeVisible();
    await expect(modelOption).toContainText("fixture-tools");
    await searchModels.press("ArrowDown");
    await expect(modelOption).toBeFocused();
    await capture(page, "model-glm-5-3");
    await modelOption.click();
    await expect(modelDialog).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^Model: GLM 5\.3$/ }),
    ).toBeVisible();
    await expect(page.locator(".workspace")).toHaveAttribute(
      "data-session-id",
      firstLongSession!,
    );
    await expect(page.locator(".message.assistant").last()).toContainText(
      "Local fixture response.",
    );
    const selectedRuntime = await page.evaluate(async (sessionId) => {
      const bridge = (window as any).vibe;
      return bridge.request("runtime/read", { sessionId });
    }, firstLongSession);
    expect(selectedRuntime.runtime.config.activeModel).toMatchObject({
      alias: "glm-5.3",
      thinking: "high",
    });

    await page.getByRole("button", { name: /^Agent mode:/ }).click();
    const modeMenu = page.getByRole("menu", { name: "Choose agent mode" });
    await capture(page, "mode-picker");
    await page.keyboard.press("Escape");
    await expect(modeMenu).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^Agent mode:/ }),
    ).toBeFocused();
    await page.getByRole("button", { name: /^Agent mode:/ }).click();
    await modeMenu
      .getByRole("menuitemradio", { name: /^Ask before tools/ })
      .click();
    await expect(
      page.getByRole("button", { name: "Agent mode: Ask before tools" }),
    ).toBeEnabled();
    // The loopback provider asks the actual Vibe engine to call its file tool.
    // Keep the callback visible in the captured state before approving it.
    await page
      .getByLabel("Prompt", { exact: true })
      .fill("Create the isolated test file.");
    await page
      .getByRole("button", { name: "Send prompt", exact: true })
      .click();
    const approval = page.getByRole("region", {
      name: "Vibe needs your input",
    });
    await expect(approval).toBeVisible({ timeout: 30_000 });
    await expect(approval).toContainText("agent-created.txt");
    await capture(page, "approval-pending");
    const fileExistsBeforeApproval = await fs
      .access(writtenByAgent)
      .then(() => true)
      .catch(() => false);
    expect(fileExistsBeforeApproval).toBe(false);
    await approval
      .getByRole("button", { name: "Approve once", exact: true })
      .click();
    await expect
      .poll(() => fs.readFile(writtenByAgent, "utf8").catch(() => ""), {
        timeout: 30_000,
      })
      .toContain("Written by the isolated Vibe fixture.");
    await expect(page.locator(".message.assistant").last()).toContainText(
      "Fixture file written.",
      { timeout: 30_000 },
    );
    expect(await providerRequestCount(tools.url)).toBeGreaterThan(0);
    const toolCard = page
      .locator(".effect")
      .filter({ hasText: "file_system.write_file" });
    await toolCard.locator("summary").click();
    await expect(toolCard.locator(".effect-body")).toContainText(
      "agent-created.txt",
    );
    await capture(page, "tool-expanded");

    // The Git view reads the real local repository. Staging and commits happen
    // only in response to these buttons and do not erase working-tree content.
    await page.getByRole("button", { name: "Git", exact: true }).click();
    const gitWorkspace = page.getByRole("region", { name: "Git workspace" });
    await expect(gitWorkspace).toBeVisible();
    // The modular workspace renders every view after the refactor.
    // (Substring match: the Changes tab carries a live file-count badge.)
    for (const tabName of ["Changes", "Files", "History", "Worktrees", "Pull requests"]) {
      await expect(gitWorkspace.getByRole("tab", { name: tabName })).toBeVisible();
    }
    await expect(
      gitWorkspace.getByRole("tab", { name: /Changes/ }),
    ).toBeVisible();
    const agentRow = gitWorkspace.locator(".git-workspace__file").filter({
      hasText: "agent-created.txt",
    });
    await expect(agentRow).toBeVisible();
    await expect(agentRow).toContainText("Agent touched");
    const readmeRow = gitWorkspace.locator(".git-workspace__file").filter({
      hasText: "README.md",
    });
    await expect(readmeRow).toBeVisible();
    await expect(readmeRow).toContainText("Pre-existing");
    await readmeRow.getByRole("button", { name: /^README\.md/ }).click();
    const diffRegion = gitWorkspace.getByLabel("Unified diff");
    await expect(diffRegion).toContainText("A pre-existing local edit.");
    await capture(page, "git-diff");
    await gitWorkspace
      .getByRole("button", { name: "Stage README.md", exact: true })
      .click();
    // Selection survives the status refresh that follows every mutation.
    await expect(
      gitWorkspace.getByRole("button", { name: "Unstage README.md", exact: true }),
    ).toBeVisible();
    await expect(diffRegion).toContainText("A pre-existing local edit.");
    await gitWorkspace
      .getByRole("button", { name: "Unstage README.md", exact: true })
      .click();
    expect(
      await fs.readFile(path.join(workspace, "README.md"), "utf8"),
    ).toContain("A pre-existing local edit.");
    await gitWorkspace
      .getByRole("button", { name: "Stage README.md", exact: true })
      .click();
    const notesRow = gitWorkspace.locator(".git-workspace__file").filter({
      hasText: "notes with spaces.txt",
    });
    await expect(notesRow).toBeVisible();
    await notesRow
      .getByRole("button", { name: "Stage notes with spaces.txt", exact: true })
      .click();
    await notesRow
      .getByRole("button", {
        name: "Unstage notes with spaces.txt",
        exact: true,
      })
      .click();
    expect(
      await fs.readFile(path.join(workspace, "notes with spaces.txt"), "utf8"),
    ).toContain("untracked file");
    await notesRow
      .getByRole("button", { name: "Stage notes with spaces.txt", exact: true })
      .click();
    await gitWorkspace
      .getByLabel("Commit staged changes")
      .fill("Commit explicitly selected local changes");
    await gitWorkspace
      .getByRole("button", { name: "Commit staged files", exact: true })
      .click();
    await expect(gitWorkspace).toContainText(
      "Commit explicitly selected local changes",
    );
    await expect
      .poll(() => runGit(workspace, "log", "-1", "--format=%s"))
      .toBe("Commit explicitly selected local changes");
    expect(runGit(workspace, "status", "--porcelain")).toContain(
      "?? agent-created.txt",
    );
    await gitWorkspace
      .getByRole("tab", { name: "History", exact: true })
      .click();
    await expect(gitWorkspace).toContainText(
      "Commit explicitly selected local changes",
    );
    await gitWorkspace
      .getByRole("tab", { name: "Worktrees", exact: true })
      .click();
    // The worktree manager shows real checkout state and safe-only actions,
    // not the old read-only note.
    await expect(gitWorkspace.getByRole("heading", { name: "Worktrees" })).toBeVisible();
    await expect(gitWorkspace).toContainText("main");
    await expect(gitWorkspace).toContainText(workspace);
    await expect(gitWorkspace).toContainText("Current");
    await expect(
      gitWorkspace.getByRole("button", { name: "New worktree", exact: true }),
    ).toBeVisible();
    await expect(
      gitWorkspace.getByRole("button", { name: "Prune stale", exact: true }),
    ).toBeVisible();
    await expect(gitWorkspace).toContainText("safe-only");
    await capture(page, "worktrees");

    // Creating a worktree from the UI must not contaminate the main checkout:
    // no new debris in Changes and no HEAD move.
    const headBeforeWorktree = runGit(workspace, "rev-parse", "HEAD");
    await gitWorkspace
      .getByRole("button", { name: "New worktree", exact: true })
      .click();
    await gitWorkspace.getByLabel("New branch worktree").fill("ui-created-branch");
    await gitWorkspace
      .getByRole("button", { name: "Create", exact: true })
      .click();
    await expect(gitWorkspace).toContainText("ui-created-branch");
    await expect(gitWorkspace).toContainText("app-managed space");
    expect(runGit(workspace, "rev-parse", "HEAD")).toBe(headBeforeWorktree);
    const createdBlock = runGit(workspace, "worktree", "list", "--porcelain")
      .split("\n\n")
      .find((block) => block.includes("branch refs/heads/ui-created-branch"));
    const createdPath = createdBlock
      ?.split("\n")
      .find((line) => line.startsWith("worktree "))
      ?.slice("worktree ".length);
    expect(createdPath).toBeTruthy();
    const mainStatusAfterCreate = runGit(workspace, "status", "--porcelain")
      .split("\n")
      .filter(Boolean);
    expect(mainStatusAfterCreate.some((line) => line.includes(".worktrees"))).toBe(false);

    // A dirty worktree cannot be removed: the safe-only gate refuses with a
    // reason and the checkout survives.
    await fs.writeFile(
      path.join(createdPath!, "README.md"),
      "Initial version for the local desktop fixture.\nA UI dirty change.\n",
    );
    // The manager lists snapshots: refresh to observe the external edit.
    await gitWorkspace.getByRole("button", { name: "Refresh worktrees", exact: true }).click();
    const createdRow = gitWorkspace
      .locator(".git-workspace__worktree-item")
      .filter({ hasText: "ui-created-branch" });
    await expect(createdRow).toContainText("Dirty", { timeout: 30_000 });
    page.once("dialog", (dialog) => void dialog.accept());
    await createdRow.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(gitWorkspace).toContainText("uncommitted changes", { timeout: 30_000 });
    expect(runGit(workspace, "worktree", "list", "--porcelain")).toContain(
      "ui-created-branch",
    );
    await capture(page, "worktree-blocked");
    await gitWorkspace.getByRole("tab", { name: "Files", exact: true }).click();
    await expect(gitWorkspace.getByRole("heading", { name: "Files" })).toBeVisible();
    const tree = gitWorkspace.getByLabel("Folder tree");
    await expect(tree).toContainText("README.md");
    await expect(gitWorkspace).toContainText("Modified");
    await tree.getByRole("button", { name: /README\.md/ }).first().click();
    await expect(gitWorkspace.getByLabel("File preview")).toContainText(
      "A pre-existing local edit.",
      { timeout: 30_000 },
    );
    await capture(page, "file-preview");

    // Local web previews open only for explicit loopback URLs, isolated from
    // the app: no preload bridge, no Node, no escape from the origin.
    previewServer = createServer((req, res) => {
      if (req.url === "/go") {
        res.writeHead(302, { Location: "https://example.com/" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><title>Fixture</title><h1>UI preview fixture marker</h1>");
    });
    await new Promise<void>((resolve) => previewServer!.listen(0, "127.0.0.1", resolve));
    const previewPort = (previewServer!.address() as { port: number }).port;
    const previewOrigin = `http://127.0.0.1:${previewPort}`;
    await gitWorkspace.getByLabel("Local preview URL").fill("https://example.com/");
    await expect(gitWorkspace).toContainText("Only http:// loopback origins can be previewed.");
    await gitWorkspace.getByLabel("Local preview URL").fill(`${previewOrigin}/`);
    await gitWorkspace.getByRole("button", { name: "Open preview", exact: true }).click();
    await expect(gitWorkspace).toContainText(`Previewing ${previewOrigin}/`, {
      timeout: 30_000,
    });
    // The isolated window commits its first navigation asynchronously.
    await expect
      .poll(
        async () =>
          desktop!.evaluate(
            ({ BrowserWindow }: any, origin: string) =>
              ((BrowserWindow.getAllWindows() as any[]).map(
                (win) => win.webContents.getURL() as string,
              ).find((url) => url.startsWith(origin)) as string) || "",
            previewOrigin,
          ),
        { timeout: 15_000 },
      )
      .toContain(previewOrigin);
    const isolation = await desktop!.evaluate(({ BrowserWindow }: any, origin: string) => {
      // The window title follows the loaded page; identify it by its URL.
      const preview = (BrowserWindow.getAllWindows() as any[]).find((win) =>
        (win.webContents.getURL() as string).startsWith(origin),
      );
      if (!preview) return { found: false as const };
      return (async () => ({
        found: true as const,
        url: preview.webContents.getURL() as string,
        vibe: (await preview.webContents.executeJavaScript("typeof window.vibe")) as string,
        nodeRequire: (await preview.webContents.executeJavaScript(
          "typeof window.require",
        )) as string,
      }))();
    }, previewOrigin);
    expect(isolation.found).toBe(true);
    if (isolation.found) {
      expect(isolation.url.startsWith(previewOrigin)).toBe(true);
      expect(isolation.vibe).toBe("undefined");
      expect(isolation.nodeRequire).toBe("undefined");
    }
    await capture(page, "web-preview");

    // A redirect to a public origin never leaves the app: it is blocked and
    // the preview window keeps a loopback or explanatory page instead.
    await gitWorkspace.getByLabel("Local preview URL").fill(`${previewOrigin}/go`);
    await gitWorkspace.getByRole("button", { name: "Open preview", exact: true }).click();
    await expect(gitWorkspace).toContainText(`Previewing ${previewOrigin}/go`, {
      timeout: 30_000,
    });
    await expect
      .poll(
        async () =>
          desktop!.evaluate(
            ({ BrowserWindow }: any, origin: string) => {
              const wins = (BrowserWindow.getAllWindows() as any[]).map(
                (win) => win.webContents.getURL() as string,
              );
              // The approved window either still shows the loopback page or
              // the explanatory block page — never the redirect target.
              const preview = wins.find(
                (url) => url.startsWith(origin) || url.startsWith("data:text/html"),
              );
              return preview || wins.join(" | ");
            },
            previewOrigin,
          ),
        { timeout: 15_000 },
      )
      .toMatch(/^data:text\/html/);
    await gitWorkspace.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(gitWorkspace.getByText(/Previewing/)).toHaveCount(0);

    await gitWorkspace
      .getByRole("tab", { name: "Pull requests", exact: true })
      .click();
    await expect(gitWorkspace).toContainText("No GitHub origin remote found");

    await page.getByRole("button", { name: "Git", exact: true }).click();
    await page.getByRole("button", { name: /^Model:/ }).click();
    const agentsPicker = page.getByRole("menu", { name: "Choose a model" });
    await agentsPicker
      .getByLabel("Search configured models")
      .fill("local-agent-model");
    await agentsPicker
      .getByRole("menuitemradio", { name: /Local agents/ })
      .click();
    await expect(agentsPicker).toHaveCount(0);
    await page
      .getByLabel("Prompt", { exact: true })
      .fill("Delegate a local fixture inspection to Explore.");
    await page
      .getByRole("button", { name: "Send prompt", exact: true })
      .click();
    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Inspect subagent", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await capture(page, "subagent-running");
    // Git navigation never touches sessions: opening the workspace mid-turn
    // leaves the running turn alone. Either the turn still runs (Inspect) or
    // it just completed (Send) — both prove navigation did not interrupt it.
    await page.getByRole("button", { name: "Git", exact: true }).click();
    await expect(page.getByRole("region", { name: "Git workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Git", exact: true }).click();
    await expect(
      page
        .getByRole("button", { name: "Inspect subagent", exact: true })
        .or(page.getByRole("button", { name: "Send prompt", exact: true })),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("button", { name: "Send prompt", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await page
      .getByRole("button", { name: "Inspect subagent", exact: true })
      .click();
    const childHistory = page.getByRole("dialog", { name: "Subagent history" });
    await expect(childHistory).toContainText(
      "Local subagent inspected the fixture.",
    );
    await capture(page, "subagent-history");
    await page
      .getByRole("button", { name: "Close subagent history", exact: true })
      .click();

    // Keep keyboard composition from sending a prompt and exercise a useful
    // validation error with a disposable unsupported attachment.
    const prompt = page.getByLabel("Prompt", { exact: true });
    await page.getByRole("button", { name: /^Model:/ }).click();
    const attachmentPicker = page.getByRole("menu", {
      name: "Choose a model",
    });
    await attachmentPicker
      .getByLabel("Search configured models")
      .fill("glm-5.2");
    await attachmentPicker
      .getByRole("menuitemradio", { name: /GLM 5\.2/ })
      .click();
    await expect(attachmentPicker).toHaveCount(0);
    await expect(prompt).toBeEnabled();
    const imageFile = {
      name: "pixel.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOmsAAAAASUVORK5CYII=",
        "base64",
      ),
    };
    await page
      .getByLabel("Attach files", { exact: true })
      .setInputFiles(imageFile);
    await expect(page.locator(".attachment-chip img")).toBeVisible();
    await page
      .getByRole("button", { name: "Remove attachment pixel.png", exact: true })
      .click();
    await expect(page.locator(".attachment-chip")).toHaveCount(0);
    await prompt.evaluate((element, base64) => {
      const data = new DataTransfer();
      data.items.add(
        new File(
          [Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))],
          "pasted-pixel.png",
          { type: "image/png" },
        ),
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true }),
      );
    }, imageFile.buffer.toString("base64"));
    await expect(page.locator(".attachment-chip")).toContainText(
      "pasted-pixel.png",
    );
    await prompt.evaluate((element) => {
      const data = new DataTransfer();
      data.items.add(
        new File(["A local text attachment."], "dropped.txt", {
          type: "text/plain",
        }),
      );
      element.dispatchEvent(
        new DragEvent("drop", { dataTransfer: data, bubbles: true }),
      );
    });
    await expect(page.locator(".attachment-chip")).toHaveCount(2);
    await capture(page, "attachments");
    await prompt.fill("Read these local attachments.");
    await page
      .getByRole("button", { name: "Send prompt", exact: true })
      .click();
    await expect(page.locator(".attachment-chip")).toHaveCount(0);
    await expect(page.locator(".message.assistant").last()).toContainText(
      "Local fixture response.",
      { timeout: 30000 },
    );
    await expect(prompt).toBeEnabled();
    await prompt.fill("Keep this draft during composition.");
    await prompt.evaluate((element) =>
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          isComposing: true,
        }),
      ),
    );
    await expect(prompt).toHaveValue("Keep this draft during composition.");
    const unsupportedFile = path.join(root, "unsupported.bin");
    await fs.writeFile(unsupportedFile, Buffer.from([0, 1, 2, 3]));
    await page
      .getByLabel("Attach files", { exact: true })
      .setInputFiles(unsupportedFile);
    await expect(page.locator(".error-banner")).toContainText(
      "Unsupported attachment",
    );
    await capture(page, "validation-error");
    await page
      .getByRole("button", { name: "Dismiss error", exact: true })
      .click();

    // Theme updates use the native window overlay as well as the renderer.
    await page
      .getByRole("button", { name: "Toggle theme", exact: true })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await capture(page, "dark");
    await page
      .getByRole("button", { name: "Toggle theme", exact: true })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await capture(page, "light");
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(920, 640),
    );
    await expect
      .poll(() =>
        page!.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await capture(page, "narrow");

    // A backend crash keeps the unsent composer draft available through the
    // app's real reconnect and session-resume path.
    const resumeSessionId = await page
      .locator(".workspace")
      .getAttribute("data-session-id");
    expect(resumeSessionId).toBeTruthy();
    const draftAfterRestart =
      "Keep this unsent draft after the engine restarts.";
    await prompt.fill(draftAfterRestart);
    const backendPidBeforeRestart = directBackendProcessId(security.mainPid);
    process.kill(backendPidBeforeRestart);
    await expect(prompt).toBeDisabled();
    await expect(page.locator(".notice")).toContainText(
      "Your draft is preserved",
    );
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("Connected · 2.26.1", {
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Close settings" }).click();
    await page
      .locator(`.session-row[data-session-id="${resumeSessionId}"]`)
      .click();
    await expect(prompt).toBeEnabled({ timeout: 30_000 });
    await expect(prompt).toHaveValue(draftAfterRestart);
    const persistedPreferences = await page.evaluate(async () =>
      (window as any).vibe.readPreferences(),
    );
    expect(persistedPreferences).toMatchObject({
      theme: "light",
      mascot: true,
      motion: true,
    });

    expect(pageErrors).toEqual([]);
    await expect(page.locator(".error-banner")).toHaveCount(0);
  } catch (error) {
    if (page) {
      const failure = path.join(repo, ".runtime/ui-expansion-failure.png");
      await page.screenshot({ path: failure }).catch(() => {});
      console.log(
        await page
          .locator("body")
          .innerText()
          .then((value) => value.slice(-6500))
          .catch(() => ""),
      );
    }
    throw error;
  } finally {
    if (desktop) {
      const owner = await desktop.evaluate(() => process.pid).catch(() => null);
      const ownedIds = owner
        ? sampleProcesses(owner).map((item) => item.Id)
        : [];
      await desktop.close();
      if (ownedIds.length)
        await expect
          .poll(
            () => {
              const script = `@(Get-Process -Id @(${ownedIds.join(",")}) -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) | ConvertTo-Json -Compress`;
              const output = execFileSync(
                "powershell.exe",
                ["-NoProfile", "-NonInteractive", "-Command", script],
                { encoding: "utf8", windowsHide: true },
              ).trim();
              return output ? JSON.parse(output) : [];
            },
            { timeout: 10000 },
          )
          .toEqual([]);
    }
    safeKill(toolProvider);
    safeKill(subagentProvider);
    safeKill(mcpProcess);
    safeKill(plainProvider);
    if (previewServer) {
      await new Promise<void>((resolve) => previewServer!.close(() => resolve()));
      previewServer = undefined;
    }
    if (
      path
        .resolve(root)
        .toLowerCase()
        .startsWith(
          `${(await fs.realpath(os.tmpdir())).toLowerCase()}${path.sep}`,
        )
    )
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 250,
      });
  }
});
