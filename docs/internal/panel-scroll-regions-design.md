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

## Phasing

### Phase 1: Layout Engine + Scroll Manager (pure TypeScript)

- Implement Layout Engine and Scroll Manager as library modules in
  `plugins/lib/`.
- Text-based scroll indicators (`▲`/`▼` or `[3/47]`) as placeholder —
  no core changes yet.
- Migrate `pkg.ts` as the simplest validation target.
- Validate API ergonomics and scroll behavior.

### Phase 2: Core Scroll Regions (~150 LoC Rust)

- Add `ScrollRegion` to virtual buffer model.
- Render per-region scrollbars using existing `render_scrollbar()`.
- Add mouse wheel/drag event routing to plugin callbacks.
- Extend `setVirtualBufferContent()` TS API.
- Replace text-based indicators with real scrollbars.

### Phase 3: Panel Framework + Migration

- Build `PanelLayout` framework composing Layers 1-3.
- Migrate `pkg.ts`, `theme_editor.ts`, `audit_mode.ts` (magit view).
- Document framework API for future plugin authors.

### Phase 4 (future): Complex layouts

- 3-way merge tool using nested layout with sync groups.
- Composite buffer leaf nodes for hunk-aligned diff panes.
- Debugger, profiler, or project overview panels.

## Relationship to Existing Infrastructure

| Existing component | Role in this design |
|--------------------|---------------------|
| `ScrollablePanel` / `ScrollState` (scroll_panel.rs) | Rust-side inspiration for TS `ScrollState`. The Rust version continues to be used for settings UI and other core-rendered panels. |
| `CompositeBuffer` (composite_buffer.rs) | Unchanged. Remains the primitive for alignment-synced diff views. Can be embedded as a leaf in the Panel Framework for hunk-synced panes. |
| `PanelManager` (panel-manager.ts) | Superseded by `PanelLayout` for multi-panel cases. Can remain for simple single-panel use cases (diagnostics list, search results). |
| `ScrollSyncGroup` (scroll_sync.rs) | Split-to-split sync, unchanged. The TS `ScrollManager` handles sync within a single virtual buffer's regions. |
| `render_scrollbar()` (split_rendering.rs) | Reused by core scroll region rendering — called once per region instead of once per buffer. |
