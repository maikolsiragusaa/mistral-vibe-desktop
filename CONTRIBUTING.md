# Contributing to Vibe Desktop

Build a useful delivery surface for Mistral Vibe. Keep the engine upstream.

## Development

Follow the source setup in [README](README.md). `npm start` builds the renderer
and opens the desktop app. `npm run dev` serves the renderer for layout work;
browser preview has no desktop bridge and cannot run an agent.

The source is deliberately small:

| Path                               | Responsibility                                                          |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `src/main/rpc-client.js`           | JSON-RPC framing, request correlation and callback receipts.            |
| `src/main/backend.js`              | App-server process lifecycle and the permitted desktop operations.      |
| `src/main/index.js`, `preload.cjs` | Sandboxed Electron window and validated IPC bridge.                     |
| `src/renderer/`                    | Public projections, conversation, navigation and presentation.          |
| `scripts/`                         | Pinned backend setup, packaging and local conformance fixtures.         |
| `tests/`                           | Transport, lifecycle, projection and actual desktop integration checks. |

## Change the owning boundary

Session state, permissions, tools, Git, MCP and credentials belong to Vibe.
Extend the client by rendering an existing public resource before introducing
new runtime behavior. Use explicit app-server methods and strict request
fields. Accept additive response fields; make unsupported optional operations
visible and recoverable.

The renderer must not import Node, spawn processes, read workspace files,
persist credentials or parse private Vibe journals. It renders public session
state and applies wire patches. After an event gap, reload the canonical
projection. After a crash, offer resume; never resend a prompt automatically.

The main process owns only its child backend and presentation preferences.
Keep stdout parsing independent of UI event processing. A `callback/call`
receipt is not an approval: the human answer travels through `callback/result`.

## Check your change

Run the checks relevant to the behavior you changed. For protocol or lifecycle
changes, run `npm test` with the pinned backend installed. For interface changes,
run `npm run build` and `npm run test:ui`, inspect the actual screenshots and
exercise keyboard navigation. Use an isolated Vibe home and the loopback
provider for tests. Do not use personal credentials in fixtures.

An engine upgrade needs a new source pin, Windows wheel verification, protocol
conformance results and a matching dependency/license inventory. Keep the app
server's native runtime and package version together.

After packaging, run the same desktop workflow against the actual executable:

```powershell
$env:VIBE_TEST_DESKTOP = "$PWD/out/win-unpacked/Vibe Desktop.exe"
npm run test:ui
```

This uses the backend under the app's own resources directory. Test runs set
`VIBE_DESKTOP_USER_DATA` and `VIBE_HOME` to disposable profiles; both the source
and packaged app support that explicit profile path. No personal credentials
or preferences are used.

## Write for the next engineer

Start a PR with the user-visible problem and resulting behavior. Explain the
ownership or compatibility decision only where it matters. Include the checks
you executed and their practical limits. Document outcomes, not intentions.
Use [Architecture](docs/architecture.md) for decisions and
[Validation](docs/validation.md) for evidence; add another document only when it
has a distinct job.
