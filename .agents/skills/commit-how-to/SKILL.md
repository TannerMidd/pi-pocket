---
name: commit-how-to
description: |
  Promotes usage of conventional commit format (feat:, fix:, docs:, style:, refactor:, test:, chore:)
  with scope and BREAKING CHANGE notes for maintainable, readable git history.
---

Use this convention when committing code:

**Format:** `<type>: <scope>(optional): <description>`

**Example messages:**
- `feat(auth): add github login`
- `fix(api): resolve null pointer in user endpoint`
- `docs(readme): update installation instructions`

**Types:**
- `feat:` - new feature
- `fix:` - bug fix
- `docs:` - documentation changes
- `style:` - formatting, unused code cleanup
- `refactor:` - code restructuring (no behavior change)
- `test:` - adding/correcting tests
- `chore:` - maintenance tasks

**Rules:**
1. Imperative mood ("add" not "added")
2. Present tense  
3. No period at end
4. BREAKING CHANGE notes go on new line with `BREAKING CHANGE:` prefix