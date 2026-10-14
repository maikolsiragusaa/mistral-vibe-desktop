import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

const MAX_PATH_LENGTH = 4096;

const KNOWN_EDITORS = [
  {
    id: "vscode",
    label: "Visual Studio Code",
    binaries: ["code.exe", "code"],
    knownPaths: [
      "C:\\Program Files\\Microsoft VS Code\\Code.exe",
      "C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe",
    ],
    localAppPaths: ["Programs\\Microsoft VS Code\\Code.exe"],
  },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    binaries: ["code-insiders.exe", "code-insiders"],
    knownPaths: [
      "C:\\Program Files\\Microsoft VS Code Insiders\\Code - Insiders.exe",
    ],
    localAppPaths: ["Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe"],
  },
  {
    id: "vscodium",
    label: "VSCodium",
    binaries: ["codium.exe", "codium"],
    knownPaths: ["C:\\Program Files\\VSCodium\\VSCodium.exe"],
    localAppPaths: ["Programs\\VSCodium\\VSCodium.exe"],
  },
  {
    id: "cursor",
    label: "Cursor",
    binaries: ["cursor.exe", "cursor"],
    knownPaths: [],
    localAppPaths: ["Programs\\Cursor\\Cursor.exe", "Programs\\cursor\\Cursor.exe"],
  },
];

function isAbsolutePath(value) {
  if (typeof value !== "string" || !value || value.length > MAX_PATH_LENGTH) return false;
  return (
    /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("/")
  );
}

function validateFolder(folder) {
  if (typeof folder !== "string" || !folder || folder.length > MAX_PATH_LENGTH || folder.includes("\0"))
    throw new TypeError("A workspace folder is required");
  if (!isAbsolutePath(folder)) throw new TypeError("Workspace folder must be absolute");
  if (folder.startsWith("\\\\")) throw new TypeError("UNC workspace folders cannot be opened here");
  if (folder.includes('"')) throw new TypeError("Workspace folder path is invalid");
  if (/[<>|?*\x00-\x1f]/.test(folder)) throw new TypeError("Workspace folder path is invalid");
}

function validateRelativeFile(file) {
  if (file == null) return null;
  if (typeof file !== "string" || !file) return null;
  if (file.length > MAX_PATH_LENGTH || file.includes("\0"))
    throw new TypeError("File path is invalid");
  const portable = file.replaceAll("\\", "/");
  if (
    portable.startsWith("/") ||
    /^[A-Za-z]:/.test(portable) ||
    portable.startsWith("//") ||
    portable.split("/").some((p) => p === "..")
  )
    throw new TypeError("File must stay inside the workspace");
  for (const piece of portable.split("/").filter(Boolean)) {
    if (piece.includes(":")) throw new TypeError("File must stay inside the workspace");
    const stripped = piece.replace(/[. ]+$/, "");
    if (!stripped || stripped.toLowerCase() === ".git")
      throw new TypeError("File must stay inside the workspace");
  }
  return file;
}

function validateLine(line) {
  if (line == null) return null;
  if (!Number.isInteger(line) || line < 1 || line > 1_000_000)
    throw new TypeError("Line number is invalid");
  return line;
}

