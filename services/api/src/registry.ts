import type { Kysely } from "kysely";
import { assertCan, AppError, type Ctx } from "@pet-pos/core";
import { withBusiness, type DB } from "@pet-pos/db";
import type { Handler } from "./handler.ts";
import { listAstroQueue, listPrograms, markAstroEntered, saveProgram } from "./handlers/astro.ts";
import {
  archiveProduct,
  findByCode,
  getProduct,
  listProducts,
  receiveStock,
  saveCounts,
  saveProduct,
} from "./handlers/inventory.ts";
import {
  deleteCustomer,
  deletePreview,
  getCustomer,
  lookupByPhone,
  saveCustomer,
  savePetDetails,
  saveVaccinations,
  searchCustomers,
} from "./handlers/customers.ts";
import {
  finishImport,
  importChunk,
  listImports,
  previewImport,
  startImport,
  undoImport,
  undoPreview,
} from "./handlers/import.ts";
import { demoDataPreview, removeDemoData } from "./handlers/demo.ts";
import { drawerSummary, listDrawerCounts, saveDrawerCount } from "./handlers/drawer.ts";
import {
  addTimeOff,
  archiveService,
  bookAppointment,
  cancelAppointment,
  checkAppointment,
  customerAppointments,
  groomingDay,
  listGroomers,
  listServices,
  removeTimeOff,
  saveGroomer,
  saveService,
  setAppointmentStatus,
  updateAppointment,
  appointmentMessages,
  applyCallout,
  calloutPreview,
  groomingWeek,
  moveAppointment,
  textAppointment,
} from "./handlers/grooming.ts";
import {
  addGroomingNote,
  appointmentNotes,
  deleteGroomingNote,
  groomsToCheckOut,
  listServiceSupplies,
  petGroomingHistory,
  saveServiceSupplies,
} from "./handlers/groomingHistory.ts";
import { customerHistory } from "./handlers/history.ts";
import { deleteDiscount, listDiscounts, saveDiscount } from "./handlers/discounts.ts";
import {
  cancelSale,
  getSale,
  listSales,
  payCash,
  registerCustomer,
  simulateTerminalResult,
  startCardPayment,
  startCheckout,
} from "./handlers/register.ts";
import { sendReceipt } from "./handlers/receipts.ts";
import { refundDeposit, requestDeposit } from "./handlers/deposits.ts";
import { refundPreview, refundSale } from "./handlers/refunds.ts";
import { getSettings, updateSettings } from "./handlers/settings.ts";
import { addStaff, listStaff, me, updateStaff } from "./handlers/staff.ts";

/** Every handler by name. The demo transport and (in 1f) the Lambda adapters both dispatch through here. */
export const handlers = {
  me,
  listStaff,
  addStaff,
  updateStaff,
  getSettings,
  updateSettings,
  demoDataPreview,
  removeDemoData,
  listProducts,
  findByCode,
  getProduct,
  saveProduct,
  archiveProduct,
  receiveStock,
  saveCounts,
  listPrograms,
  saveProgram,
  searchCustomers,
  lookupByPhone,
  getCustomer,
  saveCustomer,
  savePetDetails,
  saveVaccinations,
  deletePreview,
  deleteCustomer,
  previewImport,
  startImport,
  importChunk,
  finishImport,
  listImports,
  undoPreview,
  undoImport,
  listDiscounts,
  saveDiscount,
  deleteDiscount,
  registerCustomer,
  startCheckout,
  payCash,
  startCardPayment,
  simulateTerminalResult,
  cancelSale,
  getSale,
  listSales,
  refundPreview,
  refundSale,
  sendReceipt,
  listAstroQueue,
  markAstroEntered,
  drawerSummary,
  saveDrawerCount,
  listDrawerCounts,
  customerHistory,
  listServices,
  saveService,
  archiveService,
  listGroomers,
  saveGroomer,
  addTimeOff,
  removeTimeOff,
  groomingDay,
  checkAppointment,
  bookAppointment,
  updateAppointment,
  setAppointmentStatus,
  cancelAppointment,
  customerAppointments,
  addGroomingNote,
  deleteGroomingNote,
  appointmentNotes,
  petGroomingHistory,
  listServiceSupplies,
  saveServiceSupplies,
  groomsToCheckOut,
  groomingWeek,
  moveAppointment,
  textAppointment,
  requestDeposit,
  refundDeposit,
  appointmentMessages,
  calloutPreview,
  applyCallout,
};

export type Handlers = typeof handlers;
export type HandlerName = keyof Handlers;
export type InputOf<N extends HandlerName> = Handlers[N] extends Handler<infer I, unknown> ? I : never;
export type OutputOf<N extends HandlerName> = Handlers[N] extends Handler<unknown, infer O> ? O : never;

/** Checks permission, then runs the handler in a transaction scoped to the caller's business. */
export async function invoke<N extends HandlerName>(
  db: Kysely<DB>,
  ctx: Ctx,
  name: N,
  input: InputOf<N>,
): Promise<OutputOf<N>> {
  const handler = handlers[name] as unknown as Handler<InputOf<N>, OutputOf<N>> | undefined;
  if (!handler) throw new AppError("not_found", `Unknown action: ${String(name)}`);
  if (handler.action) assertCan(ctx.role, handler.action);
  return withBusiness(db, ctx.businessId, (trx) => handler.run(trx, ctx, input));
}
