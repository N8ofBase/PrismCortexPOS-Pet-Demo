# Phase 4 plan: online booking

Status: **4a, 4b and 4c built. Phase 4 is done.**

Built differently from the plan in 4a:
- A wrong sign-in code is returned as a result (`{status: "wrong"}`), not thrown, so the try count is saved; a thrown error would roll it back.
- The public handler for open times is `openTimesFor` in code, registered as `openTimes`.

Spec scope (Phase checklist): public booking page, deposits, email and text reminders, rebook nudges. Spec sections:
- **Online booking (public):**
  - The customer picks a pet, a service, a groomer (or any) and an open slot.
  - New customers sign up by phone or email with a one-time code.
  - Deposits are collected with a Square payment link.
  - Messages: a confirmation, a day-before reminder, and a rebook nudge.
  - Customers can cancel or reschedule up to a cutoff.
- **Roles:** "Customer (public): book grooming online, manage own pets and appointments".
- **Data model:** "block booking when rabies has lapsed".

## What the demo can and can't show

The booking page runs in the same app at `/book`, with its own look and no staff menu.

- **In the demo:** you open it from the staff app (**Open booking page** in Grooming), or from a "Customer view" link on the demo banner. It's the same device and the same sample data, so a booking made there shows up on the grooming calendar straight away. That's the point of the demo.
- **Hosted mode:** customers use it from their own phones, at `<client>.pos.prismcortex.net/book`, with real codes, payments and texts.
- **What the demo fakes:** it can't send a real code by text, take a real deposit or send a real reminder. Those are previews, like the receipts and ready texts:
  - the one-time code appears on screen
  - a simulated payment page stands in for Square
  - messages land in an outbox you can read

Like Phases 2 and 3, it's built in three sessions:

| Session | Delivers |
| --- | --- |
| **4a. Booking page and customer sign-in** (detailed below) | Sign-in with a one-time code, adding pets, picking a service, groomer and open time, booking, and **My appointments** with cancel and reschedule up to the store's cutoff. Online booking settings, and "Booked online" on the staff calendar |
| 4b. Deposits | A deposit for new customers or chosen services, through a Square payment link (simulated in the demo). The deposit comes off the groom at the register; it's refunded on an in-time cancel and kept on a no-show, as the store sets it |
| 4c. Confirmations, reminders and rebook nudges | Booking confirmation, the day-before reminder, and "time for Biscuit's next groom?" after a set number of weeks. Email or text by the customer's choice, opt-out honored, and previews in the demo |

---

## Session 4a: booking page and customer sign-in

When it's done, a customer can:
- open the store's booking page
- sign in with a code sent to their phone or email, or sign up if they're new
- add a pet, or pick one of theirs
- book a groom in a free slot
- see, cancel or reschedule their appointments

The booking lands on the grooming calendar like any other, marked **Booked online**.

### Who the customer is: sign-in with a one-time code

- **Step 1:** "Enter your mobile number or email." The server sends a 6-digit code. In the demo it shows on screen: "In the demo your code is 482913. In the hosted version it's sent by text or email."
- **Step 2:** type the code.
  - **Known customer:** matched by phone, then email, as everywhere else. They're signed in.
  - **New customer:** they enter their name. A customer record is created, and their contact is the phone or email they verified.
- **Session:** stays signed in on that device for 30 days. There's a **Sign out** link.
- **Safety:**
  - **The code:** expires in 10 minutes, allows 5 tries, and is stored only as a hash. One code can be requested a minute, and 5 an hour, per phone or email.
  - **No guessing who's a customer:** a wrong code says nothing about whether the number is already a customer.
  - **Sessions:** stored as a hash too.

### Booking

1. **Pet:** their pets, or **Add a pet** (name, dog / cat / other, breed, size with the weight guide, birthday optional).
2. **Service:** main services marked "Customers can book this online", with add-ons. Prices show for the pet's size ("Full groom · $70.00 · about 2 hours").
3. **Groomer:** a groomer who takes online bookings, or **Any groomer**.
4. **Day:** the next 30 days (store setting), with days that have no openings greyed out.
5. **Time:** open start times, every 30 minutes (store setting).
   - **When a time is open:** the groom and its buffer fit inside a groomer's hours, avoiding their time off and other bookings.
   - **Notice:** nothing sooner than the minimum notice (store setting, default 2 hours).
   - **With "Any groomer":** the time goes to the groomer with the fewest bookings that day, so work is shared.
