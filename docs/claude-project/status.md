# Pet store POS: status

Updated 2026-11-03. Code: `github.com/N8ofBase/PrismCortexPOS-Pet-Demo` (branch `main`). Demo: https://petpos-demo.prismcortex.net, with the customer booking page at `/book`.

## How it runs today

- **Demo mode only.** The whole system runs in the browser. Postgres (PGlite) is saved on that device, and a role picker stands in for sign-in. Each device has its own copy of the sample data, and "Reset demo" starts it over.
- **Simulated pieces:**
  - **Card reader:** Approve, Decline or Customer canceled buttons.
  - **Square payment page for deposits:** Pay and Cancel buttons, and no card fields.
  - **Texts and emails:** saved as previews, and nothing is sent.
  - **Sign-in codes:** the one-time code is shown on screen.
- **Hosted mode** (AWS Lambda, RDS, Cognito, real Square, SES and SMS) is planned but on hold. The same code will run there.

## Built

| Phase | What the store gets |
| --- | --- |
| 1 | Products and inventory, customers and pets, bulk import from the old system, store settings, staff roles, demo data with a "remove demo data" action |
| 2a | The register: cash with change, card (simulated) and split payments, store discounts, Astro punches, rewards and offers, receipts, camera barcode scanning |
| 2b | Sales history and search, refunds (card first, then cash; stock and punches put right; owner approval above the manager limit), receipts by email or text, the "To enter in Astro" queue |
| 2c | End of day: drawer count, card total, over or short, bank deposit; past orders imported; order history on the customer |
| 3a | Grooming: menu priced by pet size, groomer hours and time off, day calendar, booking with warnings (hours, time off, lapsed rabies), no double-booking, status flow, My day on the groomer's phone |
| 3b | Checking out a groom at the register, grooming tax setting, grooming notes with photos, history per pet, back-bar supplies used per service |
| 3c | Week view, drag to reschedule with Undo, groomer call-out tool, ready-for-pickup text, grooming revenue by groomer |
| 4a | Online booking page: sign in with a one-time code; pick pet, service, groomer and time; cancel or reschedule up to the cutoff |
| 4b | Deposits on online bookings: time held while paying, applied at the register, refunded on an in-time cancel, kept as a fee on a no-show (store's choice) |
| 4c | Confirmations, the day-before reminder and rebook reminders, by text or email as the customer chooses; opt-outs, quiet hours (9 AM to 8 PM), Grooming → Messages |

Not built:
- **2d:** real Square, deliberately deferred.
- **Phase 5:** purchase orders, reports and the live Astro API.

## Decisions worth knowing

- **Payments:** Square Terminal at the counter. Square Reader doesn't work from a web app. Deposits use Square Payment Links. Each store connects its own Square account.
- **Astro:** Astro only gives API access to approved partners. Until then, sales with Astro activity go to a queue for manual entry.
- **Deposits:**
  - **Rule:** the amount is set per service. The store chooses who pays one: off, every online booking, or new customers only (the default).
  - **Held bookings:** a held online booking keeps its time for 10, 15 or 30 minutes while the customer pays.
  - **No-shows:** a kept deposit becomes a "No-show fee" (or "Cancellation fee") sale with a receipt, so it shows in sales and can be refunded.
  - **Totals:** deposits are counted apart from counter card and cash.
- **Messages:**
  - **Texts:** only to customers who agreed. Where and when they agreed is recorded for the 10DLC registration.
  - **Ready text:** since 4c, the ready-for-pickup text needs that agreement too.
  - **Rebook reminders:** these go out after the service's weeks (Full groom 6, Bath 4) when nothing is booked, at most one per pet every 14 days. Emails carry an unsubscribe link.
- **Several stores later:** one database, every row tagged with its store, and the database itself keeps stores apart. Clients will live at `<client>.pos.prismcortex.net`.

## Open items and next steps

- **Week-one tasks from the spec, before hosting:**
  - ask Astro about partner API access
  - start 10DLC text registration (a few weeks for carrier approval)
  - order a Square Terminal
- **Hosted mode:** AWS stacks, Cognito sign-in, RDS, real Square (2d), SES email and SMS with STOP handling, and a scheduled message sweep.
- **Phase 5:** purchase orders, reports, live Astro API.
- **Possible:** an accounting export (QuickBooks or CSV). It came up and isn't planned yet.
- **Before going live** (spec checklist):
  - 50 test sales in the Square Sandbox
  - an offline and cash-only plan
  - daily backups with a monthly restore test
  - CloudWatch alarms
  - one-page staff training per role
