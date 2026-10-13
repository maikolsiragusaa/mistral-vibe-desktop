# Vibe Desktop

**Your local projects. Mistral's coding engine. One focused Windows workspace.**

Vibe Desktop is a free, open-source community client for Mistral Vibe. Open a
local project, continue a conversation, inspect a diff and follow the agent's
work in a focused desktop workspace. The official Vibe app server runs
the agent, tools, permissions, session history, MCP and skills.

This is an independent project, unaffiliated with Mistral AI.

![Vibe Desktop, running on Windows](docs/screenshots/desktop-light.png)

## What works today (0.3.0-M1)

- Code/Work selector and Local/Cloud scope; Work links to official Mistral
  surfaces without faking a local API.
- Up to four attached sessions with tabs: close detaches (keeps running),
  stop/archive/delete are explicit. Fork, rewind, rename, mark-as-seen,
  compact and transcript export via official RPC.
- Live subagent navigation: open the real child conversation with breadcrumb,
  read-only notice and return; parent keeps working.
- Scheduled loops GUI (create/list/delete/clear) and Cloud panel
  (projectLinks, vibeCode picker, one-way Teleport preflight).
- Opt-in durable unsent drafts across full restart (localStorage only).
- Streaming Markdown, tool effects, approvals, prompt queue, attachments,
  searchable models, Git diffs/staging/commits/worktrees/PR links, MCP/skills/
  plugins management, context/token diagnostics and delegated browser sign-in.
- A packaged upstream backend, reproducible build scripts and Windows CI.

The client uses Vibe's configuration and credential store. The model picker
shows the runtime's allowed inventory, including configured GLM models and
custom providers. Selection does not claim account eligibility; successful use
is recorded only after a completed model response.

Vibe 2.26.1's Unified Harness does not dispatch `review/*`. The Git workspace
provides ordinary repository diffs alongside the engine's tool history.
Numeric account quotas remain on Mistral's official dashboards; session token
counters are shown separately. See [capabilities and limits](docs/capabilities.md).

## Run from source

Use Windows x64, Node.js 24+, Python 3.12 x64 and
[uv](https://docs.astral.sh/uv/getting-started/installation/).

```powershell
git clone https://github.com/maikolsiragusaa/mistral-vibe-desktop.git
cd mistral-vibe-desktop
npm ci
node node_modules/electron/install.js
./scripts/install-backend.ps1
npm start
```

Open **Settings** to check the engine connection. Use credentials already
configured with Vibe, choose **Continue in browser**, or paste a Mistral API key
and select **Save with Vibe**.
Vibe stores the key through its credential service; the desktop retains none.
Model use follows your Mistral plan or provider's billing.

Open a folder with **Open project** or **Ctrl+O**. When Vibe finds project
configuration, review its trust request. Describe the outcome in the composer,
then press Enter or Ctrl+Enter. Shift+Enter adds a new line; Escape interrupts
an active turn. Select a saved conversation in the project rail to continue it.
Use **Ctrl+K** for commands. **Resources** opens a management window; it keeps
the conversation mounted underneath. The context ring beside the composer
opens the measured input/output partition and token counters. Open **Quota &
usage** in Resources for account status and official Mistral dashboards.

## Build a Windows package

```powershell
./scripts/build-backend.ps1
npm run package
```

The local NSIS installer appears under `out/`. It contains the official
`mistral-vibe==2.26.1` app server and its Python/native runtime, so an installed
app needs no separate Python or uv installation. Git and a shell supported by
Vibe are still workspace tools; the app does not install or replace them.

Builds are unsigned until a signing identity is configured. These commands
produce local artifacts and do not publish a release. The
[validation record](docs/validation.md) names the checks actually executed and
the remaining Windows 11 installation checks.

## Test

```powershell
npm run build
npm test
npm run test:ui
```

Backend tests run the real Vibe engine against a loopback model fixture. The
fixture exists only under tests and does not call a paid API. The desktop UI
test launches Electron, opens a disposable local project, streams a turn,
resumes it and runs a shell command. It also captures the actual light and dark
interfaces. To test the frozen backend:

```powershell
$env:VIBE_TEST_SERVER = "$PWD/.runtime/backend/vibe-app-server/vibe-app-server.exe"
npm run test:ui
```

## Understand the project

- [Research and desktop chronology](docs/research.md): source evidence, dates,
  existing products and the feature gap matrix.
- [Architecture](docs/architecture.md): ownership, protocol, stack choice and
  the Windows feasibility gate.
- [Architecture references](docs/references.md): lessons from OpenCode and
  DeepSeek Harness.
- [Design](docs/design.md): Mistral-informed visual and writing direction,
  plus the original layout preview.
- [Contributing](CONTRIBUTING.md): boundaries and the development workflow.
- [Backlog](docs/backlog.md): the next useful increments.

## License

Apache-2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE) and
[third-party notices](THIRD_PARTY_NOTICES.md). Mistral's name and brand assets
remain its property. The stepped signal mark and Ember pixel companion are
original to this project.
