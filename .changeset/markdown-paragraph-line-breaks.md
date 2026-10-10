---
"emdash": patch
---

Fixes wrapped paragraphs in Markdown written through the CLI, the MCP content tools or `EmDashClient` being split into one paragraph per line, and `*italic*` staying as plain asterisks. Wrapped lines now join into one paragraph, `*italic*` becomes italic, and a line break inside a paragraph reads back as a backslash at the end of the line, so writing the content back keeps it.
