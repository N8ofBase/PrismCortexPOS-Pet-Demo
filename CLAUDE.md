# Pet store POS & grooming system

Point of sale, inventory, customers and pets, grooming calendar and online booking, and Astro Loyalty tracking for one independent pet store, built by PrismCortex so it can host several local businesses (and a second location per business) later.

- Full spec: `docs/SPEC.md` (export of the "Pet Store POS & Grooming System Spec" doc). Read the section for the feature you are working on before writing code.
- Working prototype: `docs/prototype.html`. It is the reference for screens, wording and behavior. Match its flows; do not copy its code structure (it is a single-file demo).
- Current phase plan: `docs/plans/phase-1-foundation.md`. Its approved decisions override the spec where they differ.

## Stack

- Front end: React + TypeScript (Vite), one app with staff routes and public booking routes. PWA for the counter tablet.
- Two run modes, same code:
  - **Demo mode (now):** handlers run in a Web Worker against PGlite (Postgres in the browser, saved to IndexedDB). Role picker instead of sign-in. Static site at `https://petpos-demo.prismcortex.net`.
  - **Hosted mode (Phase 1f, on hold):** API Gateway HTTP API + Lambda (Node.js 24) running the same handlers against RDS Postgres.
- Handlers are plain functions `(ctx, input)` in `services/api/src/handlers`, sharing a data layer in `packages/core`. `ctx` carries business id, staff id and role.
- Database: Postgres (PGlite in demo and tests, RDS in hosted). Migrations live in `packages/db/migrations`. Kysely for queries, no ORM.
- Auth (hosted): Cognito user pool with groups `owner`, `manager`, `cashier`, `groomer` and a `business_id` claim. Customers sign in with a one-time code.
- Payments: Square Terminal API (server-driven, Square Terminal device) at the counter, Square Payment Links (Checkout API) for booking deposits, Square webhooks into Lambda (verify the signature). Square Reader does not work from a web app; don't use it. Test in the Square Sandbox. Each business connects its own Square account via OAuth.
- Background work: EventBridge Scheduler (reminders), SQS (Astro sends, webhooks).
- Infrastructure: AWS CDK in TypeScript, region `us-east-1`. Stacks: `DemoSite` (S3 + CloudFront + Route 53 record), later `PetPos-dev` and `PetPos-prod`. Never deploy to `prod` unless asked.
- DNS: the `prismcortex.net` hosted zone already serves the PrismCortex website. Only add records; never change or delete existing ones. Clients will live at `<client>.pos.prismcortex.net`.
- Node 24 LTS locally. npm workspaces, Vitest.

## Rules

- Several businesses share one database: every table has `business_id`, and row-level security limits every query to `current_setting('app.business_id')`. Never query without it set.
- Money is always integer cents. Never use floats for money.
- Never store card numbers or card data. Square holds them; we store Square ids and amounts.
- Phone numbers are stored normalized to 10 digits; format only for display. Customers match on phone, then email.
- Appointments use a Postgres exclusion constraint on `(staff_id, tstzrange(starts_at, ends_at + buffer))` so a groomer can't be double-booked.
- Every refund, void, price change and customer delete writes to `audit_log`. A customer-delete entry keeps id, name and counts only, no contact details.
- Destructive actions (delete customer, remove demo data) need a typed "delete" confirmation in the UI.
- Sample data is marked "(DEMO)" in names and has `is_demo = true`; the remove-demo-data action deletes only those rows.
- Astro: all calls go through `AstroClient` in `packages/core/astro`. Until credentials exist, sales with Astro activity go to the `astro_queue` table for manual entry. Credentials live in Secrets Manager only. Astro is an optional module per business.
- Secrets never go in code, the browser bundle or the repo. The demo build contains no secrets at all.

## Working style

- One feature per session. Plan first (files, tables, endpoints), wait for approval, then build with tests.
- Write tests for money math, tax, Astro punch logic, booking overlap, import matching and separation between businesses.
- Keep UI copy plain and specific, as in the prototype.

## Commands

- `npm run dev` — web app in demo mode at http://localhost:5173
- `npm test` — all unit and database tests (Vitest; database tests use in-memory PGlite)
- `npm run lint` / `npm run typecheck` / `npm run format`
- `npm run build:demo` — static demo build in `apps/web/dist`
- `npm run deploy:demo` — build and deploy to https://petpos-demo.prismcortex.net (DemoSite stack)

AWS: sign in with `aws sso login --profile prismcortex` (Identity Center user PC_Dev). The AWS CLI takes `--profile prismcortex`. The CDK CLI can't read the `[sso-session]` config, so before `cdk` commands load short-lived credentials into the shell: `aws configure export-credentials --profile prismcortex --format powershell | Invoke-Expression` (never print or save them).

## Layout

