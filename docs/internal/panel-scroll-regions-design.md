# Panel Scroll Regions Design

## Motivation

Three plugins — `audit_mode.ts` (review diff), `theme_editor.ts`, and `pkg.ts`
— render side-by-side panels inside a single virtual buffer. This creates
several UX problems:

1. **No per-panel scrollbar.** The editor's scrollbar reflects the entire virtual
   buffer. Since plugins pre-slice content to exactly viewport height, the
   scrollbar either shows a full-size thumb (nothing to scroll) or tracks the
   buffer's total rows, which don't correspond to either panel's logical
   scroll position. Users have no visual indicator of where they are in a
   scrollable panel.

2. **Inconsistent scroll behavior across plugins.** Each plugin reinvents scroll
   offset tracking differently:
   - `audit_mode`: manual `fileScrollOffset`/`diffScrollOffset` with
     auto-centering on selected item
   - `theme_editor`: `treeScrollOffset` on left panel only, grid navigation
     on right (no scroll)
   - `pkg.ts`: `selectedIndex` only — no scroll offset at all. Selection
     disappears off-screen when the list exceeds viewport height.

3. **Two competing scroll systems.** Plugins manage scroll by slicing content
   arrays at a TypeScript offset, then write only the visible slice to the
   buffer. The Rust core's composite buffer has its own `scroll_row` tracking.
   These are disconnected. `pkg.ts`'s `pkg_scroll_up/down` calls
   `editor.executeAction("move_up")` which moves the cursor in the editor's
   coordinate system — completely unrelated to the plugin's logical panels.

4. **No mouse scroll support.** `theme_editor` handles mouse wheel for the left
   panel but without hit-testing which panel the mouse is over. `audit_mode`
   and `pkg.ts` have no mouse scroll handling. The editor's native mouse
   scroll moves the whole buffer viewport, which is meaningless since the
   buffer is pre-sliced to viewport size.

5. **No shared abstraction.** Each plugin independently implements: layout
   calculation, content slicing, row-by-row merging of left+right panels,
   scroll offset clamping, focus switching, and keyboard routing. This is
   ~200 lines of boilerplate per plugin with subtle behavioral differences.

## Use Cases

### Current (two-panel)

```
┌─── GIT STATUS ─────────┬─── DIFF FOR file.rs ────────────────┐
│  M  hello.c           M │   @@ fn main() @@                   │
│ >M  flake.nix         M │ -     println!("Hello");            │  ← two independent
│  A  shimen.md           │ +     println!("Hello, world!");    │     scroll regions
│                          │ +     let x = 42;                  │
│                          │     }                               │
└──────────────────────────┴─────────────────────────────────────┘
```

Used by: audit_mode (file list + diff), theme_editor (tree + picker),
pkg (package list + details).

### Forward-looking: 3-way merge tool

```
┌──────────┬─────────────┬─────────────┬─────────────┐
│          │   BASE      │   OURS      │   THEIRS    │
│  File    │   (scroll)  │   (scroll)  │   (scroll)  │
│  List    │             │  ←sync→     │             │
│          ├─────────────┴─────────────┴─────────────┤
│ (scroll) │            MERGED RESULT                 │
│          │              (scroll)                    │
│          │                                          │
└──────────┴──────────────────────────────────────────┘
```

Five independently scrollable regions, some sync-linked, in a nested
layout. This rules out approaches that assume a flat list of panes.

### Forward-looking: debugger, profiler, project overview

Any plugin that needs multiple scrollable areas with independent content —
variable watch + call stack, flame graph + source, file tree + preview.

## Alternatives Considered

### A: Multi-Split Composition

Use one real editor split per panel. Each split already has its own
scrollbar, viewport, cursor, and mouse handling.

**Rejected because:** Splits can't share chrome. The toolbar/header/divider
pattern all three plugins use (row 0 toolbar spanning both panels, `│`
divider between columns) is impossible — each split is visually
independent. Each split also adds mode-line and tab-bar overhead, wasting
~2-3 rows of vertical space per split. For 5 panels that's 10-15 rows of
chrome.

Good for loosely-coupled panels (diagnostics list + source code). Wrong
for tightly-coupled UIs where panels share visual structure.

### B: Independent-Scroll Composite Buffers

