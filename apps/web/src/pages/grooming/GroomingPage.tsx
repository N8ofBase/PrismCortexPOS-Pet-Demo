import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { useSession } from "../../session.tsx";
import { Calendar } from "./Calendar.tsx";
import { GroomersView } from "./GroomersView.tsx";
import { MessagesView } from "./MessagesView.tsx";
import { ServicesView } from "./ServicesView.tsx";

type View = "calendar" | "services" | "groomers" | "messages";

function savedView(): View {
  try {
    const v = localStorage.getItem("grooming.view");
    if (v === "services" || v === "groomers" || v === "messages") return v;
  } catch {
    // Storage can be blocked; the calendar is the default.
  }
  return "calendar";
}

const VIEW_LABEL: Record<View, string> = {
  calendar: "Calendar",
  services: "Services",
  groomers: "Groomers",
  messages: "Messages",
};

export function GroomingPage() {
  const location = useLocation();
  const bookFor = (location.state as { bookFor?: string } | null)?.bookFor ?? null;
  const [view, setView] = useState<View>(bookFor ? "calendar" : savedView);
  const { api } = useSession();
  const qc = useQueryClient();
  // The demo has no background job, so due reminders and rebook reminders go out when
  // the grooming screens open (hosted mode runs the same sweep on a schedule).
  const sweep = useQuery({
    queryKey: ["messageSweep"],
    queryFn: () => api.call("sendDueNow"),
    staleTime: 5 * 60_000,
  });
  useEffect(() => {
    if (sweep.data && (sweep.data.reminders || sweep.data.nudges))
      void qc.invalidateQueries({ queryKey: ["messages"] });
  }, [sweep.data, qc]);

  function pick(v: View) {
    setView(v);
    try {
      localStorage.setItem("grooming.view", v);
    } catch {
      // Remembering the tab is only a convenience.
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Grooming</h1>
        <a href="/book" className="small" title="What customers see when they book online">
          Open booking page
        </a>
        <div className="seg" role="group" aria-label="Grooming views">
          {(["calendar", "services", "groomers", "messages"] as View[]).map((v) => (
            <button type="button" key={v} aria-pressed={view === v} onClick={() => pick(v)}>
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
      </div>
      {view === "calendar" && <Calendar bookFor={bookFor} />}
      {view === "services" && <ServicesView />}
      {view === "groomers" && <GroomersView />}
      {view === "messages" && <MessagesView />}
    </>
  );
}
