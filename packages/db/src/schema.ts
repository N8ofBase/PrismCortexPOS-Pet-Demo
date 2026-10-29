// Kysely table types. Keep in step with migrations/.
import type { ColumnType, Generated, Selectable } from "kysely";
import type { Role } from "@pet-pos/core";

type CreatedAt = Generated<Date>;
type UpdatedAt = Generated<Date>;
/** jsonb: read as an object, written as a JSON string. */
type Json<T> = ColumnType<T, string | undefined, string>;

export interface BusinessesTable {
  id: Generated<string>;
  name: string;
  slug: string;
  brand_color: string | null;
  logo_key: string | null;
  /** data:image/… URL, demo mode only (hosted uses logo_key in S3). */
  logo_data: string | null;
  modules: Json<Record<string, boolean>>;
  /** Spec open question: Astro offers and rewards come off before tax (true) or after. */
  astro_discounts_before_tax: Generated<boolean>;
  /** Managers can refund up to this without an owner's OK. */
  refund_approval_cents: Generated<number>;
  /** Starting cash left in the drawer each morning. */
  drawer_float_cents: Generated<number>;
  /** Charge sales tax on grooming. */
  grooming_taxable: Generated<boolean>;
  /** Text the customer when their pet is ready for pickup. */
  text_when_ready: Generated<boolean>;
  booking_enabled: Generated<boolean>;
  booking_days_ahead: Generated<number>;
  booking_notice_minutes: Generated<number>;
  booking_cutoff_hours: Generated<number>;
  booking_step_minutes: Generated<number>;
  booking_message: string | null;
  /** 10 digits, shown to customers. */
  public_phone: string | null;
  deposit_rule: Generated<DepositRule>;
  deposit_hold_minutes: Generated<number>;
  deposit_no_show: Generated<"keep" | "refund">;
  confirm_on: Generated<boolean>;
  remind_on: Generated<boolean>;
  /** Minutes after midnight, the day before. */
  remind_minute: Generated<number>;
  nudge_on: Generated<boolean>;
  nudge_weeks: Generated<number>;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface LocationsTable {
  id: Generated<string>;
  business_id: string;
  name: string;
  timezone: Generated<string>;
  /** Thousandths of a percent: 8.875% = 8875. */
  tax_rate_mpct: Generated<number>;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface StaffTable {
  id: Generated<string>;
  business_id: string;
  name: string;
  email: string | null;
  role: Role;
  cognito_sub: string | null;
  active: Generated<boolean>;
  /** Shows on the grooming calendar. True for the Groomer role. */
  grooms: Generated<boolean>;
  /** Takes online bookings. */
  books_online: Generated<boolean>;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface AstroProgramsTable {
  id: Generated<string>;
  business_id: string;
  name: string;
  brand: string | null;
  buy_count: number;
  reward_text: Generated<string>;
  astro_program_ref: string | null;
  active: Generated<boolean>;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface ProductsTable {
  id: Generated<string>;
  business_id: string;
  sku: string;
  barcode: string | null;
  name: string;
  brand: string | null;
  category: Generated<string>;
  price_cents: number;
  cost_cents: Generated<number>;
  tax_class: Generated<TaxClass>;
  reorder_at: Generated<number>;
  astro_program_id: string | null;
  astro_offer_label: string | null;
  astro_offer_cents: number | null;
  /** Used in grooming, not sold: hidden from the register. */
  back_bar: Generated<boolean>;
  /** "oz", "each"; null means each. */
  unit: string | null;
  active: Generated<boolean>;
  import_batch_id: string | null;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface InventoryLevelsTable {
  business_id: string;
  product_id: string;
  location_id: string;
  on_hand: Generated<number>;
  back_bar_on_hand: Generated<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface InventoryMovesTable {
  id: Generated<string>;
  business_id: string;
  product_id: string;
  location_id: string;
  qty_change: number;
  reason: MoveReason;
  ref_id: string | null;
  staff_id: string | null;
  note: string | null;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
}

export interface AuditLogTable {
  id: Generated<string>;
  business_id: string;
  staff_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  before: Json<Record<string, unknown>> | null;
  after: Json<Record<string, unknown>> | null;
  created_at: CreatedAt;
}

/** Postgres date, kept as "YYYY-MM-DD" (see parsers.ts). */
type DateString = string;

export interface CustomersTable {
  id: Generated<string>;
  business_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  birthday: DateString | null;
  sms_opt_in: Generated<boolean>;
  contact_pref: "text" | "email" | null;
  nudges_off: Generated<boolean>;
  sms_opt_in_at: Date | null;
  sms_opt_in_source: "counter" | "online" | "import" | null;
  email_off: Generated<boolean>;
  notes: string | null;
  astro_customer_id: string | null;
  import_batch_id: string | null;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export type Species = "dog" | "cat" | "other";
export type PetSize = "S" | "M" | "L" | "XL";

export interface PetsTable {
  id: Generated<string>;
  business_id: string;
  customer_id: string;
  name: string;
  species: Generated<Species>;
  breed: string | null;
  size: PetSize | null;
  coat: string | null;
  birthday: DateString | null;
  weight_lb: number | null;
  temperament: string | null;
  allergies: string | null;
  vet_name: string | null;
  import_batch_id: string | null;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface VaccinationsTable {
  id: Generated<string>;
  business_id: string;
  pet_id: string;
  vaccine: string;
  expires_on: DateString;
  proof_file_key: string | null;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export type PunchKind = "earn" | "redeem" | "opening_balance" | "refund_reversal" | "reward_return";

export interface AstroPunchesTable {
  id: Generated<string>;
  business_id: string;
  customer_id: string;
  program_id: string;
  sale_id: string | null;
  refund_id: string | null;
  qty: number;
  kind: PunchKind;
  import_batch_id: string | null;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
}

export interface AstroBalancesView {
  business_id: string;
  customer_id: string;
  program_id: string;
  balance: number;
}

export interface BusinessCountersTable {
  business_id: string;
  name: string;
  value: number;
}

export interface DiscountsTable {
  id: Generated<string>;
  business_id: string;
  name: string;
  code: string | null;
  kind: "percent" | "fixed";
  percent_mpct: number | null;
  amount_cents: number | null;
  scope: Generated<"ticket" | "line">;
  cash_only: Generated<boolean>;
  needs_approval: Generated<boolean>;
  ask_note: Generated<boolean>;
  combinable: Generated<boolean>;
  active: Generated<boolean>;
  archived_at: Date | null;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export type SaleStatus = "open" | "paid" | "canceled";

export interface SalesTable {
  id: Generated<string>;
  business_id: string;
  location_id: string;
  customer_id: string | null;
  staff_id: string | null;
  /** Null for imported orders. */
  receipt_number: number | null;
  status: Generated<SaleStatus>;
  source: Generated<"register" | "import">;
  subtotal_cents: number;
  discount_cents: Generated<number>;
  tax_cents: Generated<number>;
  total_cents: number;
  tax_rate_mpct: number;
  discounts_before_tax: boolean;
  paid_at: Date | null;
  canceled_at: Date | null;
  refunded_cents: Generated<number>;
  /** Imported orders: the old receipt number, or "date:YYYY-MM-DD". */
  import_key: string | null;
  import_batch_id: string | null;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface SaleLinesTable {
  id: Generated<string>;
  business_id: string;
  sale_id: string;
  position: number;
  product_id: string | null;
  appointment_id: string | null;
  name: string;
  sku: string | null;
  barcode: string | null;
  tax_class: TaxClass;
  qty: number;
  unit_price_cents: number;
  discount_cents: Generated<number>;
  line_total_cents: number;
  astro_program_id: string | null;
  earns_punches: Generated<number>;
  /** The line's share of the sale's tax; null for sales rung before migration 012. */
  tax_cents: number | null;
  created_at: CreatedAt;
}

export type SaleDiscountSource = "store" | "astro_offer" | "astro_reward";

export interface SaleDiscountsTable {
  id: Generated<string>;
  business_id: string;
  sale_id: string;
  sale_line_id: string | null;
  source: SaleDiscountSource;
  discount_id: string | null;
  name: string;
  kind: "percent" | "fixed" | null;
  percent_mpct: number | null;
  amount_cents: number;
  note: string | null;
  applied_by: string | null;
  approved_by: string | null;
  created_at: CreatedAt;
}

export type PaymentStatus = "pending" | "completed" | "declined" | "canceled" | "refunded";

export type PaymentMethod = "card" | "cash" | "deposit";

export interface PaymentsTable {
  id: Generated<string>;
  business_id: string;
  sale_id: string;
  method: PaymentMethod;
  provider: "square" | "cash";
  provider_ref: string | null;
  status: PaymentStatus;
  amount_cents: number;
  tendered_cents: number | null;
  change_cents: Generated<number>;
  refunded_cents: Generated<number>;
  staff_id: string | null;
  completed_at: Date | null;
  deposit_id: string | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface AstroQueueTable {
  id: Generated<string>;
  business_id: string;
  sale_id: string;
  kind: Generated<"sale" | "refund">;
  refund_id: string | null;
  payload: Json<Record<string, unknown>>;
  status: Generated<"pending" | "entered" | "sent" | "failed">;
  attempts: Generated<number>;
  error: string | null;
  entered_by: string | null;
  entered_at: Date | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export type RefundReason = "damaged" | "wrong_item" | "changed_mind" | "price_adjustment" | "other";

export interface RefundsTable {
  id: Generated<string>;
  business_id: string;
  sale_id: string;
  staff_id: string | null;
  approved_by: string | null;
  reason: RefundReason;
  note: string | null;
  restock: boolean;
  amount_cents: number;
  tax_cents: number;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
}

export interface RefundLinesTable {
  id: Generated<string>;
  business_id: string;
  refund_id: string;
  sale_line_id: string;
  qty: number;
  amount_cents: number;
  tax_cents: number;
}

export interface RefundPaymentsTable {
  id: Generated<string>;
  business_id: string;
  refund_id: string;
  payment_id: string;
  method: PaymentMethod;
  amount_cents: number;
  provider_ref: string | null;
}

export interface ReceiptOutboxTable {
  id: Generated<string>;
  business_id: string;
  sale_id: string;
  channel: "email" | "sms";
  to_address: string;
  subject: string | null;
  body: string;
  status: Generated<"preview" | "queued" | "sent" | "failed">;
  created_by: string | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export type ImportType = "customers" | "pets" | "products" | "programs" | "punches" | "orders";
export type ImportEntity =
  "customer" | "pet" | "vaccination" | "product" | "program" | "punch" | "stock" | "sale";

export type AppointmentStatus =
  "held" | "booked" | "checked_in" | "in_progress" | "ready" | "done" | "no_show" | "canceled";

export interface ServicesTable {
  id: Generated<string>;
  business_id: string;
  name: string;
  kind: "main" | "addon";
  description: string | null;
  price_s_cents: number;
  price_m_cents: number;
  price_l_cents: number;
  price_xl_cents: number;
  minutes_s: number;
  minutes_m: number;
  minutes_l: number;
  minutes_xl: number;
  buffer_minutes: Generated<number>;
  deposit_cents: Generated<number>;
  rebook_weeks: number | null;
  online: Generated<boolean>;
  active: Generated<boolean>;
  archived_at: Date | null;
  position: Generated<number>;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface GroomerHoursTable {
  id: Generated<string>;
  business_id: string;
  staff_id: string;
  weekday: number;
  /** "09:00:00" */
  start_time: string;
  end_time: string;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface TimeOffTable {
  id: Generated<string>;
  business_id: string;
  staff_id: string;
  starts_at: Date;
  ends_at: Date;
  note: string | null;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface AppointmentsTable {
  id: Generated<string>;
  business_id: string;
  location_id: string;
  customer_id: string | null;
  pet_id: string | null;
  staff_id: string;
  service_id: string;
  service_name: string;
  pet_name: string;
  size: PetSize;
  starts_at: Date;
  ends_at: Date;
  block_ends_at: Date;
  status: Generated<AppointmentStatus>;
  price_cents: number;
  notes: string | null;
  created_by: string | null;
  checked_in_at: Date | null;
  started_at: Date | null;
  ready_at: Date | null;
  done_at: Date | null;
  canceled_at: Date | null;
  sale_id: string | null;
  deposit_id: string | null;
  hold_expires_at: Date | null;
  supplies_used_at: Date | null;
  source: Generated<"staff" | "online">;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface ServiceSuppliesTable {
  id: Generated<string>;
  business_id: string;
  service_id: string;
  product_id: string;
  qty_s: number;
  qty_m: number;
  qty_l: number;
  qty_xl: number;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface GroomingNotesTable {
  id: Generated<string>;
  business_id: string;
  pet_id: string;
  appointment_id: string | null;
  staff_id: string | null;
  note: string;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
}

export interface GroomingPhotosTable {
  id: Generated<string>;
  business_id: string;
  note_id: string;
  kind: "before" | "after";
  image_data: string | null;
  storage_key: string | null;
  width: number;
  height: number;
  bytes: number;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
}

export interface CustomerLoginCodesTable {
  id: Generated<string>;
  business_id: string;
  contact: string;
  code_hash: string;
  expires_at: Date;
  attempts: Generated<number>;
  used_at: Date | null;
  created_at: CreatedAt;
}

export interface CustomerSessionsTable {
  id: Generated<string>;
  business_id: string;
  customer_id: string;
  token_hash: string;
  expires_at: Date;
  last_seen_at: Generated<Date>;
  created_at: CreatedAt;
}

export type DepositRule = "off" | "all" | "new";
export type DepositStatus = "pending" | "paid" | "applied" | "refunded" | "kept" | "expired" | "canceled";

export interface DepositsTable {
  id: Generated<string>;
  business_id: string;
  appointment_id: string;
  customer_id: string | null;
  amount_cents: number;
  refunded_cents: Generated<number>;
  status: Generated<DepositStatus>;
  provider: Generated<"square">;
  link_id: string | null;
  link_url: string | null;
  provider_ref: string | null;
  refund_ref: string | null;
  paid_at: Date | null;
  applied_sale_id: string | null;
  kept_sale_id: string | null;
  refunded_at: Date | null;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export type MessageKind = "ready" | "moved" | "canceled" | "deposit" | "confirm" | "reminder" | "nudge";

export interface AppointmentMessagesTable {
  id: Generated<string>;
  business_id: string;
  appointment_id: string;
  kind: MessageKind;
  channel: Generated<"sms" | "email">;
  to_address: string;
  subject: string | null;
  unsubscribe_token_hash: string | null;
  body: string;
  status: Generated<"preview" | "queued" | "sent" | "failed">;
  created_by: string | null;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
}

export interface AppointmentAddonsTable {
  id: Generated<string>;
  business_id: string;
  appointment_id: string;
  service_id: string;
  name: string;
  price_cents: number;
  minutes: number;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
}

export interface DrawerCountsTable {
  id: Generated<string>;
  business_id: string;
  location_id: string;
  business_date: string;
  staff_id: string | null;
  starting_cents: number;
  cash_in_cents: number;
  cash_out_cents: number;
  expected_cents: number;
  counted_cents: number;
  over_short_cents: number;
  card_cents: number;
  denominations: Json<Record<string, number>> | null;
  note: string | null;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
}
export type ImportOp = "created" | "updated" | "deleted" | "moved";

export interface ImportBatchesTable {
  id: Generated<string>;
  business_id: string;
  type: ImportType;
  file_name: string;
  staff_id: string | null;
  status: Generated<"running" | "done" | "undone">;
  total_rows: Generated<number>;
  created: Generated<number>;
  updated: Generated<number>;
  skipped: Generated<number>;
  is_demo: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  finished_at: Date | null;
  undone_at: Date | null;
}

export interface ImportChangesTable {
  id: Generated<string>;
  business_id: string;
  batch_id: string;
  seq: Generated<string>;
  entity: ImportEntity;
  entity_id: string;
  op: ImportOp;
  before: Json<Record<string, unknown>> | null;
  after: Json<Record<string, unknown>> | null;
  created_at: CreatedAt;
}

export interface DemoSeedPartsTable {
  business_id: string;
  part: string;
  seeded_at: Generated<Date>;
}

export type TaxClass = "standard" | "exempt";
export type MoveReason = "sale" | "receive" | "adjust" | "consume" | "return";

export interface DB {
  businesses: BusinessesTable;
  locations: LocationsTable;
  staff: StaffTable;
  astro_programs: AstroProgramsTable;
  products: ProductsTable;
  inventory_levels: InventoryLevelsTable;
  inventory_moves: InventoryMovesTable;
  audit_log: AuditLogTable;
  customers: CustomersTable;
  pets: PetsTable;
  vaccinations: VaccinationsTable;
  astro_punches: AstroPunchesTable;
  astro_balances: AstroBalancesView;
  demo_seed_parts: DemoSeedPartsTable;
  import_batches: ImportBatchesTable;
  import_changes: ImportChangesTable;
  business_counters: BusinessCountersTable;
  discounts: DiscountsTable;
  sales: SalesTable;
  sale_lines: SaleLinesTable;
  sale_discounts: SaleDiscountsTable;
  payments: PaymentsTable;
  astro_queue: AstroQueueTable;
  refunds: RefundsTable;
  refund_lines: RefundLinesTable;
  refund_payments: RefundPaymentsTable;
  receipt_outbox: ReceiptOutboxTable;
  drawer_counts: DrawerCountsTable;
  services: ServicesTable;
  groomer_hours: GroomerHoursTable;
  time_off: TimeOffTable;
  appointments: AppointmentsTable;
  appointment_addons: AppointmentAddonsTable;
  service_supplies: ServiceSuppliesTable;
  grooming_notes: GroomingNotesTable;
  grooming_photos: GroomingPhotosTable;
  appointment_messages: AppointmentMessagesTable;
  customer_login_codes: CustomerLoginCodesTable;
  customer_sessions: CustomerSessionsTable;
  deposits: DepositsTable;
}

export type Business = Selectable<BusinessesTable>;
export type Location = Selectable<LocationsTable>;
export type Staff = Selectable<StaffTable>;
export type Product = Selectable<ProductsTable>;
export type AstroProgram = Selectable<AstroProgramsTable>;
