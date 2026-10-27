# Spec: select the model for each agent in the dashboard

## Problem

The model for each agent role is set in `durable/lanes.json`. To change a model (for example, `plan` from `anthropic/claude-opus-5-5` to `openai/gpt-6.1-sol`), the operator must edit the file by hand and restart. There is no setting in the dashboard.

## Goal

One Settings panel in the dashboard. It shows every agent role with a drop-down to select its model. A change applies to the next step that starts. No restart.

## Today

- `durable/lanes.json`: `lanes` holds an ordered model chain per role (`spec`, `code`, `review`, `coordinate`, `pr-summary`). `aliases` maps the other roles (`plan`, `test`, `docs`, `fix`, `judge`, `runtime`) to a lane.
- `durable/src/lanes.ts`: `loadLanes` validates the file. `pickModel` takes the Nth usable entry of the chain (known to pi-ai, has a login, not the avoided family).
- `durable/src/host.ts` loads the lanes one time at start and gives them to `pipeline.ts`.
- `durable/src/server.ts` serves the dashboard and the `/api/*` routes. POST routes need `X-Factory-Token`.

## Requirements

1. **Settings panel.** The dashboard has a Settings view with one row per agent role: all 11 roles (the 5 lanes and the 6 aliases).
2. **Drop-down per role.** Each row has a drop-down of models from the pi-ai catalog, as `<provider>/<model>`. A model whose provider has no login shows as disabled, with the reason ("no login for openai").
3. **Primary model.** The drop-down sets the first (preferred) entry of the role's chain. The other entries stay as fallbacks, in their order, with the selected model removed from them.
4. **Alias roles.** An alias row shows "same as `<lane>`" by default. When the operator selects a model, the role gets its own lane, and the alias is removed. A "Reset to `<lane>`" action brings the alias back.
5. **Family rule.** `review` and `judge` never use the coder's model family. If the selection breaks this rule, the panel shows a warning, and the save still goes through. `pickModel` keeps this rule at run time.
6. **API.**
   - `GET /api/lanes`: the current lanes, the aliases, and the catalog with the login state of each provider.
   - `POST /api/lanes` (needs `X-Factory-Token`): the new lanes and aliases. The server validates with the same rules as `loadLanes` and returns 400 on a bad entry.
7. **Save.** The server writes `LANES_FILE` (default `durable/lanes.json`) atomically (write a temp file, then rename). It keeps `_help`.
8. **Live reload.** The running host uses the new lanes for each step that starts after the save. A step that runs now keeps its model.
9. **Audit.** Each save writes one line to the factory log: who, which role, old model, new model.

## Out of scope

- Edit of the full fallback chain (order, add, remove) in the UI. Edit the file for that.
- A per-ticket or per-repo model.
- New providers or logins from the UI. API keys stay in `config.env`.

## Acceptance

- In Settings, set `plan` to `openai/gpt-6.1-sol` and save. `lanes.json` now has a `plan` lane with `openai/gpt-6.1-sol` first. The `plan` alias is gone.
- The next ticket's plan step runs on `openai/gpt-6.1-sol` (shown in the step events), without a restart.
- A POST without the token returns 403. A POST with `"bad-model"` returns 400, and the file does not change.
- A provider without an API key shows its models as disabled.
- Tests: `lanes.ts` (validate, alias split, save) and `server.ts` (GET, POST, 400, 403).
