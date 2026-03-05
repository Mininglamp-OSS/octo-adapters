# Contributing to DMWork Adapters

Thank you for your interest in contributing! This guide covers the workflow and conventions for this project.

## Issue Claim Policy

**Before starting work on any issue, you MUST:**

1. **Comment on the issue** stating that you are claiming it
2. **Describe your proposed fix/approach** in the same comment
3. **Wait for acknowledgment** if the issue has significant scope

This prevents duplicate work. If an issue already has someone working on it (check comments), coordinate with them before starting your own implementation.

Example comment:
```
I'd like to work on this. My proposed approach:
- Change X in `file.ts` to handle Y
- Add tests for Z

Will submit a PR within [timeframe].
```

## Development Workflow

We use a **fork-based** workflow. Do not push branches directly to the upstream repo.

### Setup (first time)

```bash
# 1. Fork the repo on GitHub
# 2. Clone your fork
git clone https://github.com/<your-username>/dmwork-adapters.git
cd dmwork-adapters

# 3. Add upstream remote
git remote add upstream https://github.com/Mininglamp-OSS/octo-adapters.git
```

### Working on an Issue

1. Claim the issue (see above)
2. Sync with upstream:
   ```bash
   git fetch upstream
   git checkout -b fix/issue-<number>-<description> upstream/main
   ```
3. Implement the fix
4. Ensure no new TypeScript compilation errors
5. Push to **your fork**:
   ```bash
   git push origin fix/issue-<number>-<description>
   ```
6. Open a PR from your fork to `Mininglamp-OSS/octo-adapters:main`
7. Reference the issue in the PR description (`Fixes #<number>`)

## Feature Requests

1. **Do not start coding immediately** — open a Discussion or comment on the issue first
2. Discuss the approach, scope, and potential impact
3. Once the approach is agreed upon, claim the issue and proceed

## Pull Request Guidelines

- **One PR = one concern.** Do not mix unrelated changes
- **PR title** should be descriptive: `fix: resolve WebSocket reconnect on token expiry`
- **PR description** must include What, Why, How, and Testing sections (see PR template)
- **CI must pass** before requesting review
- **Request cross-review** from at least one other contributor

### AI-Assisted Contributions

If you used AI tools to help write the code:
- State which tool(s) you used in the PR description
- Indicate testing level (untested / lightly tested / fully tested)
- Confirm you understand what the code does

## Branch Naming

- Bug fixes: `fix/issue-<number>-<description>`
- Features: `feat/<description>`
- Chores: `chore/<description>`

## Code Style

- TypeScript for all source code
- English for code, comments, and documentation
- Avoid `any` types — use specific type definitions
- Use the project's existing patterns as reference

## Security

Do **not** open public issues for security vulnerabilities. Follow the process in [SECURITY.md](https://github.com/Mininglamp-OSS/octo-server/blob/main/SECURITY.md).
