// Where customer messages go once they're written to appointment_messages. Demo mode
// only previews them (status "preview"); hosted mode will queue them for SES (email) and
// AWS End User Messaging (texts), and a sender marks them sent or failed.

export interface Messenger {
  readonly name: string;
  /** The status a new message starts with. */
  readonly startStatus: "preview" | "queued";
}

export class PreviewMessenger implements Messenger {
  readonly name = "Preview (demo: nothing is sent)";
  readonly startStatus = "preview" as const;
}

/** The messenger in use. Demo mode only has the preview one. */
export const messenger: Messenger = new PreviewMessenger();
