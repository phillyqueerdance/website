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
    const inText = Math.random() < 0.48;
    const inFront = Math.random() < 0.42;
    const edge = Math.floor(Math.random() * 4);
    const along = 0.12 + Math.random() * 0.76;
    const x = inText ? width * along :
      edge === 0 ? -8 : edge === 1 ? width + 8 : width * along;
    const y = inText ? height * (0.15 + Math.random() * 0.7) :
      edge === 2 ? -8 : edge === 3 ? height + 8 : height * along;
    const element = document.createElement("span");
    const svg = document.createElementNS(svgNamespace, "svg");
    const path = document.createElementNS(svgNamespace, "path");

    element.className = "menu-sparkle menu-sparkle--" + (inFront ? "front" : "back");
    element.setAttribute("aria-hidden", "true");
    element.style.left = x + "px";
    element.style.top = y + "px";
    element.style.setProperty("--sparkle-size", (12 + Math.random() * 7).toFixed(1) + "px");

    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    path.setAttribute("d", "M12 0 C13.5 8.5 15.5 10.5 24 12 C15.5 13.5 13.5 15.5 12 24 C10.5 15.5 8.5 13.5 0 12 C8.5 10.5 10.5 8.5 12 0Z");
    svg.append(path);
    element.append(svg);

    const existing = link.querySelectorAll(".menu-sparkle");
    if (existing.length >= 4) existing[0].remove();
    link.append(element);

    element.addEventListener("animationend", event => {
      if (event.target === element) element.remove();
    });

    nextSparkleTimer = window.setTimeout(() => sparkle(link), 420 + Math.random() * 420);
  }

  function start(link) {
    if (!canSparkle(link) || activeLink === link) return;
    stop();
    activeLink = link;
    nextSparkleTimer = window.setTimeout(() => sparkle(link), 80 + Math.random() * 140);
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
