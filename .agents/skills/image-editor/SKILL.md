---
name: image-editor
description: Image editing/sprite-extraction assistant for fang-image-processing. Enforces reading DESIGN.md before implementing or changing anything, to keep the Rails/Python split and selection-state model consistent.
argument-hint: '[feature or bug description]'
---

# Image Editor Workflow

Before writing any code, read the design document to understand the existing architecture and the Rails/Python boundary.

## Step 1: Read DESIGN.md First

**Always start here.** Open and read `DESIGN.md` in full before doing anything else.

This document is the source of truth for:
- The four core tools (fuzzy select, combine select, invert select, delete) and how they compose
- The Rails ↔ Python architecture split and why it exists
- The selection-state model (server-side mask, browser as thin renderer)
- The Rails ↔ Python HTTP contract
- The output contract (transparent PNG, compatible with `fang-backend`'s `Sprite` format)

Do not assume you know how something works — verify it against the design doc.

## Step 2: Locate the Relevant Section

Find the section in `DESIGN.md` that covers what you're implementing or fixing:

- Canvas rendering, click/drag handling, tool UI → §5 Rails app structure (`editor_controller.js`)
- Flood-fill / masking / connected-component algorithm → §6 Python service structure
- Rails ↔ Python wire format or adding a new endpoint → §4 the contract table
- Selection/session persistence → §3 Selection state model
- Export format or future `fang-backend` integration → §7 Output contract

If the feature or bug isn't covered in the doc, **flag this** to the user before proceeding — the doc may need updating, or the scope may be unclear.

## Step 3: Understand the Existing Code

Read the relevant source files before editing:

- `app/services/pixel_engine_client.rb` — the **only** boundary that talks to the Python service. No controller or model should call Python directly.
- `app/javascript/controllers/editor_controller.js` — canvas rendering and tool input. Contains no pixel math.
- `app/models/edit_session.rb` — the state owner (original image + current mask).
- `python_service/` — pixel algorithms only. Stateless, no persistence or session concerns.

**Do not blur this split**: Rails must never do pixel math inline, and the Python service must never own persistence or session state. If a change seems to require crossing that boundary, stop and reconsider which side it actually belongs on.

## Step 4: Implement

Only after Steps 1–3, write or change code:

- **New tool**: follow the recipe in `DESIGN.md` §8 — Python endpoint → `PixelEngineClient` method → controller action → Stimulus button/action → update the doc.
- **Changing the mask format or wire contract**: update both the Rails and Python sides together, plus the contract table in `DESIGN.md` §4. A one-sided change breaks the other runtime silently since there's no shared type system across the HTTP boundary.
- **Session data changes**: keep `EditSession` as the sole state owner; the Python service and the browser both stay stateless/thin.

## Step 5: Update DESIGN.md

Any change to the contract, architecture, or tool set must be reflected back in `DESIGN.md` in the **same session**. Stale docs are worse than no docs.

## Step 6: Verify

No automated test suite exists yet, and UI/visual correctness (canvas rendering, overlay animation, selection boundaries) is not something to self-certify — **the user verifies in their own browser, not the agent**.

Do not spin up a headless browser, Playwright, Chrome DevTools Protocol, or take screenshots to "confirm" a UI change works. Static review (reading the diff, checking for leftover references, confirming logic) is fine and encouraged, but it is not a substitute for the user actually looking at it — say so explicitly rather than implying the change has been visually confirmed.

Instead:

1. Confirm the Rails app and Python service are runnable (start them if not already running — check for existing processes first rather than assuming):
   ```bash
   bin/dev                              # starts both Rails and the Python service (see DESIGN.md §6)
   ```
   `bin/dev` runs `foreman start -f Procfile.dev`, which brings up both processes together. The Python process is always started with uvicorn's `--reload` flag — never start it without `--reload`, even for a one-off manual check, since `masks.py`/`app.py` edits should pick up automatically like Rails' own code reloading. Only fall back to starting Rails/Python separately (`bin/rails server`, or the raw `uvicorn` command in DESIGN.md §6) if you need to isolate one side for debugging.
2. Do your own static/code-level check: read back the changed files, grep for stale references to anything removed/renamed, confirm no obvious logic errors.
3. Tell the user what changed and hand it back to them with a concrete, short checklist of what to look at (e.g. "fuzzy-select a region and confirm the border animates without flickering, and that there's no dark tint over the selection"). Don't just say "please verify" — name the specific behavior that changed so they know what to look for.
4. Wait for their confirmation before considering the change done. If they report something looks wrong, treat their description (not a screenshot you took) as the ground truth for diagnosing further.

The full manual flow the user should exercise for anything touching the editor: upload an image → fuzzy select → combine → invert → delete → export, confirming the downloaded file is a transparent PNG matching the source dimensions.

## Design & Implementation Preferences

These process habits are carried over from `fang/.claude/skills/game-dev/SKILL.md`, adapted from a React component model to this Rails + JS + Python split — apply proactively, don't wait to be asked.

### Top-down layering

Reason about where logic belongs before writing it:

- **Stimulus controller** (`editor_controller.js`) — interactive panel. Owns canvas refs, click/drag handlers, tool-selection state. No pixel math.
- **`app/services/pixel_engine_client.rb`** — the only boundary to Python. A thin HTTP client, not a place for business logic.
- **Python service** — pixel math only. Stateless per request, no session/persistence concerns.
- **`EditSession` model/controller** — the state owner, same role as a "Screen" that owns state while children don't.

Mixing these layers (Rails doing flood-fill inline, or the Stimulus controller calling Python directly) is the failure mode to avoid — it is the direct analogue of "mixing layers is the root cause of god components."

### Flat folder hierarchy

Keep `app/services/`, `app/javascript/controllers/`, and `python_service/` as flat siblings-by-concern rather than nesting subsystems inside each other. A folder that mixes concerns should split into sibling folders, not grow deeper.

### Shrink interfaces to what's used

When defining the Rails ↔ Python JSON contract or Stimulus data attributes, only pass what the receiving side actually consumes. Don't tunnel extra fields through "just in case."

### Documentation discipline

After any structural change (new tool, new service boundary, changed contract), update `DESIGN.md` in the same session.

## Step 7: Flag Refactor Opportunities

If implementing or fixing something required searching more than one file/service to find what should have been obvious, or the Rails ↔ Python boundary got blurry while you worked, **stop and tell the user**. Be specific:

- What you expected to find and where
- What you actually found and where
- The concrete refactor (e.g. "move X into `pixel_engine_client.rb`", "this endpoint belongs in Python, not Rails")

Do not silently route around confusing structure.

**IMPORTANT**: Always keep a todo list for implementation work, with a final item to look back for refactor opportunities before finishing.