Extend `CompositeBuffer` with a per-pane scroll mode alongside the
existing synced mode used for diffs. Add `pane_scroll_rows: Vec<usize>`
to `CompositeViewState`.

**Rejected as the primary approach because:** `CompositeLayout` is a flat
enum (`SideBySide | Stacked | Unified`). The 3-way merge layout requires
nesting (3 columns inside a row inside a column with a side panel). Making
`CompositeLayout` recursive turns it into a layout engine — wrong place
for that complexity. Composite buffers remain the right primitive for
alignment-synced diff views, but not for general panel layouts.

### C: Core Scroll Regions (selected — see Design below)

Virtual buffers accept optional scroll region metadata. The core renders
a scrollbar per region and routes mouse events back to the plugin. All
scroll state and layout logic lives in TypeScript.

**Selected because:** Minimal core change (~150 LoC Rust). The core does
only what plugins can't do themselves: render real scrollbars in the
terminal frame and hit-test mouse events against screen coordinates.
Everything else (layout, scroll state, focus, keyboard routing) stays in
TypeScript where iteration is fast.

### D: Declarative Panel Framework (selected — built on top of C)

A TypeScript framework where plugins describe layout as a tree of
`ScrollPanel` + `Divider` + `Toolbar` components. The framework handles
all scroll/focus/rendering concerns.

**Selected as the plugin-facing API** because all three plugins share the
same rendering pattern (build left lines, build right lines, merge
row-by-row, track scroll offsets, handle focus). A framework eliminates
~200 LoC of boilerplate per plugin and guarantees consistent behavior.

### Text-based scrollbars (no core change)

Plugins render scrollbar characters (`█`, `░`) as part of their content.

**Rejected as permanent solution** because: no mouse interaction (it's
just text), consumes a content column, can't match the editor's native
scrollbar styling. Valid as a Phase 1 placeholder during development.

### Core-owned scroll state

