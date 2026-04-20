---
name: openclaw-docs-mintlify
description: Mintlify linking + anchor conventions for OpenClaw docs. Activates automatically when editing docs/**.
paths:
  - "docs/**/*.md"
  - "docs/**/*.mdx"
---

# OpenClaw Docs — Mintlify Rules

## Internal links

Root-relative. No `.md`/`.mdx` suffix.

- Good: `[Config](/configuration)`
- Bad: `[Config](./configuration.md)`, `[Config](configuration.md)`

## Anchor links

Use anchors on root-relative paths:

- Good: `[Hooks](/configuration#hooks)`

## Headings and anchors

- Avoid em dashes in headings — they break Mintlify anchor generation.
- Avoid apostrophes in headings for the same reason.

## Service/provider lists

Order alphabetically unless the section explicitly describes runtime behavior (auto-detection, execution order).

## When Peter asks for links

Reply with full `https://docs.openclaw.ai/...` URLs, not root-relative.

## When touching docs

End the reply with the `https://docs.openclaw.ai/...` URLs referenced.

## README (GitHub)

Absolute URLs only (`https://docs.openclaw.ai/...`) — root-relative links don't work on GitHub rendering.

## Placeholders

Use generic placeholders: `user@gateway-host`, "gateway host". No personal device names, hostnames, or paths.