6. **Review and book:** the pet, service, groomer, day and time, price, and a notes box ("Anything we should know?"). Then **Book**.

**Rules:**
- **Rabies:** a dog or cat whose rabies has lapsed by the appointment day can't book online. "Biscuit's rabies vaccination expired on Aug 16. Please call us at (212) 555-0199 to book." A pet with no rabies date on file can book, with a reminder to bring proof.
- **Double-booking:** the server checks the slot again when **Book** is tapped (the same `checkSlot()` the staff use). The database's double-booking rule has the last word: "Sorry, that time was just taken. Pick another."
- **Prices** come from `quoteAppointment()`, as for staff bookings.

### My appointments

- **The list:** upcoming grooms, with the pet, service, groomer, day, time and price.
- **Cancel / Reschedule:** allowed until the store's cutoff (default 24 hours before).
  - **Reschedule:** goes back through the day and time steps, keeping the pet and service.
  - **After the cutoff:** "It's less than 24 hours away. Please call us to change it."
- **Past grooms:** the last few, with **Book again** (same pet and service).
- **My pets:** name, breed and size. Customers can add pets and fix the breed or size. Notes and vaccinations stay staff-only.

### Staff side

- **Calendar:** an online booking shows a small **Online** tag on the calendar block and in the appointment panel ("Booked online by the customer").
- **Settings → Online booking** (owner and manager):
  - **On / off.** When off, the page says "Online booking isn't available. Call us at …"
  - **How far ahead:** 30 days.
  - **Minimum notice:** 2 hours.
  - **Cancel cutoff:** 24 hours.
  - **Times offered every:** 30 minutes.
  - **A short welcome message** for the top of the page.
  - **The store's phone number** to show customers.
- **Groomers:** a "Takes online bookings" tick per groomer, on by default.
- **Services:** the existing "Customers can book this online" tick.

### Keeping customers and staff apart

- **Separate handlers:** customers reach a separate, small set of public handlers through `invokePublic`, never the staff registry. Every public handler works only on the signed-in customer's own pets and appointments.
- **The customer context** carries the business id and customer id. Row-level security still limits every query to the store.
- **What customers never see:** other customers, staff notes, prices other than the menu's, or any staff screen.
- **Hosted mode:** these become their own Lambda behind the public API, with rate limits at API Gateway.

### Database: migration 017_online_booking

| Table / change | Fields |
| --- | --- |
| `businesses` | + booking_enabled (default true in the demo), booking_days_ahead (30), booking_notice_minutes (120), booking_cutoff_hours (24), booking_step_minutes (30), booking_message, public_phone |
| `staff` | + books_online (default true) |
| `appointments` | + source (staff, online), + booked_by_customer |
| `customer_login_codes` | contact (phone or email), code_hash, expires_at, attempts, used_at, created_at |
| `customer_sessions` | customer_id, token_hash, expires_at, last_seen_at, created_at |

As always: business_id, forced row-level security and `(business_id, id)` foreign keys. Codes and sessions are never sent back to the browser, except the session token itself, once.

### Handlers (public, through `invokePublic`)

| Handler | What |
| --- | --- |
| `bookingPage {}` | Store name, logo, welcome message, phone, whether booking is on, online services with prices by size, groomers who take online bookings |
| `requestCode {contact}` | Sends (or in the demo, returns) a code; rate-limited |
| `verifyCode {contact, code, name?}` | Signs in or signs up; returns a session token |
| `signOut {}` | Ends the session |
| `myAccount {}` | The customer's name, pets, upcoming and recent appointments |
| `savePet {…}` | Adds a pet or fixes the breed or size, on their own pets only |
| `openTimes {petId, serviceId, addonIds, staffId?, from, to}` | Open start times by day, from the availability engine |
| `bookOnline {…}` | Books after rechecking the slot and the rabies rule |
| `cancelMine {id}`, `rescheduleMine {id, day, start}` | Allowed up to the cutoff |

Staff handlers: `updateSettings` + online booking settings; `saveGroomer` + takes online bookings.

