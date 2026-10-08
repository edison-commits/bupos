# Environment and configuration ownership

This reference records configuration **names and owners only**. It intentionally contains no values. Never copy values from local `.env*` files, CI logs, deployed Worker configuration, or historical documents into source control.

## Application runtime

| Name | Owner / consumer | Classification |
|---|---|---|
| `DATABASE_URL` | `src/lib/db/`, migration/test scripts, deploy workflow | secret connection string; required for PostgreSQL paths |
| `USE_POSTGRES` | persistence adapters and register/admin actions | non-secret mode switch |
| `BUPOS_ORG_ID` | customer signup/display routes; synchronized by deploy workflow | server-only deployed configuration |
| `BUPOS_LOCATION_ID` | centralized env module; synchronized by deploy workflow | server-only deployed configuration |
| `CUSTOMER_DISPLAY_SECRET` | display-token and device-cookie auth | Worker secret |
| `DEV_DISPLAY_SECRET` | local display-token/device fallback | local-only secret; never production |
| `CHANNEL_ENC_KEY` | commerce-channel credential encryption | Worker secret |
| `DEV_CHANNEL_ENC_KEY` | local channel encryption fallback | local-only secret; never production |
| `CHANNEL_PROVIDER_MOCK` | channel provider selection | local/test mode switch |
| `TRUST_FORWARDED_FOR` | client-IP resolution | deployment trust-policy flag |
| `APP_URL` | auth action URL generation | server runtime URL |
| `NEXT_PUBLIC_APP_URL` | customer-display signup URL | public build/runtime URL |
| `SUPABASE_URL` | middleware CSP connection target | server runtime URL |
| `NEXT_PUBLIC_SUPABASE_URL` | middleware CSP fallback | public URL, not a credential |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | deploy workflow compatibility input | public build input; no active normal DB client ownership is documented |
| `NODE_ENV` | Next.js/runtime behavior | toolchain-owned runtime mode |

## Email, reporting, and internal operations

| Name | Owner / consumer | Classification |
|---|---|---|
| `RESEND_API_KEY` | verification, employee, receipt, and report email senders | Worker secret |
| `RESEND_FROM_EMAIL` | verification, employee, and receipt email senders | sender configuration |
| `EOD_REPORT_EMAIL` | end-of-day report delivery | recipient configuration |
| `EOD_REPORT_FROM` | end-of-day report sender | sender configuration |
| `OPS_CLEANUP_SECRET` | manual internal cleanup endpoint | Worker secret |
| `CHANNEL_RECONCILE_SECRET` | channel reconcile endpoint and scheduled workflow | shared HMAC secret in Worker and GitHub Actions |
| `SALES_DIGEST_SECRET` | sales-digest endpoint and scheduled workflow | shared HMAC secret in Worker and GitHub Actions |

## CI, deploy, monitoring, and desktop

| Name | Owner / consumer | Classification |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | deploy workflow and Wrangler | GitHub Actions secret |
| `CLOUDFLARE_ACCOUNT_ID` | deploy workflow and Wrangler | GitHub Actions secret/configuration |
| `SMOKE_ADMIN_EMAIL` | production smoke script | GitHub Actions secret |
| `SMOKE_ADMIN_PASSWORD` | production smoke script | GitHub Actions secret |
| `SMOKE_EMPLOYEE_PIN` | production smoke script | optional GitHub Actions secret |
| `TELEGRAM_BOT_TOKEN` | deploy, health, and reconcile notifications | GitHub Actions secret |
| `ANTHROPIC_API_KEY` | pre-merge audit script/workflow | optional GitHub Actions secret |
| `PROD_DATABASE_URL` | production drift checker | secret read target |
| `REFERENCE_DATABASE_URL` | production drift checker | reference database connection |
| `BASE_REF` | pre-merge audit script | Git reference configuration |
| `BASE_URL` | smoke and local-stress scripts | target URL |
| `BUPOS_BASE_URL` | Electron shell | desktop runtime URL override |

The desktop build workflow also recognizes the electron-builder signing names `CSC_LINK` and `CSC_KEY_PASSWORD`; they are optional repository secrets and are owned by the desktop release process.

## Test, guardrail, seed, and simulation controls

These names are owned by the named scripts/tests, not by normal application startup:

- Test and guardrail paths: `BUPOS_SELFTEST_MIG_DIR`, `BUPOS_SELFTEST_SRC_DIR`, `PLAYWRIGHT_PORT`, `CI`.
- Destructive-operation acknowledgements: `E2E_SETUP_FORCE`, `RESET_DB_FORCE`, `SEED_ADV_FORCE`, `SEED_PG_FORCE`, `SIMULATE_FORCE`, `TEST_ADV_FORCE`.
- Load/simulation targets and sizing: `BUPOS_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `CASHIER_PIN`, `MANAGER_PIN`, `PIN`, `MAYA_RSID`, `DAYS`, `DELAY_MS`, `SALES_MIN`, `SALES_MAX`, `TAX_RATE`, `TOTAL_TXNS`, `CONCURRENCY`.

Simulation and force flags can target or mutate data. Read the owning script and its safety checks before setting them; never infer a safe target from the variable name alone.

## Non-environment configuration owners

| Concern | Source of truth |
|---|---|
| npm commands and dependency versions | `package.json` and `package-lock.json` |
| TypeScript / Next.js / OpenNext | `tsconfig.json`, `next.config.ts`, `open-next.config.ts` |
| Cloudflare Worker, KV, assets, compatibility | `wrangler.jsonc` |
| public landing Worker | `landing/wrangler.jsonc` and `landing/worker.js` |
| local PostgreSQL service | `docker-compose.yml` |
| database schema | ordered files in `supabase/migrations/` |
| unit/integration/e2e runners | `vitest.config.ts`, `vitest.integration.config.ts`, `playwright.config.ts` |
| lint and Worker-safety policy | `eslint.config.mjs`, `eslint-rules/`, `scripts/check-*.mjs` |
| CI and production deployment | root `.github/workflows/` |
| desktop packaging | `../desktop/package.json` and root desktop workflow |

## Where authorized users set values

- Local development: untracked shell environment or an untracked `.env.local` under `code/`.
- Cloudflare runtime: Wrangler secrets or reviewed non-secret Worker configuration.
- GitHub Actions: repository/environment secrets and variables referenced by the owning workflow.
- Desktop: the local desktop settings file or `BUPOS_BASE_URL` override.

Do not commit `.env*` files. When adding a name, update this reference and the owning source/config in the same change; do not add example secret values.