The core stores per-region `ScrollState`, handles keyboard/mouse scroll
internally, and requests content from the plugin via callbacks ("give me
lines N through M for region X").

**Rejected because:** Creates a pull-based content protocol with caching
and invalidation (~500+ LoC core). Limits plugin flexibility — custom
scroll behaviors (snap-to-item, sticky headers, non-linear scroll) become
hard to express. Trades simplicity for consistency that can be achieved
at the framework layer instead.

## Design

### Architecture: Four Layers

```
┌─────────────────────────────────────────────────┐
│  Plugin code (declares layout + provides data)  │  ~40-80 LoC per plugin
├─────────────────────────────────────────────────┤
│  Panel Framework (orchestrates everything)      │  ~400 LoC TS  (Layer 4)
├──────────┬──────────────┬───────────────────────┤
│  Layout  │  Scroll Mgr  │  Composite Buffers    │  (Layer 1+2 / existing)
│  Engine  │  (TS)        │  (for synced diffs)   │
├──────────┴──────────────┼───────────────────────┤
│  Core: scroll regions   │  Core: composite      │  (Layer 3 / existing)
│  (metadata + events)    │  rendering            │
└─────────────────────────┴───────────────────────┘
```

### Layer 1: Layout Engine (~300 LoC TypeScript)

Pure math. Takes a tree of containers and a total rect, outputs a Rect
per leaf node. No editor dependency, no rendering, no scroll state.

```typescript
type LayoutNode =
  | { type: "container"; direction: "h" | "v"; children: LayoutNode[]; sizes: Size[] }
  | { type: "leaf"; id: string }
  | { type: "divider"; char: "│" | "─" }
  | { type: "fixed"; id: string; height?: number }  // toolbar, header

type Size =
  | { type: "fixed"; value: number }   // 30 columns
  | { type: "ratio"; value: number }   // 0.33
  | { type: "flex" }                   // take remaining space

type Rect = { x: number; y: number; w: number; h: number }

function computeLayout(root: LayoutNode, totalRect: Rect): Map<string, Rect>
```

Trivially testable: pure function, tree + rect in, leaf rects out.

### Layer 2: Scroll Manager (~200 LoC TypeScript)

One `ScrollState` per leaf. Port of the Rust `ScrollState` from
`scroll_panel.rs` — offset, viewport, contentHeight, ensureVisible,
scrollBy, clamp. Plus:

- **Sync groups**: a set of leaf IDs that scroll together. Scrolling one
  propagates to all others in the group.
- **Focus tracking**: which leaf receives keyboard scroll events.

```typescript
class ScrollState {
  offset: number;
  viewport: number;
  contentHeight: number;

  scrollBy(delta: number): void;
  ensureVisible(y: number, height: number): void;
  maxOffset(): number;
  needsScrollbar(): boolean;
}

class ScrollManager {
  states: Map<string, ScrollState>;
  syncGroups: Map<string, string[]>;
  focusedLeaf: string;

  scroll(leafId: string, delta: number): void;  // propagates to sync group
  ensureVisible(leafId: string, line: number): void;
}
```

### Layer 3: Core Scroll Regions (~150 LoC Rust)

The only core change. Virtual buffers gain optional scroll region
metadata, passed via `setVirtualBufferContent()`:

```typescript
editor.setVirtualBufferContent(bufferId, entries, {
  scrollRegions: [
    { id: "files", rect: { x: 0,  y: 1, w: 20, h: 22 }, totalLines: 47, offset: 3 },
    { id: "diff",  rect: { x: 21, y: 1, w: 50, h: 22 }, totalLines: 312, offset: 40 },
  ]
});
```

The core does exactly three things:

1. **Renders a scrollbar** at the right edge of each region's rect.
   Reuses existing `render_scrollbar()` / `ScrollbarState`. Thumb size =
   `rect.h / totalLines`, position = `offset / (totalLines - rect.h)`.
   No scrollbar if `totalLines <= rect.h`.

2. **Routes mouse wheel events.** When a scroll event lands within a
   region's rect, fires `on_region_scroll(id, delta)` back to the plugin
   instead of scrolling the whole buffer.

3. **Routes scrollbar drag.** When the user clicks/drags a region's
   scrollbar, fires `on_region_scroll(id, ratio)` back to the plugin.

The core does NOT: own or track scroll state, slice or window content,
manage focus or keyboard routing, know anything about layout or
relationships between regions.

**Rust changes, concretely:**

- Virtual buffer model gains `scroll_regions: Vec<ScrollRegion>`.
  ```rust
  struct ScrollRegion {
      id: String,
      rect: Rect,
      total_lines: usize,
      offset: usize,
  }
  ```
- Rendering path: after painting virtual buffer content, iterate regions
  and call existing `render_scrollbar()` for each that needs one.
- Mouse handler: on wheel/click in a virtual buffer, check if the event
  falls within any region rect. If so, dispatch to plugin callback
  instead of default buffer scroll.
- TS API: extend `setVirtualBufferContent()` to accept optional
  `scrollRegions` parameter. Add `on_region_scroll` plugin event.

### Layer 4: Panel Framework (~400 LoC TypeScript)

Declarative API composing Layers 1-3:

```typescript
const layout = new PanelLayout("audit-review", {
  direction: "h",
  children: [
    ScrollPanel("files", {
      width: ratio(0.3),
      items: buildFileListItems(),
      selectedIndex: state.selectedIndex,
      onSelect: (idx) => { state.selectedIndex = idx; layout.update(); },
    }),
    Divider("│"),
    ScrollPanel("diff", {
      width: flex(),
      items: buildDiffLines(),
      scrollOffset: state.diffScrollOffset,
    }),
  ],
  header: Toolbar("review-toolbar", [
    "[Tab] Switch Panel", "[s] Stage", "[u] Unstage",
  ]),
  keymap: { Tab: "cycle-focus" },
});

// Lifecycle
await layout.open({ ratio: 0.5 });
layout.update();   // re-renders from current items/state
layout.close();
```

The framework on each `update()`:

1. Runs Layout Engine → Rect per leaf.
2. For each `ScrollPanel`, slices items to visible window using its
   `ScrollState`.
3. Assembles all visible content into a single `TextPropertyEntry[]` at
   the computed positions.
4. Passes scroll region metadata to `setVirtualBufferContent()`.
5. Handles `on_region_scroll` → updates `ScrollManager` → re-renders.
6. Handles keyboard: Tab cycles `focusedLeaf`, arrows/PageUp/PageDown go
   to focused leaf's `ScrollState`.

For the 3-way merge use case:

```typescript
const merge = new PanelLayout("merge-view", {
  direction: "h",
  children: [
    ScrollPanel("files", { width: fixed(20), items: fileList }),
    {
      direction: "v",
      children: [
        {
          direction: "h",
          syncGroup: "top-panes",
          children: [
            ScrollPanel("base",   { width: ratio(1/3), items: baseLines }),
            ScrollPanel("ours",   { width: ratio(1/3), items: ourLines }),
            ScrollPanel("theirs", { width: ratio(1/3), items: theirLines }),
          ],
        },
        ScrollPanel("merged", { height: ratio(0.4), items: mergedLines }),
      ],
    },
  ],
});
```

Existing `CompositeBuffer` remains available for cases where hunk-aligned
synced scrolling is needed (the drill-down diff view in audit_mode). The
Panel Framework can embed a composite buffer as a leaf node.

## Key Design Decisions

### Scroll state lives in TypeScript, not the core

The core renders what the plugin declares and routes events back. This
keeps the core change minimal and preserves plugin flexibility for custom
scroll behaviors (snap-to-item, sticky section headers, non-linear
scroll mapping).

**Tradeoff:** 1-frame scrollbar desync is possible — the scrollbar
reflects last frame's offset, not the current one. At terminal refresh
rates this is imperceptible.

### Layout is a tree, not a flat list

Using a recursive layout tree (not `SideBySide | Stacked`) means any
nesting depth is supported. This handles the 3-way merge case and
future complex UIs without architectural changes.

**Tradeoff:** More complex than a flat pane list for simple two-panel
cases. The framework API should make the simple case simple
(two children = two panels, no nesting needed).

### Single virtual buffer, not multiple splits

All panels render into one virtual buffer. This allows shared chrome
(headers, toolbars, dividers spanning the full width) and avoids
per-split overhead (mode lines, tab bars).

**Tradeoff:** Plugins must re-render all panels on any change, even if
only one panel's content changed. For current use cases (panels with
hundreds of lines, not thousands) this is acceptable.

