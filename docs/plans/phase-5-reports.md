# Phase 5 plan: reports, purchase orders and live Astro

Status: **5a planned 2026-11-03, waiting for approval.** 5b and 5c not started.

Spec scope (Phase checklist): purchase orders, reports, live Astro API. Spec sections:
- **Reports:** "Daily sales by payment type and category, grooming revenue by groomer"; "Low stock and reorder list, inventory value at cost"; "Astro: punches earned, rewards and offers redeemed, queue backlog"; "No-shows and rebooking rate".
- **Astro Loyalty → Now:** "A weekly report compares local punch balances with Astro for a few customers to catch drift."
- **Inventory:** "Receive stock by scanning items or from a purchase order" (5b).

The prototype has no reports screen, so the layout follows the Sales page: a date picker at the top, KPI tiles, then tables.

| Session | Delivers | Needs |
| --- | --- | --- |
| **5a. Reports** (detailed below) | A Reports page with Sales, Grooming, Stock and Astro tabs, any date range, and a CSV download for every table | Nothing outside the project |
| 5b. Purchase orders | Vendors, a reorder list that becomes a purchase order, receiving against it by scanning, cost updates from what was paid | Nothing outside the project |
| 5c. Live Astro API | `AstroClient` sends queue rows, retries, and falls back to the manual queue | Partner access from Astro, and hosted mode (credentials live in Secrets Manager) |

---

## Session 5a: reports

When it's done:
- **The owner or a manager opens Reports** from the sidebar and picks a range: Today, Yesterday, This week, Last week, This month, Last month, or two dates. The range stays the same as they switch tabs.
- **Sales:** money in by payment type, sales by category, and a day-by-day table.
- **Grooming:** revenue by groomer, how many grooms, no-shows, and how many pets were booked again.
- **Stock:** what's low or out, what to reorder, and what the stock on the shelf cost.
- **Astro:** punches earned, rewards and offers used, how far behind the "To enter in Astro" queue is, and a short weekly check against Astro's own numbers.
- **Every table downloads as a CSV**, which opens in Excel or Google Sheets.

### What the demo can and can't show

- **In the demo:** everything above works on the sample data. Today the sample data has only a handful of sales, so 5a adds about six weeks of sample sales and grooms (see Demo data) to give the reports something to show.
- **What's different in hosted mode:** nothing on these screens. The same handlers run against RDS. The card total is still what the system recorded; checking it against Square's own report comes with 2d.
- **Not in the demo:** emailing a report on a schedule. That needs SES and a scheduler, so it waits for hosted mode.

### Who

New permission `reports.view`: owners and managers, the same people who see Sales. The Stock tab shows costs, so cashiers and groomers don't get it. It's a one-line change if the store wants managers kept off it.

### Range and days

- **Business day:** the store's local calendar day, as on the Sales page and at end of day. Ranges are whole days.
- **Longest range:** 13 months, so this year can be compared with the same month last year. Longer ranges are refused with "Pick a range of 13 months or less."
- **Imported orders never count** (CLAUDE.md rule). That money was taken in the old system, and those orders have no payments.

### Sales tab

**Tiles** (straight from `moneyTotals()` for the whole range, so they match the Sales page and end of day to the cent):
- Net sales, Sales count, Average sale (net ÷ count, rounded to the cent), Tax collected, Discounts (store and Astro shown apart), Refunds.

**Money in by payment type:**

| Type | In | Back | Net |
| --- | --- | --- | --- |
| Card (counter) | card payments | card refunds | in − back |
| Cash | cash payments | cash refunds | in − back |
| Deposits paid online | deposits paid | deposits refunded | in − back |

A note under it says that deposits used on a groom are already in the deposit row, so they aren't counted twice.

**Sales by category:** one row per category, then Grooming, then Fees (kept deposits), then "No category". Columns: items sold, sales before tax, refunds, net, and share of the total. The rows add up to the tile's net sales before tax.
- **Which category a sale counts under:** the product's category at the time of the sale, not today's. If the owner moves a product from Treats to Supplies next month, last month's report doesn't change. This needs a new column on sale lines (see Database).

**Day by day:** one row per business day in the range, with sales count, net sales, card, cash, deposits and tax. Each day's row comes from `moneyTotals()` for that day, and a totals row at the bottom comes from the whole range. A test checks that the days add up to the range.

**Top products:** the 20 best sellers in the range by net sales, with quantity sold. One table, no chart.

### Grooming tab

**Tiles:** Grooming revenue, Grooms done, Average groom, No-shows (and the share of booked grooms), Rebooked.

**By groomer:** the existing `groomingTotals()` for the range, with grooms, revenue, average groom and no-shows per groomer.

**By service:** grooms and revenue per service, so the owner can see what sells.

**No-shows:** a list of each no-show in the range (date, pet, customer, groomer, and whether a deposit was kept), so the owner can follow up.