- `packages/core` — money, phone, roles and permissions, `Ctx`, `AppError`. No database code.
- `packages/db` — `migrations/*.sql`, `migrate`, Kysely schema types, the PGlite dialect, `withBusiness`, demo seed.
- `services/api` — handlers `(trx, ctx, input)` and the `invoke` registry. Add new handlers to `src/registry.ts`.
- `apps/web` — React app. `src/demo/` runs PGlite in a worker; `src/api/client.ts` is the only way screens reach handlers.
- `infra` — CDK app (`DemoSite` now).
- New tables: a numbered migration with `business_id`, `is_demo`, row-level security enabled and forced, a policy on `current_business_id()`, and an `updated_at` trigger. Add the Kysely type in `schema.ts`. Use `(business_id, id)` foreign keys so rows can't point across businesses. Append-only tables: `REVOKE UPDATE, DELETE … FROM pos_app`.
- Migrations are loaded with `import.meta.glob`, which Vite caches: after adding a migration file, restart `npm run dev`, and delete `node_modules/.vitest-cache` if tests don't see the new table.
- Editing files from Windows PowerShell 5.1: `Get-Content` reads UTF-8 as Windows-1252 and corrupts "·", "—", "…". Use the editor tools, or `[IO.File]::ReadAllText(path, [Text.UTF8Encoding]::new($false))`. `services/api/test/encoding.test.ts` catches it.
- Camera scanning: `barcode-detector` and `zxing-wasm` must be the same build (`apps/web/test/scannerVersions.test.ts` checks it). Upgrade both together.
- Card payments go through `PaymentTerminal` (`services/api/src/payments/terminal.ts`). Demo mode uses `SimulatedTerminal`; never put a Square access token in the browser.
- Prices and totals come only from `priceSale()` in `packages/core/src/sale.ts`. The server reruns it at checkout; never trust totals from the browser.
- Refund amounts come only from `refundLine()` in `packages/core/src/refund.ts` (running totals of what was paid per line, paid units first). `refundPreview` and `refundSale` share `planRefund()`, so the screen shows exactly what happens.
- The receipt text (printed, on screen, emailed, texted) is built once in `packages/core/src/receipt.ts`.
- Day totals (Sales KPIs and end of day) come only from `moneyTotals()` in `services/api/src/handlers/totals.ts`. Imported orders (`sales.source = 'import'`) have no receipt number or payments and never count there; register queries filter `source = 'register'`.
- Grooming prices and minutes come only from `quoteAppointment()` in `packages/core/src/grooming.ts`; `bookAppointment` reprices on the server. Status steps and who may take them are `nextSteps()` / `canStep()` there.
- A groom on the register is a ticket line with `appointmentId` (no product). The server prices it from the appointment and marks the appointment done when the sale is paid. Back-bar supplies come off stock through `useSupplies()` / `returnSupplies()` in `services/api/src/handlers/supplies.ts`, once per groom.
- Booking, moving and the call-out all check a slot with `checkSlot()` in `services/api/src/handlers/grooming.ts` (hours, time off and rabies are warnings; another booking is a clash). Texts to customers go to `appointment_messages` (preview in the demo); their wording is `appointmentText` in core.
- Every PGlite instance takes `PGLITE_OPTIONS` (parsers plus the `btree_gist` extension the appointments exclusion constraint needs). A new `new PGlite()` without it can't run migration 014.
- Shell edits: template backticks inside `node -e "..."` break in bash and PowerShell. Use the editor tools or a script file in the scratchpad.
- Customer-facing calls go through `invokePublic` and the `publicHandlers` registry in `services/api/src/public/`, never `invoke`: the customer id comes from the session token, not the input. Open times come only from `openTimes()` / `pickGroomer()` in `packages/core/src/booking.ts`, and online bookings still go through `checkSlot()` and the exclusion constraint.
- Deposits go through `services/api/src/deposits.ts` (hold release, paid, refund, keep as a fee sale, apply at checkout) and payment links through `DepositCheckout` in `services/api/src/payments/checkout.ts`. A held online booking (`status = 'held'`) blocks its slot until `hold_expires_at`; `releaseHolds()` runs in `loadDay()` and `checkSlot()`. A deposit used at the register is a payment with method `deposit`; `moneyTotals()` keeps it out of counter card and cash.
- Every message to a customer goes through `notify()` in `services/api/src/messages.ts`. It picks text or email with `channelFor()` in `packages/core/src/messages.ts`, honors opt-outs, and sends confirmation, reminder, nudge and ready once per appointment. Reminders and nudges go out from `sendDueMessages()`, which waits out quiet hours (9:00 AM to 8:00 PM). `appointment_messages` is append-only; tests that need to backdate rows use `db` directly.
- New demo data: add a part to `ensureDemo` in `packages/db/seed/demo.ts` through `once(...)`, so existing demo browsers get it once.
