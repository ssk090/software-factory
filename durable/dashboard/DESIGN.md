# Dashboard design guide

The dashboard (`index.html`) follows [shadcn/ui](https://ui.shadcn.com) with its default **neutral**
theme. It is one hand-written file with no build step, because the server serves it with a strict CSP
(`default-src 'self'`, inline script and style only) and Docker and CI have no front-end build. So the
shadcn *design system* is reproduced in plain CSS: the same tokens, radii, sizes and component anatomy,
not the React components. Section 9 says how to move to the real components later.

## 1. Principles
1. **It is a console, not a site.** The user is deciding and watching: what needs me, what is running, what is stuck. Show state first, chrome last.
2. **One primary action per surface.** *Fix this*, *Plan spec*, *Approve and build* are `primary`; everything else is outline.
3. **Semantic tokens only.** No hex or raw colour in rules. Light and dark come from the same names.
4. **Compose, don't invent.** Reach for a shadcn pattern (Card, Table, Badge, Alert, Empty, Sidebar) before writing a new styled `div`.
5. **State is always visible.** Every list has an empty state; every error is an Alert; every running thing is a Badge.
6. **No surprises under the cursor.** Redraws never replace a field the user is typing in (see `refresh()` in the script).

## 2. Sources
- Blocks: `dashboard-01` (sidebar, section cards, data table) and `sidebar-07` (sidebar with inset content), <https://ui.shadcn.com/blocks>.
- Tokens: <https://ui.shadcn.com/docs/theming>, neutral base, OKLCH.
- Rules for composing components: the shadcn agent skill (`.agents/skills/shadcn`, installed with `npx skills add shadcn/ui`): semantic colours, Badge instead of custom spans, Separator instead of ad-hoc borders, Empty and Alert instead of custom markup, full Card anatomy.

## 3. Tokens
Defined once in `:root`, with the dark values in `@media (prefers-color-scheme: dark)`. There is no toggle: the dashboard follows the OS.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--background` | `oklch(1 0 0)` | `oklch(0.145 0 0)` | page, inputs, outline buttons |
| `--foreground` | `oklch(0.145 0 0)` | `oklch(0.985 0 0)` | text |
| `--card` | `oklch(1 0 0)` | `oklch(0.205 0 0)` | Card, detail panel |
| `--primary` / `-foreground` | `oklch(0.205 0 0)` / `oklch(0.985 0 0)` | `oklch(0.922 0 0)` / `oklch(0.205 0 0)` | the primary button, the brand mark |
| `--secondary`, `--muted`, `--accent` | `oklch(0.97 0 0)` | `oklch(0.269 0 0)` | hover, code and live surfaces |
| `--muted-foreground` | `oklch(0.556 0 0)` | `oklch(0.708 0 0)` | secondary text, table headers |
| `--destructive` | `oklch(0.577 0.245 27.325)` | `oklch(0.704 0.191 22.216)` | errors, blocked |
| `--border` | `oklch(0.922 0 0)` | `oklch(1 0 0 / 10%)` | every line |
| `--input` | `oklch(0.922 0 0)` | `oklch(1 0 0 / 15%)` | field borders |
| `--ring` | `oklch(0.708 0 0)` | `oklch(0.556 0 0)` | focus |
| `--radius` | `0.625rem` | same | `-sm` = radius - 4px, `-md` = radius - 2px, `-lg` = radius, `-xl` = radius + 4px |

Extensions (shadcn has no status colours; these are ours, tuned so text on a 10% tint of itself keeps contrast in both modes):

| Token | Light | Dark | Means |
|---|---|---|---|
| `--success` | `oklch(0.527 0.154 150.069)` | `oklch(0.723 0.219 149.579)` | done, PR ready |
| `--warning` | `oklch(0.555 0.163 48.998)` | `oklch(0.769 0.188 70.08)` | waiting for you, warning level |
| `--info` | `oklch(0.488 0.243 264.376)` | `oklch(0.623 0.214 259.815)` | running, tool calls |
| `--sidebar`, `--sidebar-accent`, `--sidebar-border` | match the neutral sidebar theme | | sidebar surface, hover/active row, edge |

The sidebar values are written to match shadcn's neutral sidebar theme but were not fetched from it: compare them with the docs if you need them exact.

## 4. Typography
- Font: the system stack (`system-ui`). shadcn's own starters use Geist, but the CSP allows no external font; self-host one under the same origin if you want it.
- Base 14px / 1.5. Card title (`h2`) 15px semibold. Section label (`h3`) 13px semibold. Stat value 24px semibold. Code and live feed 12px mono.
- Numbers that line up (counts, scores, stats) use `font-variant-numeric: tabular-nums`.
- Muted text is for secondary facts (project, culprit, model, timestamps), never for the only copy of something the user must act on.

## 5. Spacing and shape
- 4px grid. Page padding 24px (16px under 760px). Gap between cards 16px. Card padding 16px. Cell padding 8px.
- Cards use `--radius-xl` and a `0 1px 2px` shadow. Controls use `--radius-md`. Badges use `--radius-sm`.
- Controls are 32px (buttons) or 36px (fields) tall.

## 6. Layout (the Sidebar block)
- **Sidebar, 232px, sticky, collapsible:** brand, a "Work" group with the three views (icon, label, count), and the "updated" time at the foot. The panel button in its header, or Ctrl/Cmd+B, collapses it to a 56px icon rail (the nav buttons keep their `title` as a tooltip); the choice is kept in `localStorage` (`sf.sidebar`). Under 760px it is always a top bar and the toggle is hidden.
- **Page:** the budget banner when the daily budget is spent, a row of four stat cards (*To decide*, *Sprint tasks*, *Active runs*, *Spend today*; two per row under 1100px), then one Card per view.
- **Detail panel:** opening a ticket adds a right column (`minmax(380px, 42%)`), sticky, scrolling by itself. It is the Sheet pattern without the overlay, because the list must stay visible. Top to bottom: title, state and links, a notice when paused, an Alert when blocked, the controls (Pause or Continue, Stop; Run again and Start fresh when it ended) with the run's steps, tokens and cost on the right, the approval box at the gate, then Tabs: *Timeline* (with the live view and steer), *Logs*, *Files*.
- **Sidebar foot:** the spend meter (today against the budget; amber from 80%, red at 100%), a line when a request waits for a rate limit, and the "updated" time.
- Tables scroll sideways inside their Card rather than breaking the layout.

## 7. Components
Each row says which shadcn component the class stands for, so a future port is mechanical.

| Class / element | shadcn component | Rules |
|---|---|---|
| `section.card`, `.stat`, `aside` | Card (`CardHeader`, `CardTitle`, `CardContent`) | the `.bar` row is the header: title left, actions right |
| `button.act` | Button `variant="outline"` | default for every action |
| `button.act.primary` | Button `variant="default"` | one per surface; disabled while its request runs (`act()` does this) |
| `.chip` | Badge `variant="outline"` | neutral facts: environment, step status |
| `.chip.ok / .warn / .bad / .run` | Badge, tinted | success / waiting / error / running, from `STATE` in the script |
| `table`, `th`, `td`, `tr.click` | Table | header muted 13px, rows separated by `--border`, hover at 50% muted; a clickable row opens the detail |
| `td.empty` | Empty | one row, centred, muted, says what to do next |
| `.card > .error`, `aside > .error` | Alert `variant="destructive"` | sync errors and a blocked ticket's reason |
| `input[type=text]`, `select`, `textarea` | Input, Select, Textarea | focus ring is `--ring` at 50%, 3px |
| `nav#tabs button` | Sidebar menu button | `.on` marks the current view; icon + `.label` + `.count`; only the icon shows when collapsed |
| `.icon-btn` | Button `variant="ghost" size="icon"` | the sidebar toggle; needs an `aria-label` |
| `#toasts`, `.toast.success / .error` | Sonner | see section 8 |
| `details` | Collapsible | one per run-folder file; the spec opens by itself while waiting for approval |
| `pre`, `.live` | muted surface, mono | `.live .tool` is `--info`; output and the user's steers are muted |
| `a` | link | foreground colour, underlined, never browser blue |
| `.seg` | Tabs (`TabsList`, `TabsTrigger`) | the detail's views; the active trigger is the raised one; counts in `.n` |
| `dialog.doc` | Dialog | the reader: rendered Markdown (`.md`), tabs for spec and plan, Copy, close; *Approve and build* in the footer at the gate. The text is the agents' and becomes DOM nodes only; links only to http(s) |
| `.doc-live` | Alert (info), with the live dot and a caret | the reader opened from a running spec or plan step: the file as the agent types it (its write call streamed, argument by argument), following the bottom unless you scroll up; diagrams are drawn once the file is written |
| `.mermaid-box` | (ours) | a Mermaid diagram from a fenced block, drawn by the vendored bundle (`vendor/mermaid.min.js`, loaded the first time a document holds one) in `securityLevel: "strict"`; a broken diagram shows its code and the error |
| `.suggest` | Popover + Textarea | select text in spec.md or plan.md at the gate: the quote, a textarea whose placeholder suggests a change that fits the section (an AC, out of scope, risks, the diagram), who gets it, Send (Cmd/Ctrl+Enter), Cancel (Esc) |
| `.revising` | Alert (info), with the live dot | an agent is changing the file; *Approve and build* waits for it. Red when the last change failed |
| `.tl-step.failed`, `.live-dot.bad` | (ours) | a crash: a red step and dot; the dot pulses while the crash is the newest thing that happened (the ticket is stuck on it). A blocked phase's dot and stage bar pulse red; a phase the coordinator is repairing shows a pulsing red dot, a *repairing* badge and red moving stripes on its stage |
| `.stages`, `.stage`, `.stage-bar` | (ours: a stage track) | the top of the Timeline: the run's seven stages (Received, Spec or Root cause for Sentry tickets, Approval, Tests, Fix, Pull request, Ready) as bars, labels in mono, then the current stage large with what it is doing. Bar: success = done, info with moving stripes and a glow = in progress, warning stripes = paused or waiting for you (waiting also glows), destructive = blocked, outlined and struck through = skipped in this run |
| `.tl`, `.tl-item`, `.tl-dot` | (ours: a vertical Stepper) | one item per phase of the latest run. Dot: success = done, info and pulsing = running, warning = paused or waiting for you, destructive = blocked, dashed and faded = still ahead |
| `.tl-step` | Item, as a button | an agent step under its phase: status Badge, name, model (truncated), own time, tokens, cost; opens the live view; `.watching` marks the one shown |
| `.tl-note` | muted text | what happened in the phase: verify, review, PR, pauses; warning and destructive colours for those levels |
| `table.logs` | Table | Time, Level (small Badge), Event with its kind and step or phase under it; Select for level and kind, Input to search; newest first |
| `.meter` | Progress | the spend meter |
| `.banner` | Alert (warning) | the budget is spent; above everything on the page |
| `.notice` | Alert (warning), inline | the ticket is paused, why, and what happens next |
| `.chip.sm` | Badge, small | inside dense rows (steps, log levels) |

### Status vocabulary
| Ticket state | Badge | Text |
|---|---|---|
| `queued` | warn | queued |
| `running` | run | running |
| `waiting_approval` | warn | spec ready: approve |
| any live state, paused | warn | paused |
| `blocked` | bad | blocked |
| `in_review` | ok | PR ready |
| `stopped` | outline | stopped |
| Sentry level `fatal`, `error` / `warning` / other | bad / warn / outline | the level |
| Step `done` / `failed` / other | ok / bad / run | the status |

## 8. Behaviour
- **Loading:** the page fills in within one refresh (5s). Until the first answer, counts read 0 and tables are empty.
- **Empty:** every table says why it is empty and what to do.
- **Messages and errors:** a toast (`toast(text, "success" | "error")`; `flash(text, bad)` calls it). Bottom right, click to dismiss, success 4s, error 8s, icon in the status colour, `role="alert"` for errors. The same message shown again renews the toast on screen instead of stacking, so a failing 5s refresh shows one. Use a toast for the result of something the user did and for failures to load; use an `Alert` inside the Card for a standing condition of that data (a failed Sentry sync, a blocked ticket). The sidebar foot carries only the passive "updated" time.
- **Focus:** every interactive element shows the ring on `:focus-visible`. Hover never carries meaning that focus does not.
- **Motion:** subtle and only for real changes. A refresh that changed nothing moves nothing (the detail redraws only when its data changed; table rows animate only the first time they appear).
  | What | How | Time |
  |---|---|---|
  | a new table row, a new timeline item | fade up 4px, rows staggered 20ms (at most 200ms) | 220ms |
  | switching view (sidebar) or detail tab | fade up 4px | 200ms |
  | opening a ticket | the panel slides in 12px from the right | 240ms |
  | a stat that changed | a 8% bump | 320ms |
  | a Badge changing state, buttons, tabs, the meter | colour (and width) transitions | 150-400ms |
  | the running phase's dot, the running step's dot | a soft ring pulse | 2s, repeating |
  | the stage in progress | stripes move, a glow breathes | 0.9s and 2s, repeating |

  Looping animations keep their rhythm across redraws: a redrawn node gets a negative `animation-delay` (`inPhase()`), so it continues mid-cycle instead of restarting.
  | sidebar width, toasts | as before | 200ms |

  Everything is off under `prefers-reduced-motion`. Never animate layout of data the user is reading (no reflowing tables, no counting-up numbers).
- **Contrast:** text on a tinted Badge uses the status colour itself; both modes were checked by eye, not with a tool, so run one before shipping a palette change.

## 9. Constraints, and the way to the real components
- The CSP allows only same-origin resources plus inline script and style. A new font, icon set or stylesheet needs `server.ts` changed too. Icons would be inline SVG.
- `index.html` must stay one file with the `__FACTORY_TOKEN__` placeholder: the server reads it once at start and substitutes the token.
- Do not rename ids or classes the script uses (`#tabs`, `#main.open`, `.act`, `.chip`, `.live`, `n-*`, `stat-*`) without changing the script.

To move to React and the real shadcn components: add a Vite app next to `index.html`, run `npx shadcn@latest init`, build to static files, and let `server.ts` serve them with the token injected into a `<meta>` tag (the CSP would drop `'unsafe-inline'` for scripts in the process). Docker and CI then need a Node build step. The class-to-component table in section 7 is the porting map; the status table in section 7 becomes one `StatusBadge` component. The installed shadcn skill only activates once a `components.json` exists, so it starts helping at that point.