### Framework over raw API

Plugins use the declarative `PanelLayout` framework, not raw scroll
regions. The framework is the real API surface; scroll regions are an
implementation detail.

**Tradeoff:** The framework constrains plugin flexibility. Plugins that
need truly custom layouts can still use scroll regions directly, but
this is an escape hatch, not the recommended path.

## Implementation Plan

All four layers land together as a single coherent change. No
intermediate states, no text-based placeholders.

Commits should be structured per CONTRIBUTING.md: separate bug fixes
from new functionality, each commit must pass `cargo check --all-targets`
and `cargo fmt`.

### 1. Core Scroll Regions (Rust, ~150 LoC)

- Add `ScrollRegion` struct to virtual buffer model.
- Extend `setVirtualBufferContent()` bridge to accept `scrollRegions`.
- After painting virtual buffer content, iterate regions and call
  existing `render_scrollbar()` for each that needs one.
- Mouse handler: on wheel/click in a virtual buffer, hit-test against
  region rects. If hit, dispatch `on_region_scroll(id, delta)` or
  `on_region_scroll(id, ratio)` to the plugin instead of default
  buffer scroll.
- Regenerate TS definitions after modifying the plugin API:
  `cargo test -p fresh-plugin-runtime write_fresh_dts_file -- --ignored`
- Regenerate JSON schemas: `./scripts/gen_schema.sh`

### 2. Layout Engine (TypeScript, ~300 LoC)

- Implement `computeLayout(root: LayoutNode, totalRect: Rect)` in
  `plugins/lib/layout-engine.ts`.
- Support `container` (horizontal/vertical with children),
  `leaf`, `divider`, `fixed` node types.
- Support `fixed`, `ratio`, `flex` sizing.
- Unit tests: pure function, tree + rect in, leaf rects out.

### 3. Scroll Manager (TypeScript, ~200 LoC)

- Implement `ScrollState` and `ScrollManager` in
  `plugins/lib/scroll-manager.ts`.
- Port scroll math from Rust `scroll_panel.rs`: offset, viewport,
  contentHeight, ensureVisible, scrollBy, clamp.
