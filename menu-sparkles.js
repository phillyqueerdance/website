(() => {
  "use strict";

  const links = document.querySelectorAll(".side-nav-links > a");
  const desktopHover = window.matchMedia("(min-width: 761px) and (hover: hover)");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const svgNamespace = "http://www.w3.org/2000/svg";
  let activeLink = null;
  let nextSparkleTimer = null;

  function stop() {
    window.clearTimeout(nextSparkleTimer);
    nextSparkleTimer = null;
    if (activeLink) {
      activeLink.querySelectorAll(".menu-sparkle").forEach(sparkle => sparkle.remove());
    }
    activeLink = null;
  }

  function canSparkle(link) {
    return desktopHover.matches && !reducedMotion.matches &&
      (link.matches(":hover") || link.matches(":focus-visible"));
  }

  function sparkle(link) {
    if (link !== activeLink || !canSparkle(link)) {
      stop();
      return;
    }

    const width = link.getBoundingClientRect().width;
    const height = link.getBoundingClientRect().height;
    const edge = Math.floor(Math.random() * 4);
    const along = 0.15 + Math.random() * 0.7;
    const x = edge === 0 ? -9 : edge === 1 ? width + 9 : width * along;
    const y = edge === 2 ? -9 : edge === 3 ? height + 9 : height * along;
    const element = document.createElement("span");
    const svg = document.createElementNS(svgNamespace, "svg");
    const path = document.createElementNS(svgNamespace, "path");

    element.className = "menu-sparkle";
    element.setAttribute("aria-hidden", "true");
    element.style.left = x + "px";
    element.style.top = y + "px";
    element.style.setProperty("--sparkle-size", (8 + Math.random() * 4).toFixed(1) + "px");

    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    path.setAttribute("d", "M12 0 C13.5 8.5 15.5 10.5 24 12 C15.5 13.5 13.5 15.5 12 24 C10.5 15.5 8.5 13.5 0 12 C8.5 10.5 10.5 8.5 12 0Z");
    svg.append(path);
    element.append(svg);

    const existing = link.querySelectorAll(".menu-sparkle");
    if (existing.length >= 2) existing[0].remove();
    link.append(element);

    element.addEventListener("animationend", event => {
      if (event.target === element) element.remove();
    });

    nextSparkleTimer = window.setTimeout(() => sparkle(link), 1000 + Math.random() * 900);
  }

  function start(link) {
    if (!canSparkle(link) || activeLink === link) return;
    stop();
    activeLink = link;
    nextSparkleTimer = window.setTimeout(() => sparkle(link), 160 + Math.random() * 240);
  }

  links.forEach(link => {
    link.addEventListener("pointerenter", () => start(link));
    link.addEventListener("pointerleave", () => {
      if (activeLink === link && !link.matches(":focus-visible")) stop();
    });
    link.addEventListener("focus", () => start(link));
    link.addEventListener("blur", () => {
      if (activeLink === link && !link.matches(":hover")) stop();
    });
  });

  desktopHover.addEventListener("change", () => { if (!desktopHover.matches) stop(); });
  reducedMotion.addEventListener("change", () => { if (reducedMotion.matches) stop(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });
  window.addEventListener("blur", stop);
})();
