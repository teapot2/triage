# Agent guidelines

Repo-wide rules for coding agents. App-specific notes live in `apps/*/AGENTS.md`.

## Git

- Do not add AI attribution to commits or pull requests: no `Co-Authored-By` trailers for agents, no "Generated with" footers.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages (`feat:`, `fix:`, `chore:`, `docs:`, …).
- Commit only `.env.example` templates, never real env files. `docs/`, `infra/telemetry/` and `apps/triage/.data/` stay local (see `.gitignore`).