- Sync groups: scrolling one leaf propagates to all others in group.
- Focus tracking: which leaf receives keyboard scroll events.

### 4. Panel Framework (TypeScript, ~400 LoC)

- Implement `PanelLayout` in `plugins/lib/panel-layout.ts`.
- `ScrollPanel`, `Divider`, `Toolbar`/`HeaderRow` components.
- On `update()`: compute layout → slice items per scroll state →
  assemble `TextPropertyEntry[]` → pass scroll region metadata to
  `setVirtualBufferContent()`.
- Handle `on_region_scroll` → update `ScrollManager` → re-render.
- Keyboard: Tab cycles focused leaf, arrows/PageUp/PageDown go to
  focused leaf's `ScrollState`.

### 5. Migrate Existing Plugins

- **pkg.ts**: simplest — two panels, no scroll sync. Fixes the
  missing scroll offset bug (selection going off-screen).
- **audit_mode.ts** (magit view): two panels with independent scroll,
  focus switching. Replaces manual `fileScrollOffset`/
  `diffScrollOffset` tracking.
- **theme_editor.ts**: left panel scrollable, right panel grid
  navigation. Replaces manual `treeScrollOffset` tracking.

### 6. Type-check and Test

- Run `crates/fresh-editor/plugins/check-types.sh` to verify all
  plugin TypeScript after migration.
- **E2E tests** for the new panel scroll flow. E2E tests send
  keyboard/mouse events and examine final rendered output (not
  internal state). At minimum:
  - Open a panel-based plugin (e.g. pkg manager), verify both panels
    render with scrollbars when content exceeds viewport.
  - Keyboard scroll (arrow keys, PageUp/PageDown) in focused panel
    updates that panel's scrollbar position without affecting the
    other panel.
  - Tab switches focus between panels; subsequent scroll affects the
    newly focused panel.
  - Mouse wheel over a panel scrolls that panel only.
  - Resize terminal: panels re-layout and scroll positions clamp
    correctly.
- Use semantic waiting (wait for specific state/render changes), not
  fixed timers. No timeouts inside tests — `cargo nextest` handles
  external timeouts.
- Test isolation: tests run in parallel with internal clipboard mode
  and per-test temp directories.

## Scrollbar Click/Drag and Panel Border Resize

### Problem

The initial scroll region implementation renders per-region scrollbars
and routes mouse wheel events, but does not handle:

1. **Scrollbar click** — clicking the scrollbar track should jump to
   that position in the scroll region.
2. **Scrollbar drag** — dragging the scrollbar thumb should smoothly
   scroll the region.
3. **Panel border drag** — dragging the divider between panels should
   resize them (e.g., making the file list wider and the diff narrower).

### Existing Mouse Infrastructure

The editor has well-established patterns for these interactions:

- **Split separator drag** (`mouse_input.rs:1785`): hit-test 1-pixel
  lines in `CachedLayout.separator_areas`, track `dragging_separator`
  + `drag_start_ratio`, apply delta on each move via
  `split_manager.set_ratio()`.
- **Scrollbar click/drag** (`mouse_input.rs:1587`): hit-test scrollbar
  rects in `CachedLayout.split_areas`, distinguish thumb vs track
  clicks. Thumb drag stores `drag_start_row` + `drag_start_top_byte`
  and applies relative movement. Track click calls
  `handle_scrollbar_jump()` which maps click position to scroll ratio.
- **File explorer border** (`mouse_input.rs:1558`): single-column
  border at right edge of explorer area, drag adjusts
  `file_explorer_width_percent`.
- **Hover feedback** (`render.rs:1176`): `HoverTarget` enum drives
  visual highlighting (separator color change on hover).

All follow the same pattern: cached layout areas → hit test on click →
set drag state in `MouseState` → process drag moves → clear on release.

### Alternatives for Scrollbar Click/Drag

#### A: Core handles scrollbar interaction directly

The core tracks per-region scrollbar areas in `CachedLayout`, performs
hit testing, manages drag state, computes the new scroll offset, and
fires an `on_region_scroll` event to the plugin with the new offset.

**How it works:**
- Rendering stores per-region scrollbar rects + thumb positions in
  `CachedLayout.scroll_region_areas`.
- `handle_mouse_click()` checks these areas (between popups and split
  scrollbars in priority order).
