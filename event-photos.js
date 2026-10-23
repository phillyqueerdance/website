// Event-owned photos, shared by public APIs, server HTML, and the browser.
(() => {
  const parse = value => {
    const items = Array.isArray(value) ? value : String(value || "").split(/\r?\n/);
    return [...new Set(items.filter(item => typeof item === "string").map(item => {
      try {
        const url = new URL(item.trim());
        return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
      } catch { return ""; }
    }).filter(Boolean))];
  };
  const urls = event => parse(event?.photoUrls ?? event?.PhotoURLs);
  const escape = value => String(value ?? "").replace(/[&<>"']/g, char =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

  function gallery(event) {
    const photos = urls(event);
    if (!photos.length) return "";
    const meta = globalThis.QDPEventMetadata;
    const title = meta.cleanTitle(event);
    const links = photos.map((url, index) => {
      const src = meta.image({ flyerUrl: url });
      const label = `Photo ${index + 1} from ${title}`;
      return `<a class="event-photo" href="${escape(src)}" target="_blank" rel="noopener noreferrer" data-event-photo aria-label="View ${escape(label)}"${index ? " hidden" : ""}><img src="${escape(src)}" alt="${escape(label)}" loading="lazy" decoding="async" referrerpolicy="no-referrer"></a>`;
    }).join("");
    const hidden = photos.length < 2 ? " hidden" : "";
    return `<section class="event-photos" aria-label="Event photos" data-photo-index="0"><div class="event-photo-heading"><h3>Photos</h3><span class="event-photo-position" aria-live="polite">1 / ${photos.length}</span></div><div class="event-photo-carousel" aria-roledescription="carousel"><div class="event-photo-slides">${links}</div><button type="button" class="event-photo-previous" data-photo-direction="-1" aria-label="Previous photo"${hidden}>←</button><button type="button" class="event-photo-next" data-photo-direction="1" aria-label="Next photo"${hidden}>→</button></div></section>`;
  }

  function strip(event, card, href) {
    const count = urls(event).length;
    if (!count) return card;
    const indicator = `<span class="event-photo-toggle">${count} photo${count === 1 ? "" : "s"} <span aria-hidden="true">⌄</span></span>`;
    const summary = card.replace(/^<a /, '<summary ').replace(/\shref="[^"]*"/, "")
      .replace(/<\/a>$/, `${indicator}</summary>`);
    return `<details class="event-photo-strip${event.explicitQueer ? " explicit" : " default"}" name="event-photos" data-event-id="${escape(event.eventId)}">${summary}<div class="event-photo-dropdown">${gallery(event)}<a class="event-photo-go" href="${escape(href)}">Go to event</a></div></details>`;
  }

  function moveGallery(section, direction) {
    const slides = [...section.querySelectorAll("a[data-event-photo]")];
    if (!slides.length) return;
    const index = ((Number(section.dataset.photoIndex) || 0) + direction + slides.length) % slides.length;
    slides.forEach((slide, number) => { slide.hidden = number !== index; });
    section.dataset.photoIndex = String(index);
    section.querySelector(".event-photo-position").textContent = `${index + 1} / ${slides.length}`;
  }

  globalThis.QDPEventPhotos = Object.freeze({ parse, urls, gallery, strip, moveGallery });
  if (typeof document === "undefined") return;

  // Keep one event expanded, including browsers without native details grouping.
  document.addEventListener("toggle", event => {
    const details = event.target;
    if (!details.matches?.(".event-photo-strip")) return;
    if (details.open) document.querySelectorAll(".event-photo-strip[open]").forEach(other => {
      if (other !== details) other.open = false;
    });
    if (globalThis.QDPArchive?.active) globalThis.QDPArchive.updateLayout();
    else globalThis.QDPUpdatePhotoLayout?.();
  }, true);
  document.addEventListener("error", event => {
    const image = event.target;
    if (!image.matches?.(".event-photo img")) return;
    const fallback = document.createElement("span");
    fallback.className = "event-photo-unavailable";
    fallback.textContent = "Open photo";
    image.replaceWith(fallback);
  }, true);

  let viewer, image, caption, previous, next, photos = [], current = 0, trigger, touch;
  function show(index) {
    current = (index + photos.length) % photos.length;
    image.src = photos[current].href;
    image.alt = photos[current].querySelector("img")?.alt || `Event photo ${current + 1}`;
    caption.textContent = `${current + 1} / ${photos.length}`;
    previous.hidden = next.hidden = photos.length < 2;
  }
  function close() {
    viewer.close();
    image.removeAttribute("src");
    trigger?.focus({ preventScroll: true });
  }
  function createViewer() {
    viewer = document.createElement("dialog");
    viewer.className = "event-photo-viewer";
    viewer.setAttribute("aria-label", "Event photo viewer");
    viewer.innerHTML = '<button type="button" class="event-photo-close" aria-label="Close photo">×</button><img class="event-photo-full" alt=""><div class="event-photo-controls"><button type="button" aria-label="Previous photo">←</button><span aria-live="polite"></span><button type="button" aria-label="Next photo">→</button></div>';
    document.body.appendChild(viewer);
    image = viewer.querySelector("img");
    image.referrerPolicy = "no-referrer";
    caption = viewer.querySelector("span");
    previous = viewer.querySelector('[aria-label="Previous photo"]');
    next = viewer.querySelector('[aria-label="Next photo"]');
    viewer.querySelector(".event-photo-close").addEventListener("click", close);
    previous.addEventListener("click", () => show(current - 1));
    next.addEventListener("click", () => show(current + 1));
    viewer.addEventListener("click", event => {
      event.stopPropagation();
      if (event.target === viewer) close();
    });
    viewer.addEventListener("cancel", event => { event.preventDefault(); close(); });
    viewer.addEventListener("wheel", event => event.stopPropagation(), { passive: true });
    viewer.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); close(); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); show(current - 1); }
      else if (event.key === "ArrowRight") { event.preventDefault(); show(current + 1); }
    });
    viewer.addEventListener("touchstart", event => { touch = event.touches[0]; }, { passive: true });
    viewer.addEventListener("touchend", event => {
      const end = event.changedTouches[0];
      if (touch && end && Math.abs(end.clientX - touch.clientX) > 60 &&
          Math.abs(end.clientY - touch.clientY) < 80) show(current + (end.clientX < touch.clientX ? 1 : -1));
      touch = null;
    }, { passive: true });
  }
  document.addEventListener("keydown", event => {
    const section = event.target.closest?.(".event-photos");
    if (!section || !["ArrowLeft", "ArrowRight"].includes(event.key) ||
        event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    moveGallery(section, event.key === "ArrowRight" ? 1 : -1);
  });
  let swipe;
  document.addEventListener("touchstart", event => {
    const section = event.target.closest?.(".event-photo-carousel")?.closest(".event-photos");
    if (!section || event.touches.length !== 1) return;
    event.stopPropagation();
    swipe = { section, x: event.touches[0].clientX, y: event.touches[0].clientY };
  }, { capture: true, passive: true });
  document.addEventListener("touchend", event => {
    if (!swipe) return;
    event.stopPropagation();
    const end = event.changedTouches[0];
    if (end && Math.abs(end.clientX - swipe.x) > 60 && Math.abs(end.clientY - swipe.y) < 80) {
      moveGallery(swipe.section, end.clientX < swipe.x ? 1 : -1);
    }
    swipe = null;
  }, { capture: true, passive: true });
  document.addEventListener("touchcancel", () => { swipe = null; }, { passive: true });
  document.addEventListener("click", event => {
    const arrow = event.target.closest?.("button[data-photo-direction]");
    if (arrow) {
      event.preventDefault();
      event.stopPropagation();
      moveGallery(arrow.closest(".event-photos"), Number(arrow.dataset.photoDirection));
      return;
    }
    const link = event.target.closest?.("a[data-event-photo]");
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey ||
        event.ctrlKey || event.shiftKey || event.altKey || typeof HTMLDialogElement === "undefined") return;
    if (!viewer) createViewer();
    event.preventDefault();
    trigger = link;
    photos = [...link.closest(".event-photo-slides").querySelectorAll("a[data-event-photo]")];
    show(photos.indexOf(link));
    viewer.showModal();
  });
})();
