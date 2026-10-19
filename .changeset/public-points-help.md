---
"@emdash-cms/cloudflare": patch
---

Fixes sandboxed plugins' `ctx.email.send()` failing to reach the configured host email provider when the sandbox runner and worker bridge are loaded in separate module chunks.
