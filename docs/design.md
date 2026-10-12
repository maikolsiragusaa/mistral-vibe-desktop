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

The app uses its own stepped signal mark. It does not reproduce Mistral's cat,
wordmark or proprietary font. A visible Community label and an About statement
identify the independent project.

## Visual system

| Role           | Light     | Dark      |
| -------------- | --------- | --------- |
| Workspace      | `#fffaf4` | `#171614` |
| Navigation     | `#f5efe6` | `#201e1b` |
| Raised surface | `#ffffff` | `#26231f` |
| Main text      | `#25221e` | `#f5eee5` |
| Secondary text | `#71695f` | `#b5aa9a` |
| Border         | `#ded6cb` | `#413a31` |
| Accent         | `#c04414` | `#ff995c` |
| Accent surface | `#ffead9` | `#40271b` |

Use system sans-serif for the interface and a system monospace for code. Keep
the main transcript around 72 characters wide. Orange signals the main action,
selection and progress; it should not fill large reading surfaces. Thin rules,
small radii and a restrained stepped motif provide character.

## Interaction

Projects and sessions stay together in the left rail. The centre carries the
conversation and a composer anchored to the workspace. The right panel holds
Activity, Changes and Environment. A lower shell panel displays upstream shell
effects and accepts explicit commands through Vibe's shell operation.

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
