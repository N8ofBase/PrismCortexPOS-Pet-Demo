# Setting up the Claude Project

A Claude Project on claude.ai keeps this system's spec, plans and status in one place, so you can ask about it, plan with it, or write up things for the store owner without re-explaining the system. It doesn't touch the code; building still happens in Claude Code.

## Steps

1. On claude.ai, open **Projects → Create project**. Name it **Pet Store POS (PrismCortex)**.
2. Open **Project instructions** and paste in the whole of `instructions.md` from this folder.
3. Under **Project knowledge**, upload these files from the repo:

| File | Why |
| --- | --- |
| `docs/claude-project/status.md` | What's built, what's live, what's next, and the decisions made along the way |
| `docs/SPEC.md` | The full spec |
| `CLAUDE.md` | The stack, rules and the gotchas Claude Code works by |
| `README.md` | The short status list |
| `docs/plans/phase-1-foundation.md` | Phase 1's approved decisions, which override the spec where they differ |
| `docs/plans/phase-2-register.md` | Register plan |
| `docs/plans/phase-3-grooming.md` | Grooming plan |
| `docs/plans/phase-4-online-booking.md` | Online booking, deposits and messages plan |

Optional:
- **The smaller 1a to 1e and 2b, 2c plans:** add these if you'll ask about those details.
- **`docs/prototype.html`:** add it if you want answers about the original screens (it's about 100 KB).

## Keeping it current

When a phase finishes, re-upload `status.md` and the plan that changed. Claude Code updates both at the end of each session.
