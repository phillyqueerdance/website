// Keep connected bubbles close and leave space between their outlines.
export const MIN_BUBBLE_HIT_RADIUS = 13;
export const SMALL_BUBBLE_LABEL_WIDTH = 80;
export const SMALL_BUBBLE_LABEL_HEIGHT = 27;
export const SMALL_BUBBLE_LABEL_GAP = 3;

export function relationshipStrength(count) {
  const weight = Math.log(count);
  return weight / (weight + 1);
}

export function linkGap(width, height) {
  return Math.min(32, Math.max(12, Math.min(width, height) * .062));
}

export function keepInView(bubble, width, height) {
  const margin = Math.min(8, Math.min(width, height) * .03);
  const hitRadius = Math.max(bubble.radius, MIN_BUBBLE_HIT_RADIUS);
  const side = margin + (bubble.labelOutside ? Math.max(hitRadius, SMALL_BUBBLE_LABEL_WIDTH / 2) : hitRadius);
  const bottom = margin + (bubble.labelOutside
    ? Math.max(hitRadius, bubble.radius + SMALL_BUBBLE_LABEL_GAP + SMALL_BUBBLE_LABEL_HEIGHT) : hitRadius);
  bubble.targetX = Math.max(side, Math.min(width - side, bubble.targetX));
  bubble.targetY = Math.max(hitRadius + margin, Math.min(height - bottom, bubble.targetY));
}

function movePair(a, b, distance, dx, dy, gap, strength, held) {
  const pull = (distance - gap) * strength / distance;
  if (a.parent && a !== held) {
    a.targetX += dx * pull;
    a.targetY += dy * pull;
  }
  if (b.parent && b !== held) {
    b.targetX -= dx * pull;
    b.targetY -= dy * pull;
  }
}

export function settleBubbles(bubbles, width, height, held) {
  const nodes = [...bubbles.values()];
  const gap = linkGap(width, height);
  for (let pass = 0; pass < 38; pass++) {
    for (const child of nodes) {
      const parent = bubbles.get(child.parent);
      if (!parent) continue;
      const dx = child.targetX - parent.targetX, dy = child.targetY - parent.targetY;
      const distance = Math.hypot(dx, dy);
      if (distance > 0) movePair(parent, child, distance, dx, dy, parent.radius + child.radius + gap, .11, held);
    }
    for (const [index, a] of nodes.entries()) {
      for (let next = index + 1; next < nodes.length; next++) {
        const b = nodes[next];
        const dx = b.targetX - a.targetX || .01, dy = b.targetY - a.targetY;
        const distance = Math.hypot(dx, dy);
        const clearance = Math.max(a.radius, a.labelOutside ? 23 : MIN_BUBBLE_HIT_RADIUS) +
          Math.max(b.radius, b.labelOutside ? 23 : MIN_BUBBLE_HIT_RADIUS) + 12;
        if (distance < clearance) movePair(a, b, distance, dx, dy, clearance, .54, held);
      }
    }
    for (const bubble of nodes) keepInView(bubble, width, height);
  }
}