**Rebooking rate:** of the grooms done in the range, how many pets already have their next groom booked.
- **Counts as rebooked:** the same pet has a later groom that isn't canceled or a no-show, starting within the service's rebook weeks plus two weeks (Full groom 6 + 2 = 8 weeks). A service with no rebook weeks uses 8 weeks.
- **Booked before they left:** the share where that next groom was booked on the same day as the groom. This is the habit worth building at the counter, so it gets its own number.
- **Too soon to tell:** a groom whose window hasn't closed yet and isn't rebooked is left out of the rate and counted separately ("12 more still have time"). Otherwise this month's rate would always look bad.
- The rule lives in one function, `rebookStats()` in `packages/core/src/grooming.ts`, so it can be tested on its own.

### Stock tab

This tab is about now, not the date range. The heading says "As of today".

**Tiles:** Stock value at cost, Stock value at retail, Items low, Items out.

**Reorder list:** active products at or below their reorder point, out-of-stock first. Columns: SKU, product, brand, category, on hand, reorder at, sold in the last 30 days, and cost. A product with no cost entered shows "No cost" rather than $0.00 so the value tile isn't quietly wrong; the tile says how many products have no cost. Suggested order amounts come with purchase orders in 5b.

**Value by category:** units on hand, value at cost and value at retail per category. Negative stock (sold before it was received) counts as zero in the value and is flagged in a "Check these counts" list.

Back-bar items show in the reorder list like any product, tagged "Back bar".

### Astro tab

