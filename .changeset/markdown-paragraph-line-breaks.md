---
"emdash": patch
---

Fixes each wrapped line of a Markdown paragraph becoming its own paragraph, and `*italic*` staying as plain asterisks, when Markdown is written to a rich text field through the CLI, the MCP content tools or `EmDashClient`. Lines inside a paragraph now join with a space; end a line with two spaces or a backslash to keep the line break. `~~~` now opens a code block like a backtick fence. Reading rich text as Markdown ends a line break inside a paragraph with a backslash, so writing the content back keeps it.
