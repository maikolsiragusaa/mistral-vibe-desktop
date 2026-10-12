# A workspace with a Mistral character

Vibe Desktop should feel like a tool built for uninterrupted coding: a quiet
project rail, a readable conversation and a context panel that opens when the
work needs it. The agent's actions remain visible without overwhelming its
answer.

## References

The direction comes from Mistral's [Vibe product page](https://mistral.ai/products/vibe/),
[documentation](https://docs.mistral.ai/vibe/code/overview) and
[brand page](https://mistral.ai/brand/), reviewed on 12 October 2026. Their shared
language uses warm light surfaces, dark ink, orange emphasis, compact controls
and occasional pixel geometry. These are design observations, not an invented
official token specification.

The app uses its own stepped signal mark and Ember, an original pixel lantern
companion. It does not reproduce Mistral's cat,
wordmark or proprietary font. A visible Community label and an About statement
identify the independent project.

## Visual system

| Role           | Light     | Dark      |
| -------------- | --------- | --------- |
| Workspace      | `#fcfaf6` | `#16191e` |
| Navigation     | `#f1eee8` | `#1b1e24` |
| Raised surface | `#ffffff` | `#20242b` |
| Main text      | `#252a31` | `#f4f1eb` |
| Secondary text | `#6e7379` | `#a8aeb7` |
| Border         | `#dfded9` | `#333942` |
| Accent         | `#df5720` | `#ff9961` |
| Accent surface | `#ffecdf` | `#3b2a23` |

Use system sans-serif for the interface and a system monospace for code. Keep
the main transcript around 72 characters wide. Orange signals the main action,
selection and progress; it should not fill large reading surfaces. Thin rules,
small radii and a restrained stepped motif provide character.

## Interaction

Projects and sessions stay together in the left rail. The centre carries the
conversation and a composer anchored to the workspace. The right panel holds
Activity, Changes and Environment. A lower shell panel displays upstream shell
effects and accepts explicit commands through Vibe's shell operation.

The 42-pixel Windows titlebar carries project and activity state plus command
search. Native controls sit in the overlay's reserved area. Management is a
separate modal window with a side navigation for MCP, skills, plugins,
providers, diagnostics and quotas. It keeps the conversation mounted and
returns focus when closed. Configuration does not appear as a conversation.

Ember shows idle, thinking, working, waiting, completed and error states from
actual runtime activity. Decorative sequences finish rather than running
indefinitely. Surface arrivals and control transitions take 160–180 ms;
closing the management window has a matching short exit. Both system reduced
motion and the app's motion setting disable them. The companion itself can
also be hidden.

The first launch is a useful empty workspace with setup status and a clear
Open project action. It contains no fabricated transcript, token counter or
agent activity. Prompts become public history only when the backend accepts
them. Errors preserve the user's draft and explain the next action.

Approval cards show the operation, its arguments and Vibe's available decisions.
Questions keep the supplied choices and allow the supported free-text answer.
The current agent mode and model remain next to the composer. Escape interrupts
an active turn; Ctrl+Enter sends a prompt; Ctrl+O opens a project. Focus states,
labels and reduced-motion support are part of the first implementation.

## Writing

Follow the practical structure used in upstream Vibe documentation: state the
decision, explain why it exists, show the command or example, and name the
observable outcome. Write to an engineer using the software. Prefer concrete
verbs over promises and human explanations over compliance language.

Product copy should be short: “Open a project”, “Continue this session”,
“Approve once”, “Vibe is waiting for your input”. Engineering docs can be more
detailed where ownership, compatibility and recovery require precision.

## Review

The [static layout preview](ui-preview.svg) records the intended proportions and empty state.
Real desktop screenshots then test those decisions at the actual window size.
The interface is accepted only after checking both themes, setup, project
navigation, focus and narrow-window behavior in the running app.

The 0.2 refinement also adds draggable collapse/reopen edges for both sidebars,
with button and keyboard alternatives. The titlebar uses a compact MCP status
popover instead of repeating the composer's execution status. Reasoning entries
supplied by Vibe remain expandable and open while streaming; unsupported
provider reasoning is not reconstructed.

Model, agent mode and thinking effort share one anchored popover component.
Each uses the same surfaces, selected checkmark, keyboard navigation and direct
selection. Model search stays inside the compact menu, with provider, context
and image support in each row. Menus use the native popover top layer to avoid
clipping in the composer or settings window. The right sidebar starts closed.
Git toggles its workspace and returns to the conversation from the same button;
there is no separate Chat button in the header.

Context details use the same anchored popover placement, opening directly above
the usage ring without dimming the conversation. The compact three-column card
keeps measured input/output, headroom and cumulative totals visible together.

The activity language follows upstream CLI loading and thinking controls:
[loading states](https://github.com/mistralai/mistral-vibe/blob/4ae5c5955da8e761318916bdb1a7f46f0b50c7d0/vibe/cli-rust/src/ui/loading/mod.rs)
and [thinking picker](https://github.com/mistralai/mistral-vibe/blob/4ae5c5955da8e761318916bdb1a7f46f0b50c7d0/vibe/cli-rust/src/thinking_picker.rs).
Desktop rendering uses the public session projection and shared tool display
status text. It does not parse terminal output or copy a separate execution loop.