**Tiles:** Punches earned, Rewards redeemed, Offers redeemed (count and dollars), Waiting to enter in Astro (with the oldest one's age).

**By program:** one row per Astro program with punches earned, punches taken back by refunds, rewards redeemed and offer dollars.

**Queue backlog:** pending rows by age: under a day, 1 to 7 days, over a week. Over a week shows in amber with "Enter these in the Astro portal". This links to the existing queue screen.

**Weekly Astro check** (from the spec's Astro section):
- Each week the tab picks five customers with Astro activity in the last 30 days, and lists their local punch balance per program.
- Staff look each one up in the Astro portal and type what Astro shows, or tap **Matches**.
- A mismatch is saved and listed with the difference, so the owner can fix it in one place or the other. Fixing it is a manual step; this screen doesn't change any balances.
- Past checks stay on record. The tile turns amber when no check has been saved for two weeks.

### CSV download

- **Download CSV** on every table. The file is built in the browser from the numbers already on screen, so no extra handler is needed.
- **Money:** written as plain dollars with two decimals ("12.30"), from integer cents with `formatMoney`'s rules, never through floats.
- **File names:** the store, the report and the range, for example `sales-by-category_2026-10-01_2026-10-31.csv`.
- **No contact details** in any CSV. The no-show list shows customer names only.

### Database: migration 020_reports

- **`sale_lines.category text`**: the product's category at the time of sale.
  - Filled at checkout by the server, next to the other copied fields (name, SKU, tax class). Grooming lines get "Grooming". Fee lines get "Fees".
  - Backfilled for existing rows from today's product category, and "Grooming" and "Fees" as above. That's the best that can be done for past sales, and the migration comment says so.
  - Imported order lines are backfilled too, for later use, though they don't count in reports.
- **`astro_checks`**: one row per customer and program checked. Columns: `business_id`, `id`, `customer_id`, `program_id`, `local_balance`, `astro_balance` (null when staff tapped Matches), `matches boolean`, `staff_id`, `is_demo`, `created_at`. Row-level security forced with a policy on `current_business_id()`, `(business_id, …)` foreign keys, and `REVOKE UPDATE, DELETE … FROM pos_app` because it's append-only. Removed with its customer through the existing customer delete (an `ON DELETE CASCADE` on the customer key).
- **Indexes** for the report queries: `sales (business_id, source, status, created_at)`, `payments (business_id, status, completed_at)`, `appointments (business_id, status, starts_at)` where they don't already exist.
- **`remove_demo_sales()`**: a `SECURITY DEFINER` function, like `remove_demo_grooming()`, that deletes sample sales (`is_demo`) with their lines, discounts, payments, refunds, Astro punches and queue rows. The remove-demo-data action calls it. It never touches a sale that isn't marked demo.

### Handlers (`services/api/src/handlers/reports.ts`)

All read-only, all `reports.view`.

| Handler | Input | Returns |
| --- | --- | --- |
| `salesReport` | `from`, `to` | tiles (`moneyTotals`), payment types, categories, days, top products |
| `groomingReport` | `from`, `to` | tiles, by groomer (`groomingTotals`), by service, no-shows, rebook stats |
| `stockReport` | none | tiles, reorder list, value by category, counts to check |
| `astroReport` | `from`, `to` | tiles, by program, backlog by age, this week's check list, past checks |
| `saveAstroCheck` | `customerId`, rows of `programId` and `astroBalance` or "matches" | the saved rows. Needs `astro.edit`, so cashiers can't |

New money code goes beside the old so the numbers can't drift apart:
- **`categoryTotals()`** in `totals.ts`: sales and refunds by category. Refunds use the refunded line's category.
- **`moneyTotals()`** stays the only source for the tiles and the per-day rows.
- **`rebookStats()`** in core does the rebooking rule. The handler only fetches the rows.

The Reports page reaches them through `src/api/client.ts`, as every screen does.

### Demo data

A new `once(…, "sales_history", …)` part in `ensureDemo`:
- **About six weeks of register sales**, 10 to 25 a day, on the sample products, rung through `priceSale()` so tax and discounts are right. They mix card, cash and split payments, some with Astro punches and a few rewards and offers.
- **Two refunds and one void**, through `planRefund()`.
- **About six weeks of grooms on the calendar**, mostly done and paid at the register. Three are no-shows (one with a kept deposit), and some pets have their next groom booked.
- **A few Astro queue rows still pending**, one over a week old, so the backlog shows.
- **One past Astro check** with one mismatch.
- **All of it is marked `is_demo`**, and "Remove demo data" deletes it through `remove_demo_sales()` and `remove_demo_grooming()`.
- **Fixed dates:** the history is placed relative to the day the demo is first opened, so the reports always show recent weeks.

### Screens

- **Sidebar:** "Reports" between Sales and Astro, at `/reports`, with tabs Sales, Grooming, Stock and Astro at `/reports/sales` and so on.
- **Date range bar:** the range is kept in the address (`?from=2026-10-01&to=2026-10-31`), so a report can be bookmarked or shared with another staff member.
- **Tables:** sortable by any column. Money is right-aligned. An empty range says "No sales in this range."
- **The Sales page keeps its own day view.** A "See reports" link sits next to Close the day.
- **Phone width:** the tiles stack and the tables scroll sideways inside their box, so the page itself never scrolls sideways.

### Tests

- **Totals agree:**
  - The Sales tab tiles equal `moneyTotals()` for the same range.
  - The day rows add up to the range totals, for each column.
  - The category rows add up to net sales before tax.
  - The by-groomer rows add up to the Grooming category.
- **Imported orders:** never appear in any report, even on a day that also has register sales.
- **Category at time of sale:** moving a product to another category after a sale doesn't move the sale. A refund counts under the refunded line's category.
- **Refunds and voids:** a refund in this range on last month's sale lowers this range, not last month's. A voided sale counts nowhere.
- **Deposits:** a deposit used at the register isn't counted twice. A kept deposit shows under Fees.
- **Rebooking (`rebookStats()`):**
  - rebooked inside the window
  - booked outside the window
  - the next groom canceled or a no-show
  - booked the same day
  - too soon to tell
  - a service with no rebook weeks
- **Stock:** value at cost and at retail; no-cost products counted and flagged; negative stock counted as zero and listed.
- **Astro:** punches, rewards and offers by program; refund reversals shown apart; backlog buckets by age.
- **Astro check:** five customers are picked from recent activity; a saved check can't be changed or deleted; a cashier can't save one.
- **CSV:** cents to "12.30", "-0.05" and "1234.00" with no float rounding; commas and quotes in names are escaped.
- **Ranges:** business-day edges in the store's time zone; a range over 13 months is refused.
- **Permissions:** a cashier and a groomer get "You don't have permission to do that." on every report handler.
- **Separation between businesses:** with business A set, no report includes business B's sales, stock, grooms or checks.
- **Demo data:** remove-demo-data deletes the sample sales and grooms and leaves a sale the user rang.

### Out of scope for 5a

- Purchase orders and suggested order amounts (5b).
- The live Astro API and automatic balance checks (5c).
- Charts. Tables and tiles first; a simple bar chart can come later if the owner wants one.
- Emailed or scheduled reports (hosted mode).
- A QuickBooks or accounting export. The CSVs cover the simple case; a proper export is its own feature if wanted.
- Comparing with the previous period ("up 8% on last month"). Easy to add later from the same handlers.
- Staff hours, commissions and payroll.
- More than one location. Reports are for the store as a whole; the queries keep `location_id` so a location filter can be added later.

### Decisions to confirm

1. **Category at time of sale** (new column, backfilled from today's categories). The alternative is to always use today's category. That's simpler, but last month's report changes when products move.
2. **Six weeks of sample sales in the demo**, removable with the rest of the demo data. Without it, the reports show almost nothing in the demo.
3. **Rebooked means** the next groom is booked within the service's rebook weeks plus two weeks, with "booked before they left" shown on its own.
4. **The weekly Astro check** is in 5a, since the spec asks for it. It can be dropped to keep the session smaller.