**Core** (`packages/core/src/booking.ts`):
- `openTimes()`: the availability engine. A pure function of hours, time off, bookings, length, buffer, step, notice and "now".
- `pickGroomer()` for "Any groomer".
- `canChange()` for the cutoff.
- The code and session rules: expiry, tries, rate limits.

### Demo data

The sample store has online booking on. The sample services and both sample groomers are open to it, so you can book right away.

### Tests

- **core:**
  - open times around hours, time off, bookings, buffer and notice
  - "Any groomer" spreading the work
  - the cutoff
  - code expiry and tries
- **api:**
  - **Sign-in:** sign-in and sign-up by phone and by email; a wrong code, an expired code and too many tries; rate limits.
  - **Booking:** open times match what can actually be booked; booking rechecks the slot (two customers, one slot); lapsed rabies refused; only online services and groomers.
  - **Changing:** cancel and reschedule before and after the cutoff.
  - **Privacy:** a customer can't see or change another customer's pets or appointments, or reach any staff handler.
  - **Separation** between businesses.
- **web:**
  - the sign-in steps
  - the booking steps with greyed days and open times
  - the review screen
  - My appointments with the cutoff message
  - the Online tag on the staff calendar

### Out of scope for 4a

- **4b and 4c:** deposits (4b); confirmations, reminders and rebook nudges (4c).
- **Customer-uploaded documents:** proof of vaccination uploads come with hosted mode (S3).
- **Waitlists and repeat bookings:** not planned yet.

---

## Session 4b: deposits

Status: **approved and built.**

Built differently from the plan:
- **Naming:** the deposit rule is `bookingDeposit()`, because `depositFor()` was already the drawer's bank deposit.
- **Partial refunds:** `deposits` also keeps `refunded_cents`. That covers the part a discounted sale didn't need, and lets a voided sale put back exactly what's left.
- **Staff cancel, box unticked:** the deposit is kept as a "Cancellation fee" sale, the same way a no-show fee is.
- **Receipt numbers:** `nextReceiptNumber()` moved to `services/api/src/shared.ts`, since kept deposits use it too.
- **Deposit texts:** `appointment_messages` allows kind `deposit` for the texted link.
- **No-show default:** the store's setting reaches the counter as `me.business.keepDepositOnNoShow`.
- **Test fix:** fixed a time-of-day flake in the 4a cutoff test, which moved a booking to "an hour from now" and could collide with today's demo grooms.

When it's done:
- A customer booking online pays a deposit when the store asks for one. The time is held for them while they pay.
- The deposit comes off the groom at the register automatically.
- Canceling in time refunds it. A no-show keeps it as a no-show fee, or refunds it, as the store chooses.
- Staff can ask for a deposit on a phone booking too.

In the demo, a **simulated Square payment page** stands in for Square, with **Pay** and **Cancel** buttons. It's like the simulated card reader: no card fields, and nothing is charged. Hosted mode swaps in Square Payment Links and Square's webhook. That comes with real Square (2d), behind the same interface.

### When a deposit is asked for

- **The amount:** the service's deposit, which can already be set on each service. Add-ons never carry a deposit. The deposit is never more than the groom's quote.
- **The store's setting,** under Settings → Online booking:
  - **Off**
  - **Every online booking whose service has a deposit**
  - **New customers only:** customers with no finished groom yet. This is the default; the spec says "for new customers or chosen services".
- **Staff bookings** don't need a deposit. Staff can tap **Ask for a deposit** on the appointment (see Staff side).
- The rule is `bookingDeposit({ rule, serviceDepositCents, quoteCents, isNewCustomer })` in `packages/core/src/booking.ts`, used by both the booking page and the server.

### Holding the time while the customer pays

- **On Book:**
  - When a deposit is due, the appointment is saved as **Held** with a `hold_expires_at`. The default hold is 15 minutes, set in Settings.
  - A held booking takes the slot, and the double-booking constraint counts it, so no one else can grab it while the customer pays.
  - The customer goes to the payment page.
- **Paid:**
  - The appointment becomes **Booked** and the deposit is **Paid**.
  - The customer sees "You're booked! $20.00 deposit paid. It comes off the $70.00 at pickup."
