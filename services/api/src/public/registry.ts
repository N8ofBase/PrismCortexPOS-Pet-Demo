import type { Kysely } from "kysely";
import { AppError } from "@pet-pos/core";
import { withBusiness, type DB } from "@pet-pos/db";
import {
  bookingPage,
  bookOnline,
  cancelMine,
  customerForToken,
  depositStatus,
  payDeposit,
  simulateDepositPayment,
  myAccount,
  openTimesFor,
  requestCode,
  rescheduleMine,
  savePet,
  signOut,
  verifyCode,
} from "./booking.ts";
import type { PublicHandler } from "./handler.ts";

/** Everything the public booking page can call. Nothing from the staff registry is here. */
export const publicHandlers = {
  bookingPage,
  requestCode,
  verifyCode,
  signOut,
  myAccount,
  savePet,
  openTimes: openTimesFor,
  bookOnline,
  cancelMine,
  rescheduleMine,
  depositStatus,
  payDeposit,
  simulateDepositPayment,
};

export type PublicHandlers = typeof publicHandlers;
export type PublicName = keyof PublicHandlers;
export type PublicInput<N extends PublicName> =
  PublicHandlers[N] extends PublicHandler<infer I, unknown> ? I : never;
export type PublicOutput<N extends PublicName> =
  PublicHandlers[N] extends PublicHandler<unknown, infer O> ? O : never;

export interface PublicCaller {
  businessId: string;
  /** The session token from verifyCode, if the customer is signed in. */
  token: string | null;
  demo: boolean;
}

/**
 * Runs a public handler in a transaction scoped to the store. The customer comes only
 * from a valid session token; handlers that need one refuse without it.
 */
export async function invokePublic<N extends PublicName>(
  db: Kysely<DB>,
  caller: PublicCaller,
  name: N,
  input: PublicInput<N>,
): Promise<PublicOutput<N>> {
  const handler = publicHandlers[name] as unknown as
    PublicHandler<PublicInput<N>, PublicOutput<N>> | undefined;
  if (!handler) throw new AppError("not_found", `Unknown action: ${String(name)}`);
  return withBusiness(db, caller.businessId, async (trx) => {
    const customerId = await customerForToken(trx, caller.token);
    if (handler.signedIn && !customerId) throw new AppError("forbidden", "Please sign in again.");
    return handler.run(trx, { businessId: caller.businessId, customerId, demo: caller.demo }, input);
  });
}
