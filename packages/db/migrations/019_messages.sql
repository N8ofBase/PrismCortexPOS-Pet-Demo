-- Messages to customers: booking confirmations, the day-before reminder and rebook
-- nudges, by text or email as the customer prefers. Demo mode only previews them.

ALTER TABLE customers ADD COLUMN contact_pref text CHECK (contact_pref IS NULL OR contact_pref IN ('text', 'email'));
ALTER TABLE customers ADD COLUMN nudges_off boolean NOT NULL DEFAULT false;
-- When and where the customer agreed to texts (for the 10DLC campaign record).
ALTER TABLE customers ADD COLUMN sms_opt_in_at timestamptz;
ALTER TABLE customers ADD COLUMN sms_opt_in_source text
  CHECK (sms_opt_in_source IS NULL OR sms_opt_in_source IN ('counter', 'online', 'import'));
-- Unsubscribed from all email (the link in a nudge email).
ALTER TABLE customers ADD COLUMN email_off boolean NOT NULL DEFAULT false;

ALTER TABLE businesses ADD COLUMN confirm_on boolean NOT NULL DEFAULT true;
ALTER TABLE businesses ADD COLUMN remind_on boolean NOT NULL DEFAULT true;
-- Minutes after midnight, the day before the groom.
ALTER TABLE businesses ADD COLUMN remind_minute integer NOT NULL DEFAULT 600
  CHECK (remind_minute BETWEEN 540 AND 1200);
ALTER TABLE businesses ADD COLUMN nudge_on boolean NOT NULL DEFAULT true;
ALTER TABLE businesses ADD COLUMN nudge_weeks integer NOT NULL DEFAULT 6 CHECK (nudge_weeks BETWEEN 1 AND 52);

ALTER TABLE services ADD COLUMN rebook_weeks integer CHECK (rebook_weeks IS NULL OR rebook_weeks BETWEEN 1 AND 52);

ALTER TABLE appointment_messages DROP CONSTRAINT appointment_messages_kind_check;
ALTER TABLE appointment_messages ADD CONSTRAINT appointment_messages_kind_check
  CHECK (kind IN ('ready', 'moved', 'canceled', 'deposit', 'confirm', 'reminder', 'nudge'));
ALTER TABLE appointment_messages DROP CONSTRAINT appointment_messages_channel_check;
ALTER TABLE appointment_messages ADD CONSTRAINT appointment_messages_channel_check
  CHECK (channel IN ('sms', 'email'));
ALTER TABLE appointment_messages DROP CONSTRAINT appointment_messages_body_check;
ALTER TABLE appointment_messages ADD CONSTRAINT appointment_messages_body_check CHECK (length(body) <= 4000);
ALTER TABLE appointment_messages ADD COLUMN subject text;
-- The unsubscribe link in a nudge email. Only a hash is kept.
ALTER TABLE appointment_messages ADD COLUMN unsubscribe_token_hash text UNIQUE;
-- Confirmation, reminder and nudge go once per appointment, however often the sweep runs.
CREATE UNIQUE INDEX appointment_messages_once ON appointment_messages (appointment_id, kind)
  WHERE kind IN ('confirm', 'reminder', 'nudge');
CREATE INDEX appointment_messages_recent ON appointment_messages (business_id, created_at DESC);

-- The sample menu's rebook weeks.
UPDATE services SET rebook_weeks = 6 WHERE is_demo AND name = 'Sample Full groom (DEMO)';
UPDATE services SET rebook_weeks = 4 WHERE is_demo AND name = 'Sample Bath & brush (DEMO)';