- **Canceled payment or closed page:** the booking page shows "Your time is held until 10:15 AM" with **Pay deposit** and **Cancel booking**. My appointments shows the same.
- **Hold runs out:** the appointment is canceled and the time opens up again.
  - `releaseHolds(trx)` runs at the start of open times, booking, moving and loading the calendar, so a run-out hold never blocks anyone. Hosted mode adds a scheduled sweep.
  - If a payment arrives after the hold ran out and the time was taken, the deposit is refunded automatically. The customer sees "Sorry, the hold ran out before your payment came in. Your $20.00 deposit was refunded."

### At the register

- **Applied automatically:** when a groom with a paid deposit goes on a ticket, checkout adds a completed payment "Deposit paid online" (method `deposit`) for the deposit, and the customer pays what's left by card, cash or split.
  - The ticket shows "Deposit paid online −$20.00" and "Due $55.00".
  - The receipt shows the deposit as a payment line.
  - If discounts bring the groom below the deposit, only up to the total is applied. The rest is refunded to the customer's card, and the screen says so.
- **Voiding the sale** puts the deposit back to Paid, so it applies next time. It isn't refunded.
- **Refunding the sale later:** the deposit is part of the money that can be refunded. The refund goes back to the card it came from, through the payment link's refund, and is audited like any other refund.

### Cancel, reschedule and no-show

| What happens | The deposit |
| --- | --- |
| The customer cancels online (only allowed before the cutoff) | Refunded in full, automatically |
| The customer reschedules, or staff move the groom | Stays with the appointment |
| Staff cancel | The panel asks **Refund the $20.00 deposit?**, ticked by default |
| The groomer called out (call-out tool cancels) | Refunded |
| Customer deleted (upcoming grooms are canceled) | Refunded |
| No-show | The panel asks **Keep the $20.00 deposit as a no-show fee?**, ticked when the store's setting is Keep (the default) |

- **A kept deposit becomes a paid sale:** one untaxed line, "No-show fee: Biscuit, Thu Oct 22", paid by the deposit. That way it counts in sales and has a receipt number. If the owner changes their mind, they refund it like any sale.
- **Undo no-show** on a groom whose fee sale was already made says to refund that sale first.
- **Audit:** every deposit refund and keep writes to `audit_log`.

### Staff side

- **Appointment panel:**
  - the deposit line: "Deposit $20.00 paid online Oct 21" / "Waiting for deposit, held until 10:15 AM" / "Deposit refunded" / "Kept as a no-show fee"
  - **Ask for a deposit** on a booked groom with none. It makes a payment link and shows it to copy, with **Text it** (a preview in `appointment_messages`).
  - **Refund deposit**, for managers and owners
- **Calendar:** a paid deposit shows "$" on the block. A held booking is drawn dashed with "Waiting for deposit" and disappears when the hold runs out.
- **Services:** the deposit field loses its "comes with Phase 4" note. The table shows deposits as now.
- **Settings → Online booking:**
  - **Deposits:** Off / Every online booking with a deposit / New customers only
  - **Hold an unpaid booking for:** 10 / 15 / 30 minutes
  - **On a no-show:** Keep the deposit / Refund it
- **End of day and Sales:**
  - New lines: "Online deposits taken", "Deposits used at the register" and "Kept as no-show fees". Counter card and cash stay as they are.
  - Deposits are card money that arrives through Square, not the drawer. `moneyTotals()` reports them separately, so cash counts and counter card totals don't change.

### Database: migration 018_deposits

