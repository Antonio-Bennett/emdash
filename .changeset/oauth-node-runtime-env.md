---
"emdash": patch
---

Fixes OAuth sign-in on Node adapters so provider credentials (`EMDASH_OAUTH_*` and provider `*_CLIENT_ID`, `*_CLIENT_SECRET`, and `*_TENANT_ID` values) are read from the runtime environment instead of only the values present at build time.
