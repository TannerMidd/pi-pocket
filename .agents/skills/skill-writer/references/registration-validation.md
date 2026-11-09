# Registration and Validation

Apply registration and lightweight validation before completion.

## Registration checklist

1. Inspect the workspace and identify the active skill layout before editing files.
2. Create/update `<skill-root>/SKILL.md`, `<skill-root>/SPEC.md` when required by change scope, and any bundled `references/`, `scripts/`, or `assets/` beneath that root.
3. Default to `.opencode/skills/<name>/` for this repository.
4. If the workspace clearly uses a different canonical layout, follow that layout instead.
5. Common established alternatives include:
   - `.agents/skills/<name>/` when no project-specific layout exists
   - `skills/<name>/` when the workspace uses a canonical root skill tree
6. If multiple plausible locations exist and inspection does not make the canonical target clear, ask the user before editing files.
7. Only apply repository-specific registration steps when the workspace conventions explicitly require them.

When a repository does maintain its own skill catalog, verify and update any required registration files such as:

- public skill inventories or tables
- project settings files
- allowlists used by other skills or automation

## Validation checklist

The validator is a structural check. It should fail only for invalid skill format or missing referenced files. The size warning requires author judgment, not a machine gate.

1. Run:

```bash
uv run {project-root}/.opencode/skills/skill-writer/scripts/quick_validate.py <path/to/skill-directory>
```

When running from within the skill directory itself, you can use the relative form:

```bash
uv run scripts/quick_validate.py <path/to/skill-directory>
```

2. Confirm manually for authoring/generator skills:
   - transformed examples exist in references (happy-path, secure/robust, anti-pattern+fix)
   - synthesis coverage was considered and any gaps are explicit
   - selected example profile requirements are satisfied and reported
   - `SPEC.md` exists or was updated when the change creates a skill or materially changes intent, scope, evidence model, validation, or maintenance expectations
   - every bundled reference file is directly discoverable from `SKILL.md`

3. Confirm manually for integration/documentation skills:
   - focused references cover API surface, common use cases, known issues/workarounds, and version variance
   - reference file names fit the skill's domain rather than a fixed template
   - `SKILL.md` and `references/*.md` avoid host-specific absolute filesystem paths

4. Confirm manually for portable skills:
   - bundled file references use skill-root-relative paths such as `references/...`, `scripts/...`, or `assets/...`
   - avoid host-specific absolute filesystem paths

5. Review validator warnings for oversized `SKILL.md` files.
6. Do not add validators for skill class, coverage quality, SPEC shape, trigger quality, or other qualitative guidance.

## Required output

- Registration changes summary
- Selected skill root and why it was chosen
- Validator output
- Any residual risks or open gaps
