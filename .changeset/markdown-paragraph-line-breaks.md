---
"emdash": patch
---

Fixes Markdown sent to rich text fields through `emdash content create`, `emdash content update`, the MCP content tools or `EmDashClient` turning every line break into a new paragraph and leaving `*italic*` as plain asterisks. Lines wrapped inside a paragraph now join with a space, a line that ends in two spaces or a backslash keeps its line break, and `*italic*` becomes italic like `_italic_`.
