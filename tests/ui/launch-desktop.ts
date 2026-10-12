import {
  _electron,
  chromium,
  type ElectronApplication,
} from "@playwright/test";
import { spawn } from "node:child_process";

type Desktop = Pick<ElectronApplication, "evaluate" | "firstWindow" | "close">;
type Options = NonNullable<Parameters<typeof _electron.launch>[0]>;

/** Launch packaged apps before attaching: Electron's initial custom-scheme
 * navigation can race Playwright's first-navigation listener during launch. */
export async function launchDesktop(options: Options): Promise<Desktop> {
  if (!options.executablePath) return _electron.launch(options);
  const child = spawn(
    options.executablePath,
    ["--inspect=0", "--remote-debugging-port=0", ...(options.args || [])],
    {
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let nodeUrl = "",
    chromeUrl = "",
    stderr = "";
  let resolveEndpoints!: () => void;
  let rejectEndpoints!: (error: Error) => void;
  const endpoints = new Promise<void>((resolve, reject) => {
    resolveEndpoints = resolve;
    rejectEndpoints = reject;
  });
  const endpointTimer = setTimeout(
    () =>
      rejectEndpoints(
        new Error("Packaged Electron debug endpoints did not start"),
      ),
    options.timeout || 60000,
  );
  child.on("error", rejectEndpoints);
  child.on("exit", () =>
    rejectEndpoints(new Error("Packaged Electron exited before attachment")),
  );
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
    nodeUrl ||= stderr.match(/Debugger listening on (ws:\/\/\S+)/)?.[1] || "";
    chromeUrl ||= stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1] || "";
    if (nodeUrl && chromeUrl) resolveEndpoints();
  });
  child.stdout.resume();
  let inspector: WebSocket | undefined;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    await endpoints;
    clearTimeout(endpointTimer);
    inspector = new WebSocket(nodeUrl);
    await new Promise<void>((resolve, reject) => {
      inspector!.addEventListener("open", () => resolve(), { once: true });
      inspector!.addEventListener(
        "error",
        () => reject(new Error("Node inspector connection failed")),
        { once: true },
      );
    });
    let nextId = 0;
    const pending = new Map<
      number,
      {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    inspector.addEventListener("message", (event) => {
      const response = JSON.parse(String(event.data));
      const call = pending.get(response.id);
      if (!call) return;
      clearTimeout(call.timer);
      pending.delete(response.id);
      if (response.error) call.reject(new Error(response.error.message));
      else call.resolve(response.result);
    });
    inspector.addEventListener("close", () => {
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error("Node inspector closed"));
      }
      pending.clear();
    });
    const send = (method: string, params: object): Promise<any> =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Inspector request timed out: ${method}`));
        }, 30000);
        pending.set(id, { resolve, reject, timer });
        inspector!.send(JSON.stringify({ id, method, params }));
      });
    const evaluate: Desktop["evaluate"] = async (
      callback: any,
      argument?: any,
    ) => {
      const expression = `(${callback.toString()})(require('electron'), ${JSON.stringify(argument) ?? "undefined"})`;
      const result = await send("Runtime.evaluate", {
        expression,
        includeCommandLineAPI: true,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description ||
            result.exceptionDetails.text,
        );
      return result.result.value;
    };
    await evaluate(async ({ app, BrowserWindow }) => {
      await app.whenReady();
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const contents = BrowserWindow.getAllWindows()[0]?.webContents;
        if (
          contents?.getURL() === "app://renderer/index.html" &&
          !contents.isLoadingMainFrame()
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(
        "Packaged renderer did not finish its initial navigation",
      );
    });
    browser = await chromium.connectOverCDP(chromeUrl, { timeout: 30000 });
    const context = browser.contexts()[0];
    return {
      evaluate,
      firstWindow: async () =>
        context
          .pages()
          .find((page) => page.url().startsWith("app://renderer/")) ||
        (await context.waitForEvent("page")),
      close: async () => {
        const exited = new Promise<void>((resolve) =>
          child.once("exit", () => resolve()),
        );
        await evaluate(({ app }) => app.quit()).catch(() => {});
        inspector!.close();
        const timer = setTimeout(() => child.kill(), 10000);
        await exited;
        clearTimeout(timer);
        await browser!.close();
      },
    };
  } catch (error) {
    clearTimeout(endpointTimer);
    inspector?.close();
    await browser?.close();
    child.kill();
    throw error;
  }
}
