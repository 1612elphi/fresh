/**
 * Layout Engine - Pure math for computing nested panel layouts
 *
 * Takes a tree of containers and a total rect, outputs a Rect per leaf node.
 * No editor dependency, no rendering, no scroll state.
 */

/** Rectangle in buffer-local coordinates */
export interface LayoutRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Size specification for a child in a container */
export type LayoutSize =
  | { type: "fixed"; value: number }
  | { type: "ratio"; value: number }
  | { type: "flex" };

/** A node in the layout tree */
export type LayoutNode =
  | { type: "container"; direction: "h" | "v"; children: LayoutChild[] }
  | { type: "leaf"; id: string; size: LayoutSize }
  | { type: "divider"; char: string; size?: LayoutSize }
  | { type: "fixed"; id: string; height: number };

/** A child in a container, with its associated size */
export interface LayoutChild {
  node: LayoutNode;
  size: LayoutSize;
}

/** Result of layout computation: id → rect for each leaf */
export type LayoutResult = Map<string, LayoutRect>;

// Convenience constructors

export function fixed(value: number): LayoutSize {
  return { type: "fixed", value };
}

export function ratio(value: number): LayoutSize {
  return { type: "ratio", value };
}

export function flex(): LayoutSize {
  return { type: "flex" };
}

/**
 * Compute layout for a tree of nodes within a bounding rect.
 *
 * Returns a Map from leaf id to its computed LayoutRect.
 */
export function computeLayout(
  root: LayoutNode,
  rect: LayoutRect,
): LayoutResult {
  const result: LayoutResult = new Map();
  layoutNode(root, rect, result);
  return result;
}

function layoutNode(
  node: LayoutNode,
  rect: LayoutRect,
  result: LayoutResult,
): void {
  switch (node.type) {
    case "leaf":
      result.set(node.id, { ...rect });
      break;
    case "fixed":
      result.set(node.id, { ...rect });
      break;
    case "divider":
      // Dividers don't produce output in the result map
      break;
    case "container":
      layoutContainer(node.direction, node.children, rect, result);
      break;
  }
}

function layoutContainer(
  direction: "h" | "v",
  children: LayoutChild[],
  rect: LayoutRect,
  result: LayoutResult,
): void {
  const totalSpace = direction === "h" ? rect.w : rect.h;
  const sizes = distributeSpace(
    children.map((c) => c.size),
    totalSpace,
  );

  let offset = 0;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const size = sizes[i];

    let childRect: LayoutRect;
    if (direction === "h") {
      childRect = { x: rect.x + offset, y: rect.y, w: size, h: rect.h };
    } else {
      childRect = { x: rect.x, y: rect.y + offset, w: rect.w, h: size };
    }

    layoutNode(child.node, childRect, result);
    offset += size;
  }
}

/**
 * Distribute available space among children based on their size specs.
 *
 * 1. Fixed sizes are allocated first
 * 2. Ratio sizes share the remaining space proportionally
 * 3. Flex sizes split whatever remains after fixed and ratio
 */
function distributeSpace(sizes: LayoutSize[], total: number): number[] {
  const result = new Array<number>(sizes.length).fill(0);

  // Pass 1: allocate fixed sizes
  let remaining = total;
  let ratioSum = 0;
  let flexCount = 0;

  for (let i = 0; i < sizes.length; i++) {
    const s = sizes[i];
    if (s.type === "fixed") {
      const val = Math.min(s.value, remaining);
      result[i] = Math.floor(val);
      remaining -= result[i];
    } else if (s.type === "ratio") {
      ratioSum += s.value;
    } else {
      flexCount++;
    }
  }

  // Pass 2: allocate ratio sizes from remaining space
  if (ratioSum > 0) {
    const ratioPool = flexCount > 0 ? remaining : remaining;
    let ratioUsed = 0;
    for (let i = 0; i < sizes.length; i++) {
      const s = sizes[i];
      if (s.type === "ratio") {
        const val = Math.floor((s.value / ratioSum) * ratioPool);
        result[i] = val;
        ratioUsed += val;
      }
    }
    remaining -= ratioUsed;
  }

  // Pass 3: distribute remaining to flex children equally
  if (flexCount > 0 && remaining > 0) {
    const perFlex = Math.floor(remaining / flexCount);
    let flexUsed = 0;
    let lastFlexIdx = -1;
    for (let i = 0; i < sizes.length; i++) {
      if (sizes[i].type === "flex") {
        result[i] = perFlex;
        flexUsed += perFlex;
        lastFlexIdx = i;
      }
    }
    // Give any leftover pixel to the last flex child
    if (lastFlexIdx >= 0) {
      result[lastFlexIdx] += remaining - flexUsed;
    }
  }

  return result;
}
