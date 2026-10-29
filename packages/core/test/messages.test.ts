import { describe, expect, it } from "vitest";
import {
  atLocal,
  bookingLink,
  channelFor,
  emailBody,
  inQuietHours,
  messageText,
  nudgeDueAt,
  reminderDueAt,
  sendableAt,
} from "../src/index.ts";

describe("how to reach a customer", () => {
  const both = { phone: "2125550100", email: "pat@example.com", smsOptIn: true, pref: null };
  it("texts when they've agreed, emails when they prefer it or can't get texts", () => {
    expect(channelFor(both)).toEqual({ channel: "sms", to: "2125550100" });
    expect(channelFor({ ...both, pref: "email" })).toEqual({ channel: "email", to: "pat@example.com" });
    expect(channelFor({ ...both, smsOptIn: false })).toEqual({ channel: "email", to: "pat@example.com" });
    expect(channelFor({ ...both, pref: "email", email: null })).toEqual({ channel: "sms", to: "2125550100" });
  });
  it("sends nothing without an opt-in or an email", () => {
    expect(channelFor({ phone: "2125550101", email: null, smsOptIn: false, pref: "text" })).toBeNull();
  });
});

describe("when messages go out", () => {
  it("waits out quiet hours: 9:00 AM to 8:00 PM", () => {
    expect(sendableAt(atLocal("2026-11-02", 8 * 60))).toEqual(atLocal("2026-11-02", 9 * 60));
    expect(sendableAt(atLocal("2026-11-02", 20 * 60 + 30))).toEqual(atLocal("2026-11-03", 9 * 60));
    expect(sendableAt(atLocal("2026-11-02", 13 * 60))).toEqual(atLocal("2026-11-02", 13 * 60));
    expect(inQuietHours(atLocal("2026-11-02", 21 * 60))).toBe(true);
    expect(inQuietHours(atLocal("2026-11-02", 12 * 60))).toBe(false);
  });
  it("reminds the day before at the store's time, and nudges after the rebook weeks", () => {
    expect(reminderDueAt(atLocal("2026-11-03", 9 * 60), 600)).toEqual(atLocal("2026-11-02", 600));
    // 6 weeks after a groom done at 8:45 PM: the next morning at 9:00.
    expect(nudgeDueAt(atLocal("2026-09-01", 20 * 60 + 45), 6)).toEqual(atLocal("2026-10-14", 9 * 60));
  });
});

describe("the wording", () => {
  const w = {
    store: "Sample Pet Store",
    pet: "Biscuit",
    service: "Full groom",
    day: "2026-10-29",
    time: 540,
    groomer: "Sample Groomer",
  };
  it("keeps texts short and specific", () => {
    const link = bookingLink("sample", true);
    const c = messageText.confirm({ ...w, depositCents: 2000, link });
    expect(c).toBe(
      "Sample Pet Store: Biscuit's Full groom is booked for Thu Oct 29 at 9:00 AM with Sample Groomer. $20.00 deposit paid. Manage it: petpos-demo.prismcortex.net/book",
    );
    expect(messageText.reminder({ ...w, phone: "2125550199" })).toBe(
      "Sample Pet Store: reminder, Biscuit's groom is tomorrow, Thu Oct 29 at 9:00 AM. Need to change it? Call (212) 555-0199.",
    );
    const n = messageText.nudge({
      store: "Sample Pet Store",
      pet: "Rex",
      weeks: 4,
      link: bookingLink("sample", false, { pet: "p1", service: "s1" }),
    });
    expect(n).toBe(
      "Sample Pet Store: it's been 4 weeks since Rex's last groom. Book the next one: sample.pos.prismcortex.net/book?pet=p1&service=s1",
    );
    expect(n.length).toBeLessThanOrEqual(160);
    expect(emailBody(n, "https://x/unsub")).toContain("Unsubscribe: https://x/unsub");
  });
});
