import { AppError } from "./errors.ts";

export const ROLES = ["owner", "manager", "cashier", "groomer"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  manager: "Manager",
  cashier: "Cashier",
  groomer: "Groomer",
};

// Who can do what (docs/SPEC.md → Roles). Owner can do everything.
const PERMISSIONS = {
  "register.use": ["owner", "manager", "cashier"],
  "products.view": ["owner", "manager", "cashier"],
  "products.edit": ["owner", "manager"],
  "inventory.adjust": ["owner", "manager"],
  "customers.view": ["owner", "manager", "cashier", "groomer"],
  "customers.edit": ["owner", "manager", "cashier"],
  "customers.delete": ["owner", "manager"],
  "grooming.view": ["owner", "manager", "cashier", "groomer"],
  /** Booking, editing and canceling appointments. */
  "grooming.book": ["owner", "manager", "cashier"],
  /** The service menu, groomer hours and time off. */
  "grooming.manage": ["owner", "manager"],
  /** Grooming notes and before/after photos. */
  "grooming.notes": ["owner", "manager", "groomer"],
  "sales.view": ["owner", "manager"],
  /** Managers only up to the store's refund limit; above it an owner approves. */
  "sales.refund": ["owner", "manager"],
  /** End-of-day drawer count. */
  "drawer.count": ["owner", "manager"],
  /** Reports show costs and margins, so cashiers and groomers don't see them. */
  "reports.view": ["owner", "manager"],
  "astro.view": ["owner", "manager", "cashier"],
  "astro.edit": ["owner", "manager"],
  "settings.view": ["owner", "manager"],
  "settings.edit": ["owner"],
  "staff.view": ["owner", "manager", "cashier", "groomer"],
  "staff.manage": ["owner"],
  "import.run": ["owner", "manager"],
  "discounts.manage": ["owner", "manager"],
  /** Approving a discount that needs a manager. */
  "discounts.approve": ["owner", "manager"],
  "demo.remove": ["owner"],
} as const satisfies Record<string, readonly Role[]>;

export type Action = keyof typeof PERMISSIONS;

export function can(role: Role, action: Action): boolean {
  return (PERMISSIONS[action] as readonly Role[]).includes(role);
}

export function assertCan(role: Role, action: Action): void {
  if (!can(role, action)) throw new AppError("forbidden", "You don't have permission to do that.");
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
