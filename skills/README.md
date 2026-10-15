# skills

Team skills for the agents: one folder per skill, each with a SKILL.md. This folder is searched first (see SKILLS_PATH) and is copied into the Docker image.

Vendored sets, each with a SOURCE.md (where it came from, the commit, how to update):
- `mattpocock/`: Matt Pocock's skills (MIT).
- `pstack/`: poteto's pstack (MIT), only the skills that run in one headless session. Name them `pstack/<skill>`.
