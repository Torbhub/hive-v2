# Scripts

This directory contains shared helpers for agents and CI. The shared script
rules live in `../rules/RULES.md`.

Run each command from the repository root.

## `apply_branch_protection.sh`

The script shows the current branch protection and prints a dry run by default.
The `--apply` mode applies the settings and needs GitHub admin access.

```bash
bash scripts/apply_branch_protection.sh
bash scripts/apply_branch_protection.sh --apply
```

## `discipline-gate.mjs`

The script checks line counts, comment counts, task event writes, and dependency
rules. The update mode rewrites the baseline without raising its limits.

```bash
node scripts/discipline-gate.mjs [--check|--update]
node scripts/discipline-gate.mjs --check-task-appends <root>
node scripts/discipline-gate.mjs --check-enforcement <root>
node scripts/discipline-gate.mjs --inventory-comments [root]
```

## `install-git-hooks.sh`

The script installs the tracked pre-push hook and the gated `jj push` alias.

```bash
bash scripts/install-git-hooks.sh
```

## `jj-push-gate.sh`

The script runs the pre-push checks and then calls `jj git push` with the
supplied arguments. After hook installation, use the gated alias.

```bash
jj push [push arguments]
```

## `read-kimi-model.py`

The script reads a model alias from a TOML file and writes the model
configuration as JSON.

```bash
python3 scripts/read-kimi-model.py <config-path> <alias>
```

## Internal files

These files support the entry points above and have no standalone agent usage.

- `discipline-baseline.json` stores line-count and comment-count limits for
  `discipline-gate.mjs`.
- `discipline-comments.mjs` supplies the comment inventory to
  `discipline-gate.mjs`.
- `discipline-python-comments.py` scans Python comments for
  `discipline-comments.mjs`.
- `git-hooks/pre-push` is the tracked hook installed by `install-git-hooks.sh`.
