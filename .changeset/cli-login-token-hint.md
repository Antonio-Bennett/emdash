---
"emdash": patch
---

Fixes the hint `emdash login` prints when a site does not offer browser sign-in from the CLI, such as a site using Cloudflare Access for authentication. The hint now shows a command that works with an API token, instead of an `emdash --token` command the CLI rejects.
