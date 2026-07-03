# Tadabbur — Environments & Workflow

This project has three environments: **dev → staging → production**.

## Overview

| Environment | Site | Backend Worker | Email behaviour |
|---|---|---|---|
| **dev** (local) | `npm run dev` → localhost:4321 | prod Worker (default) | real emails — use test addresses |
| **staging** | Cloudflare Pages preview (`staging` branch) | `tadabbur-tafsir-api-staging` | **safe** — welcome email routes to the owner, tagged `[STAGING]`; never emails a real registrant |
| **production** | https://tadabbur.tarteeb.pro (`main` branch) | `tadabbur-tafsir-api` | real welcome emails to registrants + owner notification |

## Golden rule

**Never push straight to `main` for anything non-trivial.** Test on `staging` first,
confirm it works, then merge `staging → main`.

## Day-to-day flow

1. **Work locally** on the `staging` branch:
   ```
   git checkout staging
   npm run dev            # site at http://localhost:4321
   ```
2. **Push to staging** to see it on a real staging URL:
   ```
   git push origin staging
   ```
   Cloudflare Pages auto-builds the `staging` branch with `npm run build:staging`
   (which points the site at the staging Worker via `.env.staging`).
3. **Test on the staging URL** — signups here are safe (no emails reach real people).
4. **Promote to production** once happy:
   ```
   git checkout main
   git merge staging
   git push origin main   # Cloudflare Pages auto-deploys production
   ```

## Deploying the Worker (backend)

The Worker is deployed separately from the site, from the `worker/` folder:

```
cd worker
npx wrangler deploy               # production Worker
npx wrangler deploy --env staging # staging Worker
```

Secrets are per-environment (set once, persist):
```
npx wrangler secret put RESEND_API_KEY               # production
npx wrangler secret put RESEND_API_KEY --env staging # staging
```

## What makes staging safe

- The staging Worker has `ENVIRONMENT = "staging"` (set in `wrangler.toml`).
- In that mode, `handleSubscribe` sends the welcome email to the **owner**, not the
  registrant, and prefixes subjects with `[STAGING]`. So you can test the signup
  form freely without emailing real users.
- The staging **site** build (`--mode staging`, via `.env.staging`) points
  `PUBLIC_API_BASE` at the staging Worker, so staging never touches the production
  Worker.

## URLs & names (quick reference)

- Production site: https://tadabbur.tarteeb.pro
- Production Worker: https://tadabbur-tafsir-api.amer19hs.workers.dev
- Staging Worker: https://tadabbur-tafsir-api-staging.amer19hs.workers.dev
- Cloudflare Pages project: `tadabbur`
- Email sender: `salam@tarteeb.pro` (verified in Resend)
