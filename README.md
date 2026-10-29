# Pet store POS & grooming system

Register, inventory, customers and pets, grooming calendar and booking, and Astro Loyalty tracking for an independent pet store.

- `docs/SPEC.md` — the full spec (exported from the spec doc)
- `docs/prototype.html` — working prototype; open it in a browser to see the screens and flows
- `CLAUDE.md` — instructions Claude Code reads at the start of every session

Status: **Phases 1, 2 (except 2d, real Square) and 3 are done** in demo mode.
- Phase 1: products and inventory, customers and pets, bulk import, store settings, staff and demo data.
- Phase 2a, the register: cash, simulated card reader and split payments, store discounts, Astro punches, rewards and offers, receipts, and camera barcode scanning.
- Phase 2b: sales history by day and search, refunds (card first, then cash, with stock and Astro punches put right and owner approval above the manager limit), receipts by email or text (previewed in the demo), and the "To enter in Astro" queue.

- Phase 2c: end of day (drawer count by denomination, card total, over/short and deposit), past orders imported from the old system, and order history on the customer profile.

- Phase 3a, grooming: the service menu by pet size, groomer hours and time off, a day calendar per groomer, booking with a quote and warnings (outside hours, time off, lapsed rabies), double-booking refused by the database, the status flow to ready for pickup, and a phone-friendly My day for groomers.

- Phase 3b: checking out a groom at the register next to retail items (grooming tax as a store setting), grooming notes with before/after photos and a grooming history per pet, and back-bar supplies used per service.

- Phase 3c: a week view, drag to reschedule with Undo, moving a groomer's day when they call out, the ready-for-pickup text (previewed in the demo), and grooming revenue by groomer on the Sales page.

- Phase 4a: an online booking page at `/book` (sign-in with a one-time code, pick a pet, service, groomer and open time, see, cancel or reschedule up to a cutoff), online bookings tagged on the staff calendar, and Online booking settings.

- Phase 4b: deposits on online bookings, through a payment link (a simulated Square page in the demo).
  - The time is held while the customer pays.
  - The deposit comes off the groom at the register.
  - It's refunded on an in-time cancel, and kept as a fee on a no-show as the store chooses.
  - Staff can ask for a deposit on phone bookings.

- Phase 4c: messages to customers about their grooms.
  - Booking confirmations, the day-before reminder, and rebook reminders a set number of weeks after a groom.
  - Each goes by text or email as the customer chooses, with opt-outs and quiet hours honored.
  - They show in Grooming → Messages; previews only in the demo.

The demo is live at https://petpos-demo.prismcortex.net (booking page: https://petpos-demo.prismcortex.net/book). Phase 4 is done.

## Run it

```
npm install
npm run dev      # http://localhost:5173, demo mode
npm test
```

See `CLAUDE.md` for all commands and the repo layout.
