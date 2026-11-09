---
name: bash
description: Essential bash scripting rules
metadata:
  language: bash
  workflow: development
---

# Bash Scripting Rules

## Code structure

- Write reusable small functions instead packing too much logic

## Rules

- Inside functions, be aware to use `local` to not change the global context
- Avoid to define variables such as `USER` that are already set in the shell
- Keep comments minial
- Keep echo output minimal instead of verbose
- use `set -euo pipefail` by default
- Use `"$var"` not `$var` — Prevents word splitting and glob expansion with spaces/special chars
- Use [[ ]] for tests: Prefer `[[ -f "$file" ]]` over `[ -f "$file" ]` — Handles empty strings correctly
- Use bash builtins over external tools if possible
