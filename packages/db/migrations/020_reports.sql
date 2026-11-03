-- Reports (Phase 5a): the category each line sold under, the weekly Astro check,
-- indexes for report ranges, and removing the sample sales history.

-- The product's category at the time of sale, so moving a product to another
-- category later doesn't move its past sales. Grooms are "Grooming"; kept deposits
-- (no-show and cancellation fees) are "Fees".
ALTER TABLE sale_lines ADD COLUMN category text;

-- Lines sold before this migration can only take today's category: the best there is.
UPDATE sale_lines l SET category = CASE
    WHEN l.appointment_id IS NOT NULL THEN 'Grooming'
    WHEN l.product_id IS NOT NULL THEN (SELECT p.category FROM products p WHERE p.id = l.product_id)
    WHEN EXISTS (SELECT 1 FROM deposits d WHERE d.kept_sale_id = l.sale_id) THEN 'Fees'
    ELSE NULL
  END;

-- Staff look up a few customers in the Astro portal each week and record what Astro
-- shows next to the local balance, to catch drift. Append-only.
CREATE TABLE astro_checks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  customer_id   uuid NOT NULL,
  program_id    uuid NOT NULL,
  local_balance integer NOT NULL,
  -- What the Astro portal shows; null when staff tapped "Matches".
  astro_balance integer CHECK (astro_balance IS NULL OR astro_balance >= 0),
  matches       boolean NOT NULL,
  staff_id      uuid,
  is_demo       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT astro_checks_result CHECK (
    (astro_balance IS NULL AND matches) OR (astro_balance IS NOT NULL AND matches = (astro_balance = local_balance))),
  FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, program_id) REFERENCES astro_programs (business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, staff_id) REFERENCES staff (business_id, id) ON DELETE SET NULL (staff_id)
);
CREATE INDEX astro_checks_recent ON astro_checks (business_id, created_at DESC);
ALTER TABLE astro_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE astro_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY astro_checks_own ON astro_checks
  USING (business_id = current_business_id())
  WITH CHECK (business_id = current_business_id());
REVOKE UPDATE, DELETE ON astro_checks FROM pos_app;

-- Report ranges.
CREATE INDEX IF NOT EXISTS sales_report ON sales (business_id, created_at) WHERE source = 'register' AND status = 'paid';
CREATE INDEX IF NOT EXISTS payments_completed ON payments (business_id, completed_at) WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS refunds_recent ON refunds (business_id, created_at);
CREATE INDEX IF NOT EXISTS astro_punches_recent ON astro_punches (business_id, created_at);

-- "Remove demo data": the app role can't delete sales, so this removes only the
-- sample sales history (is_demo) in the current business, with everything under it
-- (lines, discounts, payments, refunds, queue rows). Sample punches and stock moves
-- are removed by the caller with their customers and products.
CREATE FUNCTION remove_demo_sales() RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
DECLARE
  n integer;
BEGIN
  DELETE FROM astro_checks WHERE is_demo AND business_id = current_business_id();
  DELETE FROM sales WHERE is_demo AND business_id = current_business_id();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
