# Upstream integration follow-ups

Vibe Desktop keeps the pinned engine unmodified. These findings are candidates
for upstream fixes or protocol clarification, supported by the real Windows
runtime checks in [validation](validation.md).

## Unified method dispatch

The public registry includes `review/state`, `review/turnDiff`, `stats/read` and
`diagnostics/list`. The default Unified adapter returns `method_not_found`,
while the legacy handler implements them. This prevents clients from treating
the public registry as a capability declaration.

A useful upstream change would dispatch each method to its supported Unified
implementation or return a typed availability result. Review should retain its
engine ownership; a client Git diff must not become an engine approval. A
capability handshake would also let clients avoid probing optional methods.

Acceptance: execute the same request set through the legacy and default Unified
paths, verify the typed response contract, and cover unavailable capabilities
without losing a session or its history. Desktop diagnostics currently read the
public runtime snapshot; Git inspection stays a scoped client service.

## MCP persistence layer

A source toggle persists to the default configuration layer. A project-local
server declaration can shadow that write, so a successful response does not
necessarily change the effective source. The desktop verifies catalog readback,
writes the `disabled` leaf in the source's exposed writable layer when needed,
and explicitly refreshes discovery.

A source mutation could accept a supported target layer or report the applied
layer and effective state. Source metadata could also advertise OAuth support
so a client can present sign-in/sign-out without inspecting config metadata.

Acceptance: enable and disable a project-declared HTTP source, preserve headers
and environment references, refresh discovery and verify the resulting catalog.
Plugin-owned sources should remain under plugin ownership.

## Measurement semantics

The current Unified stats snapshot provides cumulative input/output tokens and
latest context, but can supply zero defaults for unmeasured cached input and
duration. Explicit nullable measurement fields or availability flags would let
clients distinguish a measured zero from an absent counter. Session totals,
context occupancy and organization allowance should retain separate semantics.

## Desktop backlog boundaries

Skill registry lifecycle and managed worktree actions already exist upstream;
their missing graphical actions are desktop work. Browser sign-in uses the
existing upstream controller through a minimal owned adapter. Numeric account
allowances are not exposed by `account/read`, so official dashboards remain the
account view. No upstream issue or public message is submitted automatically.
