/// <reference path="./fresh.d.ts" />

/**
 * Panel Layout Framework - Declarative side-by-side panel rendering
 *
 * Plugins describe layout as a tree of ScrollPanel + Divider + FixedRow
 * components. The framework handles scroll state, scrollbar rendering,
 * focus management, keyboard routing, and content assembly.
 *
 * @example
 * ```typescript
 * const layout = new PanelLayout(editor, "my-mode", {
 *   direction: "h",
 *   children: [
 *     ScrollPanel("files", {
 *       size: ratio(0.3),
 *       getItems: () => buildFileItems(),
 *     }),
 *     Divider("│"),
 *     ScrollPanel("details", {
 *       size: flex(),
 *       getItems: () => buildDetailItems(),
 *     }),
 *   ],
 *   header: FixedRow("toolbar", "[Tab] Switch  [q] Close"),
 * });
 * ```
 */

import {
  computeLayout,
  fixed,
  flex,
  ratio,
  type LayoutChild,
  type LayoutNode,
  type LayoutRect,
  type LayoutSize,
} from "./layout-engine.ts";
import { ScrollManager, ScrollState } from "./scroll-manager.ts";

export { fixed, flex, ratio };
export type { LayoutSize };

// ─── Panel component types ──────────────────────────────────────────

/** A single line item within a scroll panel */
export interface PanelItem {
  text: string;
  style?: Partial<OverlayOptions>;
  properties?: Record<string, unknown>;
  inlineOverlays?: InlineOverlay[];
}

/** Configuration for a scrollable panel region */
export interface ScrollPanelConfig {
  id: string;
  size: LayoutSize;
  /** Called on each render to get current items */
  getItems: () => PanelItem[];
  /** Selected item index (for auto-scroll-into-view) */
  selectedIndex?: number;
}

/** Configuration for a vertical divider */
export interface DividerConfig {
  char: string;
  style?: Partial<OverlayOptions>;
}

/** Configuration for a fixed (non-scrollable) row */
export interface FixedRowConfig {
  id: string;
  getText: () => string;
  style?: Partial<OverlayOptions>;
}

/** A component in the panel layout */
export type PanelComponent =
  | { type: "scroll-panel"; config: ScrollPanelConfig }
  | { type: "divider"; config: DividerConfig }
  | { type: "fixed-row"; config: FixedRowConfig };

/** Top-level layout configuration */
export interface PanelLayoutConfig {
  direction: "h" | "v";
  children: PanelComponent[];
  /** Optional header row rendered at the top */
  header?: FixedRowConfig;
  /** Optional footer row rendered at the bottom */
  footer?: FixedRowConfig;
  /** Sync group: set of panel IDs that scroll together */
  syncGroup?: string[];
}

// ─── Convenience constructors ───────────────────────────────────────

export function ScrollPanel(
  id: string,
  opts: { size: LayoutSize; getItems: () => PanelItem[] },
): PanelComponent {
  return {
    type: "scroll-panel",
    config: { id, size: opts.size, getItems: opts.getItems },
  };
}

export function Divider(char: string = "│", style?: Partial<OverlayOptions>): PanelComponent {
  return { type: "divider", config: { char, style } };
}

export function FixedRow(
  id: string,
  getText: (() => string) | string,
  style?: Partial<OverlayOptions>,
): FixedRowConfig {
  return {
    id,
    getText: typeof getText === "string" ? () => getText : getText,
    style,
  };
}

// ─── PanelLayout class ─────────────────────────────────────────────

export class PanelLayout {
  private editor: EditorAPI;
  private modeName: string;
  private config: PanelLayoutConfig;
  private scrollManager: ScrollManager = new ScrollManager();
  private bufferId: number | null = null;
  private splitId: number | null = null;
  private sourceSplitId: number | null = null;
  private sourceBufferId: number | null = null;
  private isOpen: boolean = false;
  private panelIds: string[] = [];
  private viewportWidth: number = 80;
  private viewportHeight: number = 24;
  private mouseScrollHandler: string | null = null;

  constructor(editor: EditorAPI, modeName: string, config: PanelLayoutConfig) {
    this.editor = editor;
    this.modeName = modeName;
    this.config = config;

    // Collect scrollable panel IDs for focus cycling
    for (const child of config.children) {
      if (child.type === "scroll-panel") {
        this.panelIds.push(child.config.id);
      }
    }

    // Set initial focus to first panel
    if (this.panelIds.length > 0) {
      this.scrollManager.setFocus(this.panelIds[0]);
    }

    // Register sync group if specified
    if (config.syncGroup && config.syncGroup.length > 0) {
      this.scrollManager.addSyncGroup("default", config.syncGroup);
    }
  }

