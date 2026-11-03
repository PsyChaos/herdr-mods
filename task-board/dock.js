// The board docked in a (personal) layout: under the agents list in the left
// sidebar, or as its own column right of the work area. The block's id is
// `tasks`; moving it rewrites the shown layout with layout.set.

import { layout, run } from "herdr";

export const BLOCK_ID = "tasks";
const LEFT_PARENT = "sidebar-lists";
const RIGHT_PARENT = "work-body";

const LEFT_BLOCK = {
  id: BLOCK_ID,
  type: "block",
  size: { weight: 1 },
  min: 90,
  content: { mod: "task-board" },
};

const RIGHT_BLOCK = {
  id: BLOCK_ID,
  type: "block",
  size: { px: 260 },
  min: 200,
  max: 640,
  background: "chrome",
  radius: 10,
  border: { width: 1, color: "border" },
  content: { mod: "task-board" },
};

function parentOf(node, id, parent = null) {
  if (node?.id === id) return parent ?? node;
  for (const child of node?.children ?? []) {
    const found = parentOf(child, id, node);
    if (found) return found;
  }
  return null;
}

// "left", "right", or null when the shown layout has no docked board.
export function dockSide() {
  const parent = parentOf(layout(), BLOCK_ID);
  if (!parent) return null;
  return parent.id === RIGHT_PARENT ? "right" : "left";
}

// A copy of the tree without the board, with `block` added to `parentId`.
function rebuild(node, parentId, block) {
  if (!node.children) return { ...node };
  const children = node.children.filter((c) => c.id !== BLOCK_ID).map((c) => rebuild(c, parentId, block));
  return { ...node, children: node.id === parentId ? [...children, block] : children };
}

export function moveDock() {
  const side = dockSide();
  if (!side) return;
  const next = side === "left" ? rebuild(layout(), RIGHT_PARENT, RIGHT_BLOCK) : rebuild(layout(), LEFT_PARENT, LEFT_BLOCK);
  run("layout.set", { layout: next });
}

export const hideDock = () => run("layout.hide", { id: BLOCK_ID });
