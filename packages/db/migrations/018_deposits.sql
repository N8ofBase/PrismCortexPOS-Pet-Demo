-- Deposits for grooming: asked for when booking online (or by staff), paid through a
-- payment link (Square, simulated in the demo), applied at the register, refunded on an
-- in-time cancel and kept as a no-show fee when the store says so.

ALTER TABLE businesses ADD COLUMN deposit_rule text NOT NULL DEFAULT 'new'
  CHECK (deposit_rule IN ('off', 'all', 'new'));
ALTER TABLE businesses ADD COLUMN deposit_hold_minutes integer NOT NULL DEFAULT 15
  CHECK (deposit_hold_minutes IN (10, 15, 30));
ALTER TABLE businesses ADD COLUMN deposit_no_show text NOT NULL DEFAULT 'keep'
  CHECK (deposit_no_show IN ('keep', 'refund'));

CREATE TABLE deposits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  appointment_id  uuid NOT NULL,
  customer_id     uuid,
  amount_cents    integer NOT NULL CHECK (amount_cents > 0),
  -- Given back so far: all of it on a refund, the part a sale didn't need when applied.
  refunded_cents  integer NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0 AND refunded_cents <= amount_cents),
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'applied', 'refunded', 'kept', 'expired', 'canceled')),
  provider        text NOT NULL DEFAULT 'square' CHECK (provider IN ('square')),
  -- Square's payment link id and, once paid, its payment id. No card data.
  link_id         text,
  link_url        text,
  provider_ref    text,
  refund_ref      text,
  paid_at         timestamptz,
  applied_sale_id uuid,
  kept_sale_id    uuid,
  refunded_at     timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deposits_business_id_id UNIQUE (business_id, id),
  FOREIGN KEY (business_id, appointment_id) REFERENCES appointments (business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id) ON DELETE SET NULL (customer_id),
  FOREIGN KEY (business_id, applied_sale_id) REFERENCES sales (business_id, id) ON DELETE SET NULL (applied_sale_id),
  FOREIGN KEY (business_id, kept_sale_id) REFERENCES sales (business_id, id) ON DELETE SET NULL (kept_sale_id)
);
-- At most one live deposit per appointment.
CREATE UNIQUE INDEX deposits_one_live ON deposits (appointment_id)
  WHERE status IN ('pending', 'paid', 'applied', 'kept');
CREATE INDEX deposits_paid_at ON deposits (business_id, paid_at);
CREATE TRIGGER deposits_updated_at BEFORE UPDATE ON deposits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposits FORCE ROW LEVEL SECURITY;
CREATE POLICY deposits_own ON deposits
  USING (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());

-- A held appointment keeps its time while the customer pays the deposit.
ALTER TABLE appointments DROP CONSTRAINT appointments_status_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
  CHECK (status IN ('held', 'booked', 'checked_in', 'in_progress', 'ready', 'done', 'no_show', 'canceled'));
ALTER TABLE appointments ADD COLUMN hold_expires_at timestamptz;
ALTER TABLE appointments ADD CONSTRAINT appointments_hold CHECK (status <> 'held' OR hold_expires_at IS NOT NULL);
ALTER TABLE appointments RENAME COLUMN deposit_payment_id TO deposit_id;
ALTER TABLE appointments ADD CONSTRAINT appointments_deposit
  FOREIGN KEY (business_id, deposit_id) REFERENCES deposits (business_id, id) ON DELETE SET NULL (deposit_id);

-- A deposit used at the register is a payment on the sale.
ALTER TABLE payments DROP CONSTRAINT payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK (method IN ('card', 'cash', 'deposit'));
ALTER TABLE payments ADD COLUMN deposit_id uuid;
ALTER TABLE payments ADD CONSTRAINT payments_deposit
  FOREIGN KEY (business_id, deposit_id) REFERENCES deposits (business_id, id) ON DELETE SET NULL (deposit_id);
ALTER TABLE refund_payments DROP CONSTRAINT refund_payments_method_check;
ALTER TABLE refund_payments ADD CONSTRAINT refund_payments_method_check
  CHECK (method IN ('card', 'cash', 'deposit'));

-- The sample store asks every online booking for its service's deposit, so the demo shows it.
UPDATE businesses SET deposit_rule = 'all' WHERE is_demo;

-- Staff can text a deposit link (a preview in the demo).
ALTER TABLE appointment_messages DROP CONSTRAINT appointment_messages_kind_check;
ALTER TABLE appointment_messages ADD CONSTRAINT appointment_messages_kind_check
  CHECK (kind IN ('ready', 'moved', 'canceled', 'deposit'));