  /** Get the buffer ID (null if not open) */
  getBufferId(): number | null {
    return this.bufferId;
  }

  /** Get the split ID (null if not open) */
  getSplitId(): number | null {
    return this.splitId;
  }

  /** Get the currently focused panel ID */
  getFocusedPanel(): string {
    return this.scrollManager.focusedLeaf;
  }

  /** Get the scroll manager for direct state access */
  getScrollManager(): ScrollManager {
    return this.scrollManager;
  }

  /** Open the panel layout in a new split */
  async open(opts: { ratio?: number } = {}): Promise<number> {
    if (this.isOpen && this.bufferId !== null) {
      this.update();
      return this.bufferId;
    }

    this.sourceSplitId = this.editor.getActiveSplitId();
    this.sourceBufferId = this.editor.getActiveBufferId();

    // Get viewport dimensions
    const dims = this.editor.getViewportDimensions();
    if (dims) {
      this.viewportWidth = dims.width;
      this.viewportHeight = dims.height;
    }

    const entries = this.buildEntries();
    const scrollRegions = this.buildScrollRegions();

    const result = await this.editor.createVirtualBufferInSplit({
      name: `*${this.modeName}*`,
      mode: this.modeName,
      readOnly: true,
      entries,
      ratio: opts.ratio ?? 0.5,
      panelId: this.modeName,
      showLineNumbers: false,
      editingDisabled: true,
    });

    this.bufferId = result.bufferId;
    this.splitId = result.splitId ?? this.editor.getActiveSplitId();
    this.isOpen = true;

    // Apply scroll regions now that buffer exists
    this.editor.setVirtualBufferContent(this.bufferId, entries, { scrollRegions });

    return this.bufferId;
  }

  /** Close the panel and restore previous state */
  close(): void {
    if (!this.isOpen) return;

    if (this.splitId !== null) {
      this.editor.closeSplit(this.splitId);
    }
    if (this.sourceSplitId !== null) {
      this.editor.focusSplit(this.sourceSplitId);
    }

    this.bufferId = null;
    this.splitId = null;
    this.isOpen = false;
  }

  /** Re-render the panel with current state */
  update(): void {
    if (!this.isOpen || this.bufferId === null) return;

    // Update viewport dimensions
    const dims = this.editor.getViewportDimensions();
    if (dims) {
      this.viewportWidth = dims.width;
      this.viewportHeight = dims.height;
    }

    const entries = this.buildEntries();
    const scrollRegions = this.buildScrollRegions();
    this.editor.setVirtualBufferContent(this.bufferId, entries, { scrollRegions });
  }

  /** Set viewport dimensions (call from resize handler) */
  setViewport(width: number, height: number): void {
    this.viewportWidth = width;
    this.viewportHeight = height;
  }

  /** Cycle focus to the next scrollable panel */
  cycleFocus(): void {
    this.scrollManager.cycleFocus(this.panelIds);
  }

  /** Set focus to a specific panel */
  setFocus(panelId: string): void {
    this.scrollManager.setFocus(panelId);
  }

  /** Scroll the focused panel by delta lines */
  scrollFocused(delta: number): void {
    const focused = this.scrollManager.focusedLeaf;
    if (focused) {
      this.scrollManager.scroll(focused, delta);
    }
  }

  /** Page up the focused panel */
  pageUp(): void {
    const state = this.scrollManager.getFocusedState();
    if (state) {
      this.scrollManager.scroll(this.scrollManager.focusedLeaf, -state.viewport);
    }
  }

  /** Page down the focused panel */
  pageDown(): void {
    const state = this.scrollManager.getFocusedState();
    if (state) {
      this.scrollManager.scroll(this.scrollManager.focusedLeaf, state.viewport);
    }
  }

  /** Scroll to top of focused panel */
  scrollToTop(): void {
    const focused = this.scrollManager.focusedLeaf;
    const state = this.scrollManager.states.get(focused);
    if (state) {
      state.offset = 0;
    }
  }

  /** Scroll to bottom of focused panel */
  scrollToBottom(): void {
    const focused = this.scrollManager.focusedLeaf;
    const state = this.scrollManager.states.get(focused);
    if (state) {
      state.offset = state.maxOffset();
    }
  }

