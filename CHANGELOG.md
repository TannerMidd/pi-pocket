# Changelog

## 0.20.0 (unreleased)

### For extension authors

- Added experimental `WebRequest.conversations.list({ rootsOnly?, includeArchived? }?)` for read-only, request-lifetime discovery of authorized session metadata. Ordinary extension route access rules remain unchanged. It excludes PiP, hides inaccessible origin ids, checks fresh access, and performs no durable writes or model work. Both options default to false. The core catalogue does not list subagents.
- Added experimental `pocket.Conversation` with `{ conversationId: number, draft?: string, title?: string, onClose?: () => void }` for the native conversation view. Drafts are never sent automatically. Normal server authorization still applies.
- These additions are planned for 0.20.0, not released 0.19.0. Feature-detect them. The extension API version remains 2.
