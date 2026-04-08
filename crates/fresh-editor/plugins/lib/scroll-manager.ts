/**
 * Scroll Manager - Per-region scroll state with sync groups
 *
 * Port of the Rust ScrollState from scroll_panel.rs.
 * Manages scroll offset, viewport, content height, and ensure-visible logic
 * for each scrollable region in a panel layout.
 */

/** Scroll state for a single scrollable region */
export class ScrollState {
  offset: number = 0;
  viewport: number = 0;
  contentHeight: number = 0;

  constructor(viewport: number = 0) {
    this.viewport = viewport;
  }

  /** Maximum valid scroll offset */
  maxOffset(): number {
    return Math.max(0, this.contentHeight - this.viewport);
  }

  /** Whether a scrollbar is needed (content exceeds viewport) */
  needsScrollbar(): boolean {
    return this.contentHeight > this.viewport;
  }

  /** Clamp offset to valid range */
  private clamp(): void {
    this.offset = Math.max(0, Math.min(this.offset, this.maxOffset()));
  }

  /** Update viewport height */
  setViewport(height: number): void {
    this.viewport = height;
    this.clamp();
  }

  /** Update total content height */
  setContentHeight(height: number): void {
    this.contentHeight = height;
    this.clamp();
  }

  /** Scroll by delta lines (positive = down, negative = up) */
  scrollBy(delta: number): void {
    this.offset += delta;
    this.clamp();
  }

  /** Scroll to a ratio (0.0 = top, 1.0 = bottom) */
  scrollToRatio(r: number): void {
    const clamped = Math.max(0, Math.min(1, r));
    this.offset = Math.round(clamped * this.maxOffset());
  }

  /**
   * Ensure a region is visible. If the region is taller than the viewport,
   * show the top of the region.
   */
  ensureVisible(y: number, height: number): void {
    if (y < this.offset) {
      this.offset = y;
    } else if (y + height > this.offset + this.viewport) {
      if (height > this.viewport) {
        this.offset = y;
      } else {
        this.offset = y + height - this.viewport;
      }
    }
    this.clamp();
  }
}

/** Manages scroll states for all regions, with sync groups and focus tracking */
export class ScrollManager {
  states: Map<string, ScrollState> = new Map();
  syncGroups: Map<string, string[]> = new Map();
  focusedLeaf: string = "";

  /** Get or create a scroll state for a leaf */
  getState(leafId: string): ScrollState {
    let state = this.states.get(leafId);
    if (!state) {
      state = new ScrollState();
      this.states.set(leafId, state);
    }
    return state;
  }

  /** Register a sync group: scrolling any member scrolls all members */
  addSyncGroup(groupId: string, leafIds: string[]): void {
    this.syncGroups.set(groupId, leafIds);
  }

  /** Set which leaf receives keyboard scroll events */
  setFocus(leafId: string): void {
    this.focusedLeaf = leafId;
  }

  /** Cycle focus to the next scrollable leaf */
  cycleFocus(leafIds: string[]): void {
    if (leafIds.length === 0) return;
    const idx = leafIds.indexOf(this.focusedLeaf);
    const next = (idx + 1) % leafIds.length;
    this.focusedLeaf = leafIds[next];
  }

  /**
   * Scroll a leaf by delta, propagating to sync group members.
   * Returns the set of leaf IDs that were scrolled (for re-render).
   */
  scroll(leafId: string, delta: number): string[] {
    const affected: string[] = [leafId];
    this.getState(leafId).scrollBy(delta);

    // Propagate to sync group members
    for (const [, members] of this.syncGroups) {
      if (members.includes(leafId)) {
        const targetOffset = this.getState(leafId).offset;
        for (const member of members) {
          if (member !== leafId) {
            this.getState(member).offset = targetOffset;
            affected.push(member);
          }
        }
      }
    }

    return affected;
  }

  /** Ensure a line is visible in a leaf's scroll state */
  ensureVisible(leafId: string, line: number, height: number = 1): void {
    this.getState(leafId).ensureVisible(line, height);
  }

  /** Get the focused leaf's scroll state */
  getFocusedState(): ScrollState | undefined {
    return this.states.get(this.focusedLeaf);
  }
}
