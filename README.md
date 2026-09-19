# Insider Buy Scanner

Nightly scan of SEC EDGAR for large insider / 5%-holder buying.

- **Form 4**: open-market purchases (code P) by officers, directors, 10% owners. Shows avg price paid, shares, trade dates.
- **Schedule 13D / 13D/A**: 5%+ holders, with recent trade prices parsed best-effort from the filing text.
- Site (index.html) has a date picker and a minimum-size box (default $10M).

## Setup
1. Repo Settings -> Secrets and variables -> Actions -> Variables: add `SEC_USER_AGENT` = `Your Name your@email.com` (SEC requires contact info).
2. Settings -> Pages -> Deploy from branch `main` / root.
3. Actions -> "Nightly insider scan" -> Run workflow (enter a date to backfill any day). It also runs automatically Tue-Sat 03:30 UTC.

Local run: `SEC_USER_AGENT="Name you@email.com" node scripts/scan.mjs 2026-09-18`
