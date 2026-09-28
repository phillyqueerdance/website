(() => {
  "use strict";

  const menu = document.querySelector(".side-nav-links");
  if (!menu) return;

  const links = menu.querySelectorAll(":scope > a");
  const desktopHover = window.matchMedia("(min-width: 761px) and (hover: hover)");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const svgNamespace = "http://www.w3.org/2000/svg";
  const sparkleColors = ["#fa2b5a", "#ff7945", "#922185"];
  const fields = ["back", "front"].map(layer => {
    const field = document.createElement("span");
    field.className = "menu-sparkle-field menu-sparkle-field--" + layer;
    field.setAttribute("aria-hidden", "true");
    menu.append(field);
    return field;
  });
  let nextColor = Math.floor(Math.random() * sparkleColors.length);
  let pointerInside = false;
  let hoveredLink = null;
  let focusedLink = null;
  let lastTrailAt = -Infinity;
  let lastTrailPoint = null;
  let orbitTimer = null;

  function enabled() {
    return desktopHover.matches && !reducedMotion.matches;
  }

  function clear() {
    window.clearTimeout(orbitTimer);
    orbitTimer = null;
    fields.forEach(field => field.replaceChildren());
    pointerInside = false;
    hoveredLink = null;
    lastTrailAt = -Infinity;
    lastTrailPoint = null;
  }

  function sparkle(x, y, size = 12 + Math.random() * 7) {
    if (!enabled()) return;
    const inFront = Math.random() < 0.4;
    const field = fields[inFront ? 1 : 0];
    const element = document.createElement("span");
    const svg = document.createElementNS(svgNamespace, "svg");
    const path = document.createElementNS(svgNamespace, "path");

    element.className = "menu-sparkle menu-sparkle--" + (inFront ? "front" : "back");
    element.setAttribute("aria-hidden", "true");
    element.style.color = sparkleColors[nextColor];
    nextColor = (nextColor + 1) % sparkleColors.length;
    element.style.left = x + "px";
    element.style.top = y + "px";
    element.style.setProperty("--sparkle-size", size.toFixed(1) + "px");

    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    path.setAttribute("d", "M12 0 C13.5 8.5 15.5 10.5 24 12 C15.5 13.5 13.5 15.5 12 24 C10.5 15.5 8.5 13.5 0 12 C8.5 10.5 10.5 8.5 12 0Z");
    svg.append(path);
    element.append(svg);
    field.append(element);

    const all = [...fields[0].children, ...fields[1].children];
    if (all.length > 16) all[0].remove();
    element.addEventListener("animationend", event => {
      if (event.target === element) element.remove();
    });
  }

  function around(link, count = 1) {
    if (!enabled()) return;
    const linkRect = link.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    for (let index = 0; index < count; index++) {
      const across = 0.12 + Math.random() * 0.76;
      const inside = Math.random() < 0.34;
      const edge = Math.floor(Math.random() * 4);
      const x = inside ? linkRect.left + linkRect.width * across :
        edge === 0 ? linkRect.left - 8 :
        edge === 1 ? linkRect.right + 8 :
        linkRect.left + linkRect.width * across;
      const y = inside ? linkRect.top + linkRect.height * (0.12 + Math.random() * 0.76) :
        edge === 2 ? linkRect.top - 8 :
        edge === 3 ? linkRect.bottom + 8 :
        linkRect.top + linkRect.height * across;
      sparkle(x - menuRect.left, y - menuRect.top);
    }
  }

  function scheduleOrbit() {
    if (orbitTimer || !enabled() || (!pointerInside && !focusedLink)) return;
    orbitTimer = window.setTimeout(() => {
      orbitTimer = null;
      const link = hoveredLink || focusedLink;
      if (link) around(link);
      scheduleOrbit();
    }, 230 + Math.random() * 220);
  }

  function trail(clientX, clientY) {
    const menuRect = menu.getBoundingClientRect();
    const x = clientX - menuRect.left;
    const y = clientY - menuRect.top;
    const now = performance.now();
    const distance = lastTrailPoint ?
      Math.hypot(x - lastTrailPoint.x, y - lastTrailPoint.y) : Infinity;
    if (now - lastTrailAt < 80 || distance < 6) return;
    lastTrailAt = now;
    lastTrailPoint = { x, y };
    sparkle(x + (Math.random() - 0.5) * 22,
      y + (Math.random() - 0.5) * 22, 10 + Math.random() * 5);
  }

  menu.addEventListener("pointerenter", event => {
    if (!enabled() || event.pointerType === "touch") return;
    pointerInside = true;
    trail(event.clientX, event.clientY);
    scheduleOrbit();
  });
  menu.addEventListener("pointermove", event => {
    if (!enabled() || event.pointerType === "touch") return;
    pointerInside = true;
    trail(event.clientX, event.clientY);
    scheduleOrbit();
  });
  menu.addEventListener("pointerleave", () => {
    if (!focusedLink) clear();
    else {
      pointerInside = false;
      hoveredLink = null;
    }
  });

  links.forEach(link => {
    link.addEventListener("pointerenter", event => {
      if (!enabled() || event.pointerType === "touch") return;
      hoveredLink = link;
      around(link, 3);
      scheduleOrbit();
    });
    link.addEventListener("pointerleave", () => {
      if (hoveredLink === link) hoveredLink = null;
    });
    link.addEventListener("focus", () => {
      if (!enabled() || !link.matches(":focus-visible")) return;
      focusedLink = link;
      around(link, 3);
      scheduleOrbit();
    });
    link.addEventListener("blur", () => {
      if (focusedLink === link) focusedLink = null;
      if (!pointerInside) clear();
    });
  });

  desktopHover.addEventListener("change", () => { if (!desktopHover.matches) clear(); });
  reducedMotion.addEventListener("change", () => { if (reducedMotion.matches) clear(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) clear(); });
  window.addEventListener("blur", clear);
})();
