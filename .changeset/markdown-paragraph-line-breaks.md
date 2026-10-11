---
"emdash": patch
---

Fixes Markdown written to rich text fields through the CLI, the MCP content tools or `EmDashClient` turning each wrapped line into its own paragraph and leaving `*italic*` as plain asterisks.

Wrapped lines now join into one paragraph and `*italic*` becomes italics, while underscores inside words, as in `my_var_name`, stay as typed. Reading rich text as Markdown now escapes characters such as `*` and `_` and ends each line inside a paragraph with a backslash, so a paragraph written back keeps its text and line breaks.

#### What should I do?

If you separate paragraphs with a single newline, put a blank line between them. To keep a line break inside a paragraph, end the line with two spaces or a backslash.