  /** Ensure a specific line is visible in a panel */
  ensureVisible(panelId: string, line: number, height: number = 1): void {
    this.scrollManager.ensureVisible(panelId, line, height);
  }

  /**
   * Handle a mouse scroll event. Call this from your mouse_scroll handler.
   * Returns true if the scroll was handled by a scroll region.
   */
  handleMouseScroll(col: number, row: number, delta: number): boolean {
    if (!this.isOpen) return false;

    // Build the layout to get region rects
    const totalRect = this.getTotalRect();
    const rects = this.computeCurrentLayout(totalRect);

    // Check if mouse is within any scroll panel's rect
    for (const child of this.config.children) {
      if (child.type !== "scroll-panel") continue;
      const rect = rects.get(child.config.id);
      if (!rect) continue;

      // Convert screen coords to buffer-local coords
      // (col/row from the hook are absolute screen coords;
      //  we need to subtract the split's content area origin)
      // For now, use the rect directly since the rects are buffer-local
      // and the caller should pass buffer-local coords
      if (
        col >= rect.x &&
        col < rect.x + rect.w &&
        row >= rect.y &&
        row < rect.y + rect.h
      ) {
        this.scrollManager.scroll(child.config.id, delta);
        this.update();
        return true;
      }
    }

    return false;
  }

  // ─── Internal rendering ─────────────────────────────────────────

  private getTotalRect(): LayoutRect {
    return { x: 0, y: 0, w: this.viewportWidth, h: this.viewportHeight };
  }

  private computeCurrentLayout(totalRect: LayoutRect): Map<string, LayoutRect> {
    // Build the layout tree from config
    let headerHeight = 0;
    let footerHeight = 0;
    if (this.config.header) headerHeight = 1;
    if (this.config.footer) footerHeight = 1;

    const contentRect: LayoutRect = {
      x: totalRect.x,
      y: totalRect.y + headerHeight,
      w: totalRect.w,
      h: totalRect.h - headerHeight - footerHeight,
    };

    const children: LayoutChild[] = [];
    for (const child of this.config.children) {
      switch (child.type) {
        case "scroll-panel":
          children.push({
            node: { type: "leaf", id: child.config.id, size: child.config.size },
            size: child.config.size,
          });
          break;
        case "divider":
          children.push({
            node: { type: "divider", char: child.config.char },
            size: fixed(1),
          });
          break;
        case "fixed-row":
          children.push({
            node: { type: "fixed", id: child.config.id, height: 1 },
            size: fixed(1),
          });
          break;
      }
    }

    const root: LayoutNode = {
      type: "container",
      direction: this.config.direction,
      children,
    };

    return computeLayout(root, contentRect);
  }

  private buildEntries(): TextPropertyEntry[] {
    const entries: TextPropertyEntry[] = [];
    const totalRect = this.getTotalRect();
    const rects = this.computeCurrentLayout(totalRect);

    let headerHeight = 0;
    let footerHeight = 0;
    if (this.config.header) headerHeight = 1;
    if (this.config.footer) footerHeight = 1;

    const contentHeight = totalRect.h - headerHeight - footerHeight;

    // Update scroll states with current viewport heights
    for (const child of this.config.children) {
      if (child.type !== "scroll-panel") continue;
      const rect = rects.get(child.config.id);
      if (!rect) continue;
      const items = child.config.getItems();
      const state = this.scrollManager.getState(child.config.id);
      state.setViewport(rect.h);
      state.setContentHeight(items.length);

      // Auto-scroll selected item into view
      if (child.config.selectedIndex !== undefined && child.config.selectedIndex >= 0) {
        state.ensureVisible(child.config.selectedIndex, 1);
      }
    }

    // Render header
    if (this.config.header) {
      const text = this.config.header.getText();
      entries.push({
        text: text.substring(0, totalRect.w).padEnd(totalRect.w) + "\n",
        style: this.config.header.style,
        properties: { type: "header", panelId: this.config.header.id },
      });
    }

    // Render content rows (merged left-to-right per row)
    for (let row = 0; row < contentHeight; row++) {
      let lineText = "";

      for (const child of this.config.children) {
        switch (child.type) {
          case "scroll-panel": {
            const rect = rects.get(child.config.id);
            if (!rect) break;
            const items = child.config.getItems();
            const state = this.scrollManager.getState(child.config.id);
            const itemIdx = state.offset + row;
            // Reserve 1 col for scrollbar if needed
            const hasScrollbar = state.needsScrollbar();
            const textWidth = hasScrollbar ? rect.w - 1 : rect.w;
            let cellText: string;
            if (itemIdx < items.length) {
              cellText = items[itemIdx].text;
              if (cellText.length > textWidth) {
                cellText = cellText.substring(0, textWidth);
              } else {
                cellText = cellText.padEnd(textWidth);
              }
            } else {
              cellText = " ".repeat(textWidth);
            }
            if (hasScrollbar) {
              cellText += " "; // Placeholder for scrollbar (core renders over this)
            }
            lineText += cellText;
            break;
          }
          case "divider": {
            lineText += child.config.char;
            break;
          }
          case "fixed-row": {
            // Fixed rows in horizontal layout take their allocated width
            const rect = rects.get(child.config.id);
            if (!rect) break;
            const text = child.config.getText();
            lineText += text.substring(0, rect.w).padEnd(rect.w);
            break;
          }
        }
      }

      // Build the entry for this row with per-item styling
      const rowEntries = this.buildRowEntries(row, rects, lineText);
      for (const entry of rowEntries) {
        entries.push(entry);
      }
      entries.push({ text: "\n", properties: { type: "newline" } });
    }

    // Render footer
    if (this.config.footer) {
      const text = this.config.footer.getText();
      entries.push({
        text: text.substring(0, totalRect.w).padEnd(totalRect.w) + "\n",
        style: this.config.footer.style,
        properties: { type: "footer", panelId: this.config.footer.id },
      });
    }

    return entries;
  }

