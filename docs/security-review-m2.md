# Security review — M2: Git, worktrees & workspace

Date: 2026-10-13. Scope: `src/main/git-service.js`, `src/main/index.js`
(IPC allowlist), `src/renderer/GitWorkspace.tsx`, `DiffViewer.tsx`,
`preview-url.ts`, `capabilities.ts`, `SubagentView.tsx`.

## Invariants (all covered by tests in `tests/git-service.test.js`)

- No Git operation acts on the wrong repository: every entry resolves the
  authorized project root via `realpath`, requires it to equal
  `rev-parse --show-toplevel`, and re-verifies that identity immediately
  before each mutation (`stage`, `unstage`, `stageHunk`, `unstageHunk`,
  `commit`, `create/remove/pruneWorktrees`). Identity change → refusal.
- No staged change is silently lost: hunk staging requires an exact header+
  body match against a freshly regenerated diff (`STALE_HUNK` otherwise);
  `git apply` is atomic; callers return the re-read status/index, and tests
  assert actual `git diff --cached` content, not exit codes.
- No pre-existing file is discarded: discard/checkout/restore of working
  files is not exposed at all. Removal paths never use `--force`,
  `reset --hard`, `clean -fd`, or generic directory deletion.
- No dirty worktree is deleted without protection: `removeWorktree` refuses
  dirty, untracked (with sample), ahead-of-upstream, diverged-without-
  upstream, locked, bare, main-checkout, and unidentifiable paths, each with
  the reason. Plain `git worktree remove` (no `--force`) is the only
  deleter, and it re-refuses dirty checkouts itself.
- No session is interrupted by Git navigation: Git IPC never touches
  sessions; worktree creation never moves the active session.
- No user input reaches a shell: all Git/`gh` execution uses `execFile`/
  `spawn` with structured argument arrays (`shell:false`, `windowsHide`),
  timeouts and output caps; hunk patches travel via stdin; PR bodies via
  stdin (`--body-file -`); no interpolation into commands.
- No preview exposes Electron privileges: `readFile`/`listDirectory` return
  data only; the renderer never loads `file://`; images render as data URLs;
  markdown renders via `react-markdown` (no raw-HTML pipeline); the loopback
  iframe uses `sandbox="allow-scripts"` without `allow-same-origin`, so
  framed content has no preload/IPC/DOM access to the app.
- No credentials in logs: PR flows parse only `nvim`-safe JSON fields;
  remote URLs are re-validated to `https://github.com/owner/repo[/pull/N]`
  with no userinfo/query/hash; `stderr` is drained, not retained; URL
  allowlists live in `src/main/index.js` (`vibe:git`, `vibe:open-external`).
- No unauthorized path is modified: `normalizeRelativePath` rejects
  absolute/drive/UNC/`..`/NUL/ADS-colon/trailing-dot `.git` segments;
  every file op re-resolves with `realpath` walk-up and refuses escapes
  (junction/symlink/file-symlink tests on Windows; skips — never passes —
  when the OS denies symlink creation); sibling worktrees operate only when
  explicitly selected as their own authorized root.
- Git failures surface: stale hunks, dirty worktrees, missing `gh`/auth,
  non-GitHub remotes and oversized diffs all return explicit errors; refresh
  preserves file selection and drafts.

## Residual risks / backlog

- TOCTOU windows are narrowed (validate → verify → spawn) but not
  eliminated on a hostile local machine; a privileged local attacker racing
  `realpath`→`exec` remains out of scope (same as M1.1 shell handling).
- `git worktree list` paths are trusted as Git's own output; each is
  re-canonicalized before detail/removal use.
- Playwright Electron screenshots and packaged-app (NSIS) tests were not
  re-run in this iteration — CI on the pushed branch must confirm them.
