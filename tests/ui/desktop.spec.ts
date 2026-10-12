import { test, expect, _electron } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("real desktop connects, opens a local project, streams and resumes in both themes", async () => {
  const repo = process.cwd();
  const packagedDesktop = process.env.VIBE_TEST_DESKTOP;
  const python = path.join(repo, ".runtime/venv/Scripts/python.exe");
  const server =
    (packagedDesktop
      ? path.join(
          path.dirname(packagedDesktop),
          "resources/backend/vibe-app-server/vibe-app-server.exe",
        )
      : process.env.VIBE_TEST_SERVER) ||
    path.join(repo, ".runtime/venv/Scripts/vibe-app-server.exe");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-desktop-ui-"));
  const userData = path.join(root, "app-data");
  const vibeHome = path.join(root, "vibe-home");
  const workspace = path.join(root, "a-local-project");
  await Promise.all([
    fs.mkdir(userData),
    fs.mkdir(vibeHome),
    fs.mkdir(workspace),
  ]);
  await fs.mkdir(path.join(workspace, ".vibe"));
  await fs.writeFile(
    path.join(workspace, ".vibe/config.toml"),
    'active_model = "fixture-model"\n',
  );
  const provider = spawn(
    python,
    [path.join(repo, "scripts/test-provider.py")],
    { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  let desktop;
  try {
    const providerUrl = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error("Local provider did not start")),
        10_000,
      );
      provider.stdout!.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("\n")) {
          clearTimeout(timer);
          resolve(JSON.parse(output.split("\n")[0]).url);
        }
      });
      provider.on("error", reject);
    });
    await fs.writeFile(
      path.join(vibeHome, "config.toml"),
      `enable_telemetry = false\nenable_update_checks = false\ninclude_project_context = false\nactive_model = "fixture-model"\n[[providers]]\nname = "fixture"\napi_base = "${providerUrl}"\napi_key_env_var = "VIBE_TEST_KEY"\n[[models]]\nname = "fixture-model"\nalias = "fixture-model"\nprovider = "fixture"\nthinking = "off"\n`,
    );
    desktop = await _electron.launch({
      ...(packagedDesktop ? { executablePath: packagedDesktop } : {}),
      args: packagedDesktop ? [] : [repo],
      env: {
        ...process.env,
        VIBE_APP_SERVER: packagedDesktop ? "" : server,
        VIBE_HOME: vibeHome,
        VIBE_DESKTOP_USER_DATA: userData,
        VIBE_TEST_KEY: "local-test-only",
        MISTRAL_API_KEY: "",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
      timeout: 30_000,
    });
    await desktop.evaluate(({ dialog }, projectPath) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [projectPath],
      });
    }, workspace);
    const window = await desktop.firstWindow();
    const security = await desktop.evaluate(({ BrowserWindow }) => {
      const preferences =
        BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return {
        sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
        pid: process.pid,
      };
    });
    expect(security).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    const pageErrors: string[] = [];
    window.on("pageerror", (error) => pageErrors.push(error.message));
    await expect(
      window.getByText("Make room for good code.", { exact: true }),
    ).toBeVisible();
    await expect(window.locator(".engine-status")).toContainText("2.26.1", {
      timeout: 30_000,
    });
    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(window.getByRole("dialog")).toBeVisible();
    await expect(
      window.getByRole("button", { name: "Close settings" }),
    ).toBeFocused();
    await window.keyboard.press("Shift+Tab");
    expect(
      await window
        .getByRole("dialog")
        .evaluate((dialog) => dialog.contains(document.activeElement)),
    ).toBe(true);
    await window.keyboard.press("Tab");
    await expect(
      window.getByRole("button", { name: "Close settings" }),
    ).toBeFocused();
    await window.getByRole("button", { name: "light", exact: true }).click();
    await window.getByRole("button", { name: "Close settings" }).click();
    await fs.mkdir(path.join(repo, "docs/screenshots"), { recursive: true });
    await window.screenshot({
      path: path.join(repo, "docs/screenshots/desktop-light.png"),
    });
    await window.getByRole("button", { name: "Toggle theme" }).click();
    await expect(window.locator("html")).toHaveAttribute("data-theme", "dark");
    await window.screenshot({
      path: path.join(repo, "docs/screenshots/desktop-dark.png"),
    });
    await window.locator(".open-project").click();
    await expect(
      window.getByText("Review this project's Vibe configuration"),
    ).toBeVisible({ timeout: 30_000 });
    await expect(window.getByLabel("Prompt", { exact: true })).toBeDisabled();
    await window
      .getByRole("button", { name: "Trust this project", exact: true })
      .click();
    await expect(window.getByLabel("Prompt", { exact: true })).toBeEnabled({
      timeout: 30_000,
    });
    await expect(window.locator(".breadcrumbs")).toContainText(
      "a-local-project",
    );
    await window
      .getByLabel("Prompt", { exact: true })
      .fill("Reply with a short greeting.");
    await expect(window.getByLabel("Prompt", { exact: true })).toHaveValue(
      "Reply with a short greeting.",
    );
    await window
      .getByRole("button", { name: "Send prompt", exact: true })
      .click();
    await expect(window.locator(".message.assistant")).toContainText(
      "Local fixture response.",
      { timeout: 30_000 },
    );
    await expect(
      window.getByRole("button", { name: "Send prompt", exact: true }),
    ).toBeVisible();
    const resumedSessionId = await window
      .locator(".workspace")
      .getAttribute("data-session-id");
    expect(resumedSessionId).toBeTruthy();
    await window.screenshot({
      path: path.join(repo, "docs/screenshots/desktop-session.png"),
    });
    await window.getByRole("tab", { name: "Environment", exact: true }).click();
    await expect(window.locator(".context-panel")).toContainText(
      "Unified Harness",
    );
    await window.getByRole("tab", { name: "Changes", exact: true }).click();
    await expect(window.locator(".context-panel")).toContainText(
      "Change review is unavailable.",
    );
    await expect(window.locator(".error-banner")).toHaveCount(0);
    await window
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await expect(window.getByLabel("Prompt", { exact: true })).toBeEnabled({
      timeout: 30_000,
    });
    const savedSession = window.locator(
      `.session-row[data-session-id="${resumedSessionId}"]`,
    );
    await expect(savedSession).toBeVisible();
    await savedSession.click();
    await expect(window.locator(".message.assistant")).toContainText(
      "Local fixture response.",
      { timeout: 30_000 },
    );
    await window.getByRole("button", { name: "Toggle shell" }).click();
    await expect(window.getByLabel("Shell command")).toBeVisible();
    await window.getByLabel("Shell command").fill("echo VibeDesktopShellCheck");
    await window.getByLabel("Shell command").press("Enter");
    await expect(window.locator(".shell-output")).toContainText(
      "VibeDesktopShellCheck",
      { timeout: 30_000 },
    );
    // Kill only the app-server child owned by this disposable desktop instance.
    // Recovery must resume persisted history and retain the unsent draft.
    await window
      .getByLabel("Prompt", { exact: true })
      .fill("Keep this unsent draft.");
    const children = JSON.parse(
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${security.pid}' | Select-Object ProcessId, ExecutablePath | ConvertTo-Json -Compress`,
        ],
        { encoding: "utf8", windowsHide: true },
      ),
    );
    const servers = (Array.isArray(children) ? children : [children]).filter(
      (child) =>
        child.ExecutablePath?.toLowerCase() ===
        path.resolve(server).toLowerCase(),
    );
    expect(servers).toHaveLength(1);
    process.kill(servers[0].ProcessId);
    await expect(window.getByLabel("Prompt", { exact: true })).toBeDisabled();
    await expect(window.locator(".notice")).toContainText(
      "Your draft is preserved",
    );
    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await window
      .getByRole("button", { name: "Reconnect", exact: true })
      .click();
    await expect(window.getByRole("dialog")).toContainText(
      "Connected · 2.26.1",
      { timeout: 30_000 },
    );
    await window.getByRole("button", { name: "Close settings" }).click();
    await window
      .locator(`.session-row[data-session-id="${resumedSessionId}"]`)
      .click();
    await expect(window.getByLabel("Prompt", { exact: true })).toBeEnabled({
      timeout: 30_000,
    });
    await expect(window.getByLabel("Prompt", { exact: true })).toHaveValue(
      "Keep this unsent draft.",
    );
    await expect(window.locator(".message.assistant")).toContainText(
      "Local fixture response.",
    );
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(920, 640),
    );
    expect(
      await window.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(pageErrors).toEqual([]);
    const errors = await window.locator(".error-banner").count();
    expect(errors).toBe(0);
  } catch (error) {
    if (desktop) {
      const window = await desktop.firstWindow();
      await window.screenshot({
        path: path.join(repo, ".runtime/ui-failure.png"),
      });
      console.log(await window.locator("body").innerText());
    }
    throw error;
  } finally {
    if (desktop) await desktop.close();
    provider.kill();
    // Only remove the disposable, freshly created test directory.
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
      await fs.rm(root, { recursive: true, force: true });
  }
});