- **`deposits`:**
  - id, business_id, appointment_id, customer_id, amount_cents
  - status: `pending`, `paid`, `applied`, `refunded`, `kept`, `expired`, `canceled`
  - provider (`square`), link_id, provider_ref (Square's payment id), refund_ref
  - paid_at, applied_sale_id, kept_sale_id, refunded_at, is_demo, timestamps
  - row-level security, `(business_id, id)` foreign keys, and a unique index so an appointment has at most one live deposit
- **`appointments`:**
  - status adds `held`
  - adds `hold_expires_at`
  - `deposit_payment_id` is renamed to `deposit_id`, with a foreign key to `deposits`
- **`payments`:**
  - method adds `deposit`
  - adds `deposit_id`
- **`refund_payments`:** method adds `deposit`.
- **`businesses`:**
  - `deposit_rule`: `off`, `all` or `new`; default `new`
  - `deposit_hold_minutes`: default 15
  - `deposit_no_show`: `keep` or `refund`; default `keep`
- **Demo:**
  - the demo store uses `all`, so the Sample Full groom's $20.00 deposit shows for the sample customer
  - one upcoming demo groom with a paid deposit, added through `once(...)`, so the register shows it applied

### Payment links: `DepositCheckout`

`services/api/src/payments/checkout.ts`, beside the terminal:
- `createLink({ depositId, amountCents, description, returnUrl }) → { linkId, url }`
- `refund(providerRef, amountCents) → { refundRef }`
- **Demo:** `SimulatedCheckout`. Its url is `/book/pay/<depositId>`.
- **Hosted (later):** a Square Payment Links adapter, plus a webhook handler that verifies Square's signature and calls the same `markDepositPaid()`.

No card data touches our code either way.

### Handlers

- **Public** (through `invokePublic`, signed in):
  - **`bookOnline`:** now returns `{ id, deposit: { id, url, amountCents, holdUntil } | null }`.
  - **`payDeposit({ appointmentId })`:** a fresh link for the customer's own held booking.
  - **`depositStatus({ id })`:** for the return page. It's checked against the customer.
  - **`cancelMine`:** refunds the deposit.
  - **`myAccount`:** includes the deposit on each appointment.
  - **`simulateDepositPayment({ depositId, outcome })`:** demo only. It's refused unless the context is demo, like the terminal simulation.
- **Staff:**
  - **`requestDeposit({ appointmentId })`:** makes the link.
  - **`refundDeposit({ id })`:** needs `refunds` permission, and is audited.
  - **`cancelAppointment({ id, refundDeposit })`**
  - **`setAppointmentStatus`** to no_show takes `{ keepDeposit }`.
  - **`startCheckout`:** applies paid deposits for groom lines.
  - **`cancelSale`:** puts deposits back to Paid.
  - **Refunds:** handle the `deposit` method.
  - **Totals:** the new deposit figures.

### Tests

- **Core:**
  - `bookingDeposit` for each rule, new versus returning customers, and capping at the quote
  - applying a deposit larger than a discounted total
- **API:**
  - Booking with a deposit holds the slot. A second customer can't take it. After the hold runs out, it's released and bookable.
  - A payment after the hold ran out and the slot was taken is refunded.
  - Paying flips the appointment to Booked, and paying twice does nothing more.
  - Checkout applies the deposit, and the sale finishes with the rest paid by card or cash.
  - A void puts the deposit back to Paid. A later refund sends the deposit part back through the checkout refund.
  - Canceling in time refunds. Staff cancel with and without a refund. The call-out and customer delete refund.
  - A no-show keep makes a paid no-show fee sale with a receipt number, which counts in `moneyTotals()`. A refund-on-no-show doesn't.
  - Every deposit refund and keep is in `audit_log`.
  - Customers can't see or pay another customer's deposit, and businesses can't see each other's deposits.
  - The demo simulation is refused outside demo.
  - Card and cash totals are unchanged by deposits.
- **Web:**
  - the review step shows the deposit and its terms
  - the payment page's Pay and Cancel
  - the held-booking banner with Pay deposit and Cancel booking
  - the register ticket showing "Deposit paid online" and the amount due
  - the no-show and cancel prompts

### Out of scope for 4b

- **Real Square:** payment links and the webhook come with 2d and hosted mode. The interface is ready.
- **Texts and emails:** the deposit link texted after a phone booking is a preview only. Confirmations and reminders are 4c.
- **Other deposit types:** percentage deposits, charging a card on file for no-shows, and gift cards or store credit.

---

## Session 4c: confirmations, reminders and rebook nudges

Status: **approved and built.**

Built differently from the plan:
- **Unsubscribe token:** it's kept per message (`appointment_messages.unsubscribe_token_hash`), not on the customer, so every emailed link keeps working.
- **Email opt-out:** "All email" sets a new `customers.email_off` flag.
- **The STOP line:** it's added to the first text sent to a number, whatever kind of message that is.
- **The sweep:** it's `sendDueNow` (grooming.view). The demo runs it when the Grooming page opens, on any view, at most every 5 minutes.
- **Old grooms:** a nudge whose due date passed more than 30 days ago is skipped, so a first sweep over imported history doesn't send a flood. Only each pet's latest finished groom counts.
- **Late bookings:** a groom booked after its reminder time gets no reminder; its confirmation covers it.
- **Demo data:** the seeded past groom is Clover's, not Rex's, because Rex has a groom today.

When it's done, the store sends three kinds of messages to customers:
- **Confirmation:** sent when a groom is booked, online or at the counter, and when a held booking's deposit is paid.
- **Reminder:** sent the day before the groom.
- **Rebook nudge:** "Time for Biscuit's next groom?", sent a set number of weeks after a finished groom, when the pet has nothing booked.

Each one goes by text or email, as the customer chooses, and every opt-out is honored. In the demo nothing is really sent: every message lands in an outbox you can read, like the ready texts do now. Hosted mode sends texts through AWS End User Messaging (SMS) and emails through SES, from the same outbox.

### Who gets what, and how

One rule, `channelFor()` in `packages/core/src/messages.ts`, decides the channel for every customer message. The ready, moved and canceled texts from 3c go through it too.

- **Text:** used when the customer has a phone and has opted in to texts (`sms_opt_in`, which is already on the customer).
- **Email:** used when the customer has an email and either prefers email or can't get texts.
- **Nothing:** when neither applies, the message isn't sent. Staff see a note on the appointment: "No reminder: this customer has no text opt-in or email."
- **Preference:** a customer with both a phone and an email picks one. This is the new `contact_pref` column (`text` or `email`), defaulting to text when they've opted in.
- **Turning things off:** a customer can turn off rebook nudges (`nudges_off`) without losing confirmations and reminders. Replying STOP to a text clears `sms_opt_in` in hosted mode. Emailed nudges carry an unsubscribe link.
- **Consent record:** turning on texts records when and where the customer agreed (`sms_opt_in_at`, `sms_opt_in_source`: `counter`, `online` or `import`), for the 10DLC campaign.
- **Change from 3c:** the ready text now honors the opt-in too. Today it goes to any customer with a phone.

### When reminders and nudges go out

Confirmations go out right away. Reminders and nudges are due at a time, so one sweep sends whatever is due: `sendDueMessages(trx, now)`.

- **Reminder:**
  - when: the day before the groom, at the store's reminder time (default 10:00 AM)
  - what it covers: every booked or checked-in groom tomorrow
  - sent once per appointment
- **Rebook nudge:**
  - when: the service's rebook weeks after a finished groom (Full groom 6, Bath & brush 4; a store-wide default when a service has none)
  - who gets it: only pets with no upcoming groom, from customers with nudges on
  - limits: once per finished groom, and never more than one nudge per pet in 14 days
- **Quiet hours:** nothing goes out before 9:00 AM or after 8:00 PM store time. A message due outside those hours waits for the next morning.
- **Safe to run often:** a unique index on `(appointment_id, kind)` for confirmation, reminder and nudge means running the sweep twice never sends twice.
- **Hosted mode:** EventBridge Scheduler runs the sweep every 15 minutes, per business. The sweep itself is the same code.
- **Demo:** there's no background process, so the sweep runs when the grooming calendar or the Messages view opens. **Send due messages now** runs it by hand.

### What they say

The wording joins `appointmentText` in core. Texts are kept under 160 characters where possible, and each ends with the store name and "Reply STOP to opt out" the first time. For example:
- **Confirmation:** "Sample Pet Store: Biscuit's Full groom is booked for Thu Oct 29 at 9:00 AM with Sample Groomer. $20.00 deposit paid. Manage it: petpos…/book"
- **Reminder:** "Sample Pet Store: reminder, Biscuit's groom is tomorrow, Thu Oct 29 at 9:00 AM. Need to change it? Call (212) 555-0199."
- **Nudge:** "Sample Pet Store: it's been 6 weeks since Biscuit's last groom. Book the next one: petpos…/book"

Emails use the same words, with a subject line and a plain HTML layout. A nudge email has the unsubscribe link.

The online booking link in a nudge opens the booking page with the pet and service already picked (`/book?pet=…&service=…`). That reuses the Book again path from 4a.

### Staff side

- **Grooming → Messages** (a new view beside Calendar, Services and Groomers):
  - every customer message: when, to whom, kind, channel, status (Preview in the demo), and the text
  - filters by kind and day
  - **Send due messages now**
- **Appointment panel:**
  - the messages for that groom, as now, with the new kinds
  - "Confirmation sent by text" after booking, or why nothing was sent
- **Booking at the counter:** a **Send a confirmation** checkbox, ticked by default.
- **Customer form:** "Texts" (opted in, with when and where), "Send reminders by: text / email", and "Rebook reminders" on or off.
- **Services:** a **Rebook after (weeks)** field per service. Empty means the store default.
- **Settings → Messages** (owner):
  - confirmations on or off
  - reminders on or off, and the time the day before
  - rebook nudges on or off, and the default weeks
  - the 9:00 AM to 8:00 PM quiet hours, shown but not editable (they follow the law)

### Customer side

- **My account:** a **Messages** tab:
  - text or email
  - texts on or off; turning texts on shows the consent wording and records it
  - rebook reminders on or off
- **Unsubscribe page:** `/book/unsubscribe?t=…` turns off nudges, or all email, without signing in. The token is random, stored hashed, and only good for that customer's message settings.

### Database: migration 019_messages

- **`customers`:**
  - `contact_pref`: `text` or `email`
  - `nudges_off`
  - `sms_opt_in_at` and `sms_opt_in_source`
  - `unsubscribe_token_hash`
- **`businesses`:**
  - `confirm_on`
  - `remind_on` and `remind_time` (default 10:00)
  - `nudge_on` and `nudge_weeks` (default 6)
- **`services`:** `rebook_weeks`; the demo sets Full groom to 6 and Bath & brush to 4.
- **`appointment_messages`:**
  - the channel can be `email`
  - adds `subject` and `due_at`
  - kinds add `confirm`, `reminder` and `nudge`
  - a unique index on `(appointment_id, kind)` for `confirm`, `reminder` and `nudge`
- **Demo data,** added through `once(...)`:
  - Rex has a finished Bath & brush 5 weeks ago and nothing booked, so a nudge is due
  - one groom is booked for tomorrow, so a reminder is due

### Handlers

- **Shared:** `sendDueMessages()` and `notify()` in `services/api/src/messages.ts`. Every customer message goes through `notify()`.
- **Messenger interface:** `services/api/src/messaging/outbox.ts` (`PreviewMessenger` in the demo; SES and SMS adapters later, in hosted mode).
- **Staff handlers:**
  - **`listMessages({ from, to, kind })`**
  - **`sendDueNow()`:** owner or manager only, and demo only in the UI
  - **`saveMessageSettings`**
  - Booking takes `confirm`.
  - **`saveCustomer`** takes the new preferences and records consent.
- **Public handlers:**
  - **`myMessageSettings`** and **`saveMyMessageSettings`**
  - **`unsubscribe({ token, what })`:** this one doesn't need a sign-in.

### Tests

- **Core:**
  - `channelFor()` for each mix of phone, email, opt-in and preference
  - quiet hours, including a reminder due at 8:30 PM waiting until 9:00 AM
  - when each reminder and nudge falls due
  - message wording and length
- **API:**
  - Booking sends one confirmation by the customer's channel. A held booking confirms only once paid.
  - The sweep sends tomorrow's reminders once, even when run twice. Canceled and no-show grooms get none.
  - Nudges respect rebook weeks, the pet's upcoming grooms, `nudges_off` and the 14-day limit.
  - Opted-out customers get no texts, and the ready text now honors the opt-in.
  - Unsubscribe tokens work for their own customer only.
  - Separation tests: another customer and another business can't see these messages.
- **Web:**
  - the Messages view and Send due messages now
  - the customer form preferences and the My account Messages tab
  - the Send a confirmation checkbox

### Out of scope for 4c

- **Real sending:** SES, 10DLC SMS and the STOP webhook come with hosted mode. The outbox and the messenger interface are ready for them.
- **Editable message wording:** the wording is fixed for now.
- **Two-way texting:** a staff inbox for replies isn't planned.
- **Marketing blasts:** messages to all customers aren't planned.