- Track click: compute ratio from click position, convert to scroll
  offset, fire `on_region_scroll(id, offset)`.
- Thumb drag: store `drag_start_row` + `drag_start_offset`, compute
  relative movement, fire `on_region_scroll(id, offset)` on each move.
- Plugin receives the event, updates its scroll state, calls
  `update()`.

| Pro | Con |
|-----|-----|
| Consistent with existing scrollbar interaction | Core computes scroll offsets it doesn't own |
| Exact same UX as buffer scrollbars | Must store per-region scrollbar geometry in CachedLayout |
| Drag is smooth (core handles per-frame) | New drag state fields in MouseState |
| Works for any plugin without plugin-side code | Round-trip latency: core → plugin → re-render |

#### B: Plugin handles scrollbar interaction via mouse hooks

The existing `mouse_click` and `mouse_move` hooks fire to plugins with
screen coordinates. The plugin (or TS framework) performs hit testing
against its known scroll region rects.

**How it works:**
- Plugin receives `mouse_click(col, row)` and `mouse_move(col, row)`.
- Framework checks if click is within a scroll region's rightmost
  column (the scrollbar column).
- On click: compute scroll ratio, update ScrollState, re-render.
- On drag: framework tracks its own drag state in TypeScript, computes
  delta, updates ScrollState, re-renders on each move.

