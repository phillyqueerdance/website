// Keep connected bubbles close and leave space between their outlines.
export const MIN_BUBBLE_HIT_RADIUS = 13;
export const SMALL_BUBBLE_LABEL_WIDTH = 90;
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
  const side = margin + (bubble.labelOutside ? Math.max(hitRadius, (bubble.labelWidth || SMALL_BUBBLE_LABEL_WIDTH) / 2) : hitRadius);
  const bottom = margin + (bubble.labelOutside
    ? Math.max(hitRadius, bubble.radius + SMALL_BUBBLE_LABEL_GAP + SMALL_BUBBLE_LABEL_HEIGHT) : hitRadius);
  bubble.targetX = Math.max(side, Math.min(width - side, bubble.targetX));
  bubble.targetY = Math.max(hitRadius + margin, Math.min(height - bottom, bubble.targetY));
}

export function orderNeighbors(neighbors, lines) {
  const slots = new Map(neighbors.map((bubble, index) => [bubble, index]));
  const pairs = lines.filter(line => slots.has(line.source) && slots.has(line.target));
  if (!pairs.length) return neighbors;
  const span = () => pairs.reduce((sum, line) => {
    const distance = Math.abs(slots.get(line.source) - slots.get(line.target));
    return sum + Math.min(distance, neighbors.length - distance) * Math.min(3, line.link.count);
  }, 0);
  let best = span();
  // Keep related neighbors on nearby parts of the ring so their chords cross fewer spokes.
  for (let pass = 0; pass < 3; pass++) {
    const before = best;
    for (const [index, a] of neighbors.entries()) {
      for (const b of neighbors.slice(index + 1)) {
        const first = slots.get(a), second = slots.get(b);
        slots.set(a, second);
        slots.set(b, first);
        const cost = span();
        if (cost < best) best = cost;
        else {
          slots.set(a, first);
          slots.set(b, second);
        }
      }
    }
    if (best === before) break;
  }
  return neighbors.sort((a, b) => slots.get(a) - slots.get(b));
}

function separation(a, b) {
  return Math.max(a.radius, a.labelOutside ? (a.labelWidth || SMALL_BUBBLE_LABEL_WIDTH) / 2 : MIN_BUBBLE_HIT_RADIUS) +
    Math.max(b.radius, b.labelOutside ? (b.labelWidth || SMALL_BUBBLE_LABEL_WIDTH) / 2 : MIN_BUBBLE_HIT_RADIUS) + 12;
}

export function placeOuterBubble(bubble, parent, center, bubbles, width, height) {
  const angle = Math.atan2(parent.targetY - center.targetY, parent.targetX - center.targetX);
  const distance = parent.radius + bubble.radius + linkGap(width, height);
  let best = { score: Infinity };
  for (const turn of [0, -.65, .65, -1.3, 1.3, -1.95, 1.95]) {
    bubble.targetX = parent.targetX + Math.cos(angle + turn) * distance;
    bubble.targetY = parent.targetY + Math.sin(angle + turn) * distance;
    keepInView(bubble, width, height);
    let score = Math.abs(turn) * 35;
    for (const other of bubbles) {
      if (other === bubble || !Number.isFinite(other.targetX)) continue;
      const gap = Math.hypot(other.targetX - bubble.targetX, other.targetY - bubble.targetY);
      score += Math.max(0, separation(bubble, other) - gap) ** 2;
    }
    if (score < best.score) best = { score, x: bubble.targetX, y: bubble.targetY };
  }
  bubble.targetX = best.x;
  bubble.targetY = best.y;
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
  for (let pass = 0; pass < 38; pass++) {
    for (const [index, a] of nodes.entries()) {
      for (let next = index + 1; next < nodes.length; next++) {
        const b = nodes[next];
        const dx = b.targetX - a.targetX || .01, dy = b.targetY - a.targetY;
        const distance = Math.hypot(dx, dy);
        const clearance = separation(a, b);
        if (distance < clearance) movePair(a, b, distance, dx, dy, clearance, .54, held);
      }
    }
    for (const bubble of nodes) keepInView(bubble, width, height);
  }
}