function validateExePath(exePath) {
  if (typeof exePath !== "string" || !exePath || exePath.length > MAX_PATH_LENGTH || exePath.includes("\0"))
    throw new TypeError("Editor executable path is invalid");
  if (!isAbsolutePath(exePath)) throw new TypeError("Editor executable must be absolute");
  if (/[;&|`$"]/.test(exePath)) throw new TypeError("Editor executable path is invalid");
  if (/[\r\n]/.test(exePath)) throw new TypeError("Editor executable path is invalid");
  // Batch launchers are refused outright: Windows cannot start a .cmd/.bat
  // without cmd.exe's own parser, which expands %VAR% inside arguments even
  // when the parent spawns with shell:false (verified by real-process test).
  // A limited-but-safe .exe-only policy beats an apparently complete one.
  if (!exePath.toLowerCase().endsWith(".exe"))
    throw new TypeError(
      "Custom editors must be direct .exe executables; batch launchers are not supported",
    );
  return exePath;
}

export class EditorService {
  constructor({
    authorizeProjectRoot = null,
    statImpl = stat,
    spawnImpl = spawn,
    platform = process.platform,
    env = process.env,
  } = {}) {
    if (authorizeProjectRoot !== null && typeof authorizeProjectRoot !== "function")
      throw new TypeError("authorizeProjectRoot must be a function or null");
    this.authorizeProjectRoot = authorizeProjectRoot;
    this.statImpl = statImpl;
    this.spawnImpl = spawnImpl;
    this.platform = platform;
    this.env = env;
  }

  async #existsFile(candidate) {
    try {
      const details = await this.statImpl(candidate);
      return details.isFile();
    } catch {
      return false;
    }
  }

  #pathDirs() {
    const raw = this.env?.PATH ?? this.env?.Path ?? "";
    return String(raw)
      .split(";")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter(Boolean)
      .slice(0, 64);
  }

  async #resolveInPath(binaryNames) {
    // PATH lookup without a shell: join each dir + binary and stat.
    for (const dir of this.#pathDirs()) {
      if (!isAbsolutePath(dir)) continue;
      for (const bin of binaryNames) {
        const candidate = path.join(dir, bin);
        if (candidate.length > MAX_PATH_LENGTH) continue;
        if (await this.#existsFile(candidate)) return candidate;
      }
    }
    return null;
  }

  async detect() {
    const results = [];
    const localAppData =
      this.env?.LOCALAPPDATA ?? this.env?.LocalAppData ?? null;
    for (const editor of KNOWN_EDITORS) {
      let exePath = null;
      for (const known of editor.knownPaths) {
        if (await this.#existsFile(known)) {
          exePath = known;
          break;
        }
      }
      if (!exePath && typeof localAppData === "string" && localAppData) {
        for (const rel of editor.localAppPaths) {
          const candidate = path.join(localAppData, rel);
          if (await this.#existsFile(candidate)) {
            exePath = candidate;
            break;
          }
        }
      }
      if (!exePath) exePath = await this.#resolveInPath(editor.binaries);
      results.push({
        id: editor.id,
        label: editor.label,
        exePath,
        verified: exePath !== null,
      });
    }
    return results;
  }

  async detectAcp() {
    // Official vibe-acp presence (editor integration), never launched here.
    const found = await this.#resolveInPath(["vibe-acp.exe", "vibe-acp"]);
    return { found: found !== null, exePath: found };
  }

  async #resolveAuthorizedFolder(folder) {
    validateFolder(folder);
    if (typeof this.authorizeProjectRoot === "function") {
      // The folder must be an explicitly authorized project root: opening
      // arbitrary disk locations from renderer strings is refused.
      const authorized = await this.authorizeProjectRoot(folder).catch(() => {
        throw new Error("Open this folder via Open project first");
      });
      if (typeof authorized !== "string" || !authorized)
        throw new Error("Open this folder via Open project first");
      return authorized;
    }
    return folder;
  }

  #buildArgv(folder, file, line) {
    const safeFile = validateRelativeFile(file);
    const safeLine = validateLine(line);
    if (!safeFile) return [folder];
    const sep = this.platform === "win32" ? "\\" : "/";
    const full = `${folder.replace(/[\\/]+$/, "")}${sep}${safeFile.replaceAll("/", sep)}`;
    if (safeLine != null) return [folder, "--goto", `${full}:${safeLine}`];
    return [folder, full];
  }

  #systemCmd() {
    const systemRoot = this.env?.SystemRoot ?? "C:\\Windows";
    return path.join(systemRoot, "System32", "cmd.exe");
  }

  async #spawnGuarded(exe, argv, options) {
    // A returned object is not a launch: wait for the OS 'spawn' event and
    // treat an async 'error' as a failed launch. Without the error listener
    // a late ENOENT would surface as an uncaught exception and crash the app.
    // The confirmation means "process created", never "window visible".
    let child;
    try {
      child = this.spawnImpl(exe, argv, {
        shell: false,
        windowsHide: false,
        detached: true,
        stdio: "ignore",
        ...options,
      });
    } catch (cause) {
      throw new Error("The editor or terminal could not be launched");
    }
    try {
      child?.unref?.();
    } catch {
      // unref failures never fail the handoff itself.
    }
    if (!child || typeof child.once !== "function") return child;
    const started = await new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(true);
      }, 1500);
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        try {
          child.off?.("error", onError);
        } catch {}
        try {
          child.off?.("spawn", onSpawn);
        } catch {}
      };
      const onSpawn = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(true);
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(false);
      };
      try {
        child.once("spawn", onSpawn);
        child.once("error", onError);
      } catch {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(true);
        }
      }
      // A process that already exited (or failed) before listeners attached
      // reports through exitCode/signalCode instead of hanging the handoff.
      try {
        if (child.exitCode !== null && child.exitCode !== undefined) {
          if (!settled) {
            settled = true;
            cleanup();
            resolve(true);
          }
        }
      } catch {}
    });
    if (!started) throw new Error("The editor or terminal could not be launched");
    return child;
  }

  async open({ editorExe = null, editorId = null, folder, file = null, line = null } = {}) {
    let exe = null;
    if (editorExe != null) {
      exe = validateExePath(editorExe);
      if (!(await this.#existsFile(exe))) throw new Error("The configured editor was not found");
    } else if (editorId != null) {
      const detected = await this.detect();
      const match = detected.find((e) => e.id === editorId);
      if (!match?.exePath) throw new Error("This editor is not installed");
      exe = match.exePath;
    } else {
      throw new TypeError("An editor executable or id is required");
    }
    const authorizedFolder = await this.#resolveAuthorizedFolder(folder);
    const argv = this.#buildArgv(authorizedFolder, file, line);
    // Structured spawn, shell:false, no interpolation, .exe only. The editor
    // runs as its own app; nothing is auto-launched in the background.
    const child = await this.#spawnGuarded(exe, argv, {});
    return {
      exePath: exe,
      argv,
      pid: typeof child?.pid === "number" ? child.pid : null,
    };
  }

  async openTerminal({ folder } = {}) {
    const authorizedFolder = await this.#resolveAuthorizedFolder(folder);
    // Direct launches only: wt.exe -d <folder>, else an interactive cmd.exe
    // started with cwd set to the folder and /d (no AutoRun). The folder is
    // never parsed as command text, so shell metacharacters in its name
    // cannot break out into a second command. No shell string is built.
    if (this.platform !== "win32") throw new Error("Terminal handoff is Windows-only here");
    const wt = await this.#resolveInPath(["wt.exe"]);
    if (wt) {
      const wtChild = await this.#spawnGuarded(wt, ["-d", authorizedFolder], {});
      return {
        exePath: wt,
        argv: ["-d", authorizedFolder],
        pid: typeof wtChild?.pid === "number" ? wtChild.pid : null,
      };
    }
    const cmd = this.#systemCmd();
    if (!(await this.#existsFile(cmd))) throw new Error("Windows terminal is unavailable");
    // /d disables AutoRun hijack; cwd places the shell in the workspace
    // without passing the path through cmd's command parser.
    const child = await this.#spawnGuarded(cmd, ["/d"], { cwd: authorizedFolder, windowsHide: false });
    return {
      exePath: cmd,
      argv: ["/d"],
      cwd: authorizedFolder,
      pid: typeof child?.pid === "number" ? child.pid : null,
    };
  }
}