| Pro | Con |
|-----|-----|
| No core Rust changes | Plugin must implement drag state machine |
| Flexible: plugin can customize scroll behavior | No visual hover feedback (core renders scrollbar, can't highlight thumb without round-trip) |
| Faster iteration (TypeScript only) | Drag smoothness limited by TS→core→render round-trip latency |
| | Plugin must know absolute screen coords of scroll regions (needs content_rect offset from core) |

**Selected: A (core handles scrollbar interaction)** because:
- Scrollbar interaction is a rendering concern (thumb highlight,
  smooth drag) that the core handles best.
- It exactly parallels the existing scrollbar infrastructure.
- Plugins get correct behavior for free.

### Alternatives for Panel Border Resize

#### A: Core detects borders, plugin handles resize

The core provides a new `interactiveRegions` concept alongside
`scrollRegions`. Plugins declare border regions (position, orientation).
The core performs hit testing and fires events. The plugin adjusts its
layout sizes in response.

**How it works:**
- Plugin passes `borderRegions` in `setVirtualBufferContent()`:
  ```typescript
  borderRegions: [
    { id: "main-divider", x: 30, y: 2, length: 20, direction: "v" }
  ]
  ```
- Core stores these in `CachedLayout`, hit-tests on click/hover.
- Hover: core highlights the border column/row (like split separators).
- Click: core sets `dragging_panel_border` state.
- Drag: core fires `on_border_drag(id, delta)` to plugin on each move.
- Plugin adjusts its LayoutSize (e.g., changes left panel width from
  `fixed(30)` to `fixed(30 + delta)`) and re-renders.
- Release: core fires `on_border_drag_end(id)`.

| Pro | Con |
|-----|-----|
| Hover feedback (highlight) handled by core | New `borderRegions` API surface |
| Drag smoothness handled by core | Plugin must re-render on each drag event (could lag) |
| Consistent with split separator pattern | Core knows about "panels" (leaky abstraction) |
| Plugin has full control over resize behavior | |

#### B: Core detects borders via scroll region inference

Instead of explicit border declarations, the core infers borders from
adjacent scroll regions. The gap between two horizontally adjacent
scroll regions is a vertical border; the gap between two vertically
adjacent regions is a horizontal border.

**How it works:**
- Core examines pairs of scroll regions. If region A's right edge is
  1-2 columns from region B's left edge, there's a vertical border
  between them.
- Core performs hit testing on the inferred border area.
- Events fire to plugin as in option A.

| Pro | Con |
|-----|-----|
| No additional API — inferred from existing scroll regions | Fragile: inference can be wrong (non-adjacent regions, gaps) |
| Plugins don't need to declare borders | Can't handle borders between a scroll panel and a fixed area |
| | Hard to reason about — implicit behavior |

#### C: Plugin handles everything via mouse hooks

No core involvement. The TS framework tracks mouse events, performs
hit testing against divider positions, manages drag state, adjusts
layout sizes, and re-renders.

**How it works:**
- Framework registers `mouse_click`, `mouse_move`, `mouse_up` handlers.
- On click: check if click is on a divider column (framework knows
  divider positions from the layout tree).
- On drag: track start position and compute delta, adjust the adjacent
  panels' sizes, re-render.

| Pro | Con |
|-----|-----|
| Zero core changes | No hover feedback (can't highlight divider on hover without full re-render) |
| Framework has complete control | Drag smoothness limited by TS round-trip |
| Works today with existing hooks | Need `mouse_up` hook (may not exist) |
| Simplest implementation | No cursor shape change on hover |

#### D: Hybrid — core provides generic interactive regions

Generalize scroll regions and border regions into a single
`interactiveRegions` concept. Each region has a type (scrollbar,
border, button) and the core provides hit testing + hover feedback +
drag state for all of them. Plugin receives typed events.

```typescript
interactiveRegions: [
  { id: "files-scroll", type: "scrollbar", rect: {...}, totalLines, offset },
  { id: "divider", type: "v-border", x: 30, y: 2, length: 20 },
  { id: "toolbar-btn", type: "click", rect: {...} },
]
```

| Pro | Con |
|-----|-----|
| One unified system for all interactive areas | Larger API surface (type union) |
| Core provides hover feedback for all types | More complex rendering and hit testing |
| Extensible to future interaction types | Over-engineered for current needs? |
| Consistent behavior across all interactive regions | |

### Selected Approach

**Scrollbar click/drag: Alternative A** — core handles it, consistent
with existing scrollbar infrastructure. ~100 LoC Rust.

**Panel border resize: Alternative A** (explicit border regions) with
the option to evolve toward **D** (generic interactive regions) if
more interaction types emerge. The explicit approach is simpler now,
and the API shape (`borderRegions: [{ id, x, y, length, direction }]`)
is forward-compatible with a future generic system.

**Not selected: B** (inference) because implicit behavior is fragile.
**Not selected: C** (plugin-only) because hover feedback matters for
discoverability — users need to see the border highlight to know they
can drag it.

### Implementation Design

#### CachedLayout Extensions

```rust
// Per-region scrollbar hit areas (populated during rendering)
pub scroll_region_areas: Vec<ScrollRegionHitArea>,

// Panel border hit areas (populated from plugin metadata)
pub panel_border_areas: Vec<PanelBorderHitArea>,

struct ScrollRegionHitArea {
    region_id: String,
    buffer_id: BufferId,
    split_id: LeafId,
    scrollbar_rect: Rect,      // 1-column rect for the scrollbar
    thumb_start: usize,
    thumb_end: usize,
    total_lines: usize,
    visible_lines: usize,
    current_offset: usize,
}

struct PanelBorderHitArea {
    region_id: String,
    buffer_id: BufferId,
    split_id: LeafId,
    direction: BorderDirection,  // Vertical or Horizontal
    x: u16,
    y: u16,
    length: u16,
}
```

#### MouseState Extensions

```rust
// Per-region scrollbar drag
pub dragging_scroll_region: Option<String>,    // region id
pub drag_scroll_region_split: Option<LeafId>,
pub drag_scroll_region_start_row: Option<u16>,
pub drag_scroll_region_start_offset: Option<usize>,

// Panel border drag
pub dragging_panel_border: Option<String>,     // border id
pub drag_panel_border_split: Option<LeafId>,
pub drag_panel_border_start_pos: Option<u16>,  // col or row
```

#### HoverTarget Extensions

```rust
ScrollRegionThumb(String),     // region id
ScrollRegionTrack(String),     // region id
PanelBorder(String),           // border id
```

#### Plugin API Extensions

```typescript
// Extend setVirtualBufferContent options
editor.setVirtualBufferContent(bufferId, entries, {
  scrollRegions: [...],
  borderRegions: [
    { id: "divider", x: 30, y: 2, length: 20, direction: "v" },
  ],
});

// New plugin events
// Fired when user clicks track or drags thumb to a new position
registerHandler("on_region_scroll", (data: {
  regionId: string;
  offset: number;     // New scroll offset (line index)
}) => { ... });

// Fired during panel border drag (each mouse move)
registerHandler("on_border_drag", (data: {
  borderId: string;
  delta: number;      // Pixels moved from start (positive = right/down)
}) => { ... });

// Fired when border drag ends
registerHandler("on_border_drag_end", (data: {
  borderId: string;
  delta: number;      // Final delta
}) => { ... });
```

#### Click Dispatch Priority

In `handle_mouse_click()`, per-region scrollbar hits are checked after
popup scrollbars but **before** the main buffer scrollbar check:

```
  ...
  9. File explorer border
  10. File explorer content
  11. *** Per-region scrollbar hit (NEW) ***
  12. Main buffer vertical scrollbar
  13. *** Panel border hit (NEW) ***
  14. Main buffer horizontal scrollbar
  15. Split separators
  ...
```

Per-region scrollbars take priority over the main scrollbar because
when scroll regions are present, the main scrollbar is hidden. Panel
borders are checked before split separators because they're visually
inside the split content area.

#### Hover Rendering

- **ScrollRegionThumb**: re-render the scrollbar column with
  `ScrollbarColors::from_theme_hover()` (brighter thumb color).
- **PanelBorder**: re-render the border column/row with the separator
  hover color (`theme.split_separator_hover_fg`), consistent with
  split separator hover feedback.

#### Scroll Offset Calculation

For scrollbar track click:
```rust
let relative_row = click_row - scrollbar_rect.y;
let ratio = relative_row as f64 / (scrollbar_rect.height - 1) as f64;
let max_offset = total_lines - visible_lines;
let new_offset = (ratio * max_offset as f64) as usize;
```

For scrollbar thumb drag:
```rust
let row_delta = current_row as i32 - drag_start_row as i32;
let rows_per_line = scrollbar_height as f64 / total_lines as f64;
let line_delta = (row_delta as f64 / rows_per_line) as isize;
let new_offset = (start_offset as isize + line_delta).clamp(0, max_offset);
```

The core fires `on_region_scroll(id, new_offset)`. The plugin updates
its ScrollState and calls update().

#### Border Delta Calculation

For panel border drag:
```rust
let delta = match direction {
    BorderDirection::Vertical => col as i32 - start_col as i32,
    BorderDirection::Horizontal => row as i32 - start_row as i32,
};
```

The core fires `on_border_drag(id, delta)`. The plugin adjusts its
layout sizes:
```typescript
function onBorderDrag(data: { borderId: string; delta: number }) {
  if (data.borderId === "divider") {
    leftPanelWidth = Math.max(20, Math.min(60, baseWidth + data.delta));
    layout.update();
  }
}
```

### Why the Plugin Handles Resize, Not the Core

The core fires raw `delta` events; the plugin decides how to apply
them. This is deliberate:

1. **Layout is plugin-owned.** The core doesn't know panel semantics
   (which panel grows, which shrinks, minimum widths). The plugin
   does.
2. **Constraints are plugin-specific.** Min/max widths, aspect ratios,
   snap-to-grid behavior, fixed vs flexible panels — all vary by
   plugin.
3. **Consistency with scroll regions.** Scroll state is plugin-owned;
   resize state should be too. The core renders and routes events.

The core's job is the same as for scroll regions: render the visual
(scrollbar / border highlight), route the mouse interaction, fire
events. The plugin owns the state.

## Relationship to Existing Infrastructure

| Existing component | Role in this design |
|--------------------|---------------------|
| `ScrollablePanel` / `ScrollState` (scroll_panel.rs) | Rust-side inspiration for TS `ScrollState`. The Rust version continues to be used for settings UI and other core-rendered panels. |
| `CompositeBuffer` (composite_buffer.rs) | Unchanged. Remains the primitive for alignment-synced diff views. Can be embedded as a leaf in the Panel Framework for hunk-synced panes. |
| `PanelManager` (panel-manager.ts) | Superseded by `PanelLayout` for multi-panel cases. Can remain for simple single-panel use cases (diagnostics list, search results). |
| `ScrollSyncGroup` (scroll_sync.rs) | Split-to-split sync, unchanged. The TS `ScrollManager` handles sync within a single virtual buffer's regions. |
| `render_scrollbar()` (split_rendering.rs) | Reused by core scroll region rendering — called once per region instead of once per buffer. |