  private buildRowEntries(
    row: number,
    rects: Map<string, LayoutRect>,
    _lineText: string,
  ): TextPropertyEntry[] {
    // Build per-segment entries for proper styling
    const entries: TextPropertyEntry[] = [];

    for (const child of this.config.children) {
      switch (child.type) {
        case "scroll-panel": {
          const rect = rects.get(child.config.id);
          if (!rect) break;
          const items = child.config.getItems();
          const state = this.scrollManager.getState(child.config.id);
          const itemIdx = state.offset + row;
          const hasScrollbar = state.needsScrollbar();
          const textWidth = hasScrollbar ? rect.w - 1 : rect.w;
          const isFocused = this.scrollManager.focusedLeaf === child.config.id;

          let cellText: string;
          let style: Partial<OverlayOptions> | undefined;
          let props: Record<string, unknown> = {
            type: "panel-content",
            panelId: child.config.id,
          };
          let inlineOverlays: InlineOverlay[] | undefined;

          if (itemIdx < items.length) {
            const item = items[itemIdx];
            cellText = item.text;
            if (cellText.length > textWidth) {
              cellText = cellText.substring(0, textWidth);
            } else {
              cellText = cellText.padEnd(textWidth);
            }
            style = item.style;
            if (item.properties) {
              props = { ...props, ...item.properties };
            }
            inlineOverlays = item.inlineOverlays;
          } else {
            cellText = " ".repeat(textWidth);
          }

          if (hasScrollbar) {
            cellText += " "; // Scrollbar column placeholder
          }

          const entry: TextPropertyEntry = {
            text: cellText,
            properties: props,
          };
          if (style) entry.style = style;
          if (inlineOverlays && inlineOverlays.length > 0) {
            entry.inlineOverlays = inlineOverlays;
          }
          entries.push(entry);
          break;
        }
        case "divider": {
          entries.push({
            text: child.config.char,
            style: child.config.style,
            properties: { type: "divider" },
          });
          break;
        }
        case "fixed-row": {
          const rect = rects.get(child.config.id);
          if (!rect) break;
          const text = child.config.getText();
          entries.push({
            text: text.substring(0, rect.w).padEnd(rect.w),
            style: child.config.style,
            properties: { type: "fixed", panelId: child.config.id },
          });
          break;
        }
      }
    }

    return entries;
  }

  private buildScrollRegions(): Array<{
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    totalLines: number;
    offset: number;
  }> {
    const totalRect = this.getTotalRect();
    const rects = this.computeCurrentLayout(totalRect);
    const regions: Array<{
      id: string;
      x: number;
      y: number;
      w: number;
      h: number;
      totalLines: number;
      offset: number;
    }> = [];

    for (const child of this.config.children) {
      if (child.type !== "scroll-panel") continue;
      const rect = rects.get(child.config.id);
      if (!rect) continue;
      const state = this.scrollManager.getState(child.config.id);
      if (!state.needsScrollbar()) continue;

      regions.push({
        id: child.config.id,
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        totalLines: state.contentHeight,
        offset: state.offset,
      });
    }

    return regions;
  }
}
