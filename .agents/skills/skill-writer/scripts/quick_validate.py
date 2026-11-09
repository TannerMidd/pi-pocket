#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["pyyaml"]
# ///
"""
Quick structural validation for OpenCode skills.

Validates that SKILL.md exists, has valid YAML frontmatter, declares the
required fields (name, description), the name matches the directory, and all
locally referenced bundled files exist on disk. Size checks are advisory
warnings.

Usage:
    uv run scripts/quick_validate.py <skill_directory>

Returns exit code 0 on success, 1 on failure. Outputs JSON with validation
results.
"""

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import yaml

MAX_SKILL_CHARS = 20_000

LOCAL_FILE_REFERENCE_RE = re.compile(
    r"(?<![A-Za-z0-9_./-])"
    r"((?:references|scripts|assets)/[A-Za-z0-9][A-Za-z0-9._/-]*\.[A-Za-z0-9]+)"
    r"(?![A-Za-z0-9_./-])"
)


@dataclass(slots=True, frozen=True)
class ValidationResult:
    valid: bool
    errors: tuple[str, ...]
    warnings: tuple[str, ...]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate the structural requirements for an OpenCode skill.",
    )
    parser.add_argument(
        "skill_directory", help="Path to the skill directory to validate"
    )
    return parser.parse_args(argv)


def find_local_file_references(text: str) -> list[str]:
    seen: set[str] = set()
    refs: list[str] = []
    for match in LOCAL_FILE_REFERENCE_RE.finditer(text):
        ref = match.group(1)
        if ref not in seen:
            seen.add(ref)
            refs.append(ref)
    return refs


def validate_skill(skill_path: Path) -> ValidationResult:
    errors: list[str] = []
    warnings: list[str] = []

    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        return ValidationResult(
            valid=False, errors=("SKILL.md not found",), warnings=()
        )

    content = skill_md.read_text()

    if not content.startswith("---"):
        return ValidationResult(
            valid=False,
            errors=("No YAML frontmatter found (file must start with ---)",),
            warnings=(),
        )

    match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
    if not match:
        return ValidationResult(
            valid=False,
            errors=("Invalid frontmatter format (missing closing ---)",),
            warnings=(),
        )

    frontmatter_text = match.group(1)
    try:
        frontmatter = yaml.safe_load(frontmatter_text)
        if not isinstance(frontmatter, dict):
            return ValidationResult(
                valid=False,
                errors=("Frontmatter must be a YAML mapping",),
                warnings=(),
            )
    except yaml.YAMLError as exc:
        return ValidationResult(
            valid=False,
            errors=(f"Invalid YAML in frontmatter: {exc}",),
            warnings=(),
        )

    if any(not isinstance(k, str) or not k.strip() for k in frontmatter):
        errors.append("Frontmatter keys must be non-empty strings")

    if "name" not in frontmatter:
        errors.append("Missing required field: name")
    else:
        name = frontmatter["name"]
        if not isinstance(name, str):
            errors.append(f"name must be a string, got {type(name).__name__}")
        else:
            name = name.strip()
            if not name:
                errors.append("name must not be empty")
            elif name != skill_path.name:
                errors.append(
                    f"name '{name}' does not match directory name '{skill_path.name}'"
                )

    if "description" not in frontmatter:
        errors.append("Missing required field: description")
    else:
        description = frontmatter["description"]
        if not isinstance(description, str):
            errors.append(
                f"description must be a string, got {type(description).__name__}"
            )
        elif not description.strip():
            errors.append("description must not be empty")

    if len(content) > MAX_SKILL_CHARS:
        warnings.append(
            f"SKILL.md is {len(content)} characters (recommended max {MAX_SKILL_CHARS}). "
            "Consider moving optional detail to references/."
        )

    for rel_path in find_local_file_references(content):
        target = skill_path / rel_path
        if not target.exists():
            errors.append(f"Referenced file not found: {rel_path}")
        elif not target.is_file():
            errors.append(f"Referenced path is not a file: {rel_path}")

    return ValidationResult(
        valid=len(errors) == 0,
        errors=tuple(errors),
        warnings=tuple(warnings),
    )


def main() -> None:
    args = parse_args(sys.argv[1:])
    skill_path = Path(args.skill_directory).resolve()

    if not skill_path.is_dir():
        print(
            json.dumps(
                {
                    "valid": False,
                    "errors": [f"Not a directory: {skill_path}"],
                    "warnings": [],
                }
            )
        )
        sys.exit(1)

    result = validate_skill(skill_path)
    print(
        json.dumps(
            {
                "valid": result.valid,
                "errors": list(result.errors),
                "warnings": list(result.warnings),
            },
            indent=2,
        )
    )
    sys.exit(0 if result.valid else 1)


if __name__ == "__main__":
    main()
