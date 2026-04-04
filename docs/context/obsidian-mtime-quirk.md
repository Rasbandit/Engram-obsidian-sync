# Obsidian mtime Quirk

## The Problem

`vault.modify()` sets the file's mtime to "now" — not the mtime you'd expect from the content source. This means you **cannot** use mtime comparison to decide whether to apply a remote change to an existing file.

## Impact on Sync

Conflict detection must happen upstream by comparing both local and remote mtime against `lastSync`. Once past that gate, writes to the vault are unconditional — don't re-check mtime after calling `vault.modify()`.

## Where This Matters

- `applyChange()` in `sync.ts` — applies remote note changes
- `applyAttachmentChange()` in `sync.ts` — applies remote attachment changes
- Any future code that writes to the vault and then reads mtime

## Discovery

Found 2026-03 when remote changes were being silently skipped. The vault.modify() call was updating mtime, which made subsequent mtime checks think the file was already up-to-date.
