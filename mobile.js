(() => {
  const media = matchMedia("(max-width: 760px)");
  const nav = document.querySelector(".side-nav");
  const primary = document.querySelector(".mobile-primary");
  const moreButton = document.getElementById("mobileMenuButton");
  const moreLinks = document.getElementById("siteMenuLinks");
  const moreClose = document.getElementById("mobileMoreClose");
  const discoverButton = document.getElementById("mobileDiscoverButton");
  const discoverLink = document.getElementById("discoverLink");
  const discoverClose = document.getElementById("mobileDiscoverClose");
  const track = document.getElementById("archiveMenuTrack");
  const menu = document.getElementById("archiveMenu");
  const profile = document.getElementById("archiveMenuProfile");
  const context = document.getElementById("mobileContext");
  const profileButton = document.getElementById("mobileProfileInfo");
  const alphabet = document.getElementById("archiveAlphabet");
  const alphabetHome = alphabet.parentElement;
  const stage = document.querySelector(".poster-stage");
  const detail = document.getElementById("eventDetail");
  const archiveStack = document.getElementById("archiveStack");
  const backdrop = document.getElementById("mobileSheetBackdrop");
  const calendar = document.getElementById("mobileCalendarLink");
  const directoryViews = new Set(["artists", "venues", "parties", "collectives"]);
  const profileViews = new Set(["artist", "venue", "party", "collective"]);
  let returnFocus = null;
  let syncFrame = 0;
  let alphabetFrame = 0;
  let wasMoreOpen = false;

  const view = () => new URLSearchParams(location.search).get("archive") || "";
  const discoverOpen = () => document.body.classList.contains("mobile-discover-open");
  function toggleClass(element, name, value) {
    if (element.classList.contains(name) !== value) element.classList.toggle(name, value);
  }
  function pushPanel(kind) {
    if (history.state?.qdpMobilePanel !== kind) {
      history.pushState({ ...history.state, qdpMobilePanel: kind }, "", location.href);
    }
  }
  function closeMore({ restoreFocus = false, historyEntry = false } = {}) {
    const open = nav.classList.contains("menu-open");
    toggleClass(nav, "menu-open", false);
    moreButton.setAttribute("aria-expanded", "false");
    sync();
    if (historyEntry && history.state?.qdpMobilePanel === "more") history.back();
    if (open && restoreFocus) moreButton.focus({ preventScroll: true });
  }
  function closeDiscover({ restoreFocus = false, historyEntry = false } = {}) {
    const open = discoverOpen();
    toggleClass(document.body, "mobile-discover-open", false);
    sync();
    if (historyEntry && history.state?.qdpMobilePanel === "discover") history.back();
    if (open && restoreFocus) (returnFocus?.isConnected ? returnFocus : discoverButton).focus({ preventScroll: true });
  }
  function openDiscover({ historyEntry = true } = {}) {
    if (!media.matches) return;
    returnFocus = document.activeElement;
    closeMore();
    if (window.QDPInfoView?.active) {
      const url = new URL(location.href);
      url.hash = "";
      const { qdpInfo, ...state } = history.state || {};
      history.replaceState(state, "", url);
      window.QDPInfoView.close({ historyEntry: false, preserveMenu: true });
    }
    window.QDPArchive.showMenu(view());
    toggleClass(document.body, "mobile-discover-open", true);
    if (historyEntry) pushPanel("discover");
    sync();
    requestAnimationFrame(() => discoverClose.focus({ preventScroll: true }));
  }
  function updateAlphabet() {
    if (!media.matches || context.hidden || alphabet.hidden) return;
    const sections = [...archiveStack.querySelectorAll(".archive-section[data-letter]")];
    const boundary = archiveStack.getBoundingClientRect().top + 4;
    let current = sections[0]?.dataset.letter;
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= boundary) current = section.dataset.letter;
    }
    for (const button of alphabet.querySelectorAll("button")) {
      if (button.dataset.letter === current) {
        if (button.getAttribute("aria-current") !== "true") {
          button.setAttribute("aria-current", "true");
          const left = button.offsetLeft - (alphabet.clientWidth - button.offsetWidth) / 2;
          alphabet.scrollTo({ left, behavior: "auto" });
        }
      } else button.removeAttribute("aria-current");
    }
  }
  function sync() {
    if (!media.matches) return;
    const currentView = view();
    const infoOpen = Boolean(window.QDPInfoView?.active);
    const detailOpen = !detail.hidden && !infoOpen;
    const panelOpen = discoverOpen();
    const moreOpen = nav.classList.contains("menu-open");
    const isDirectory = directoryViews.has(currentView) && window.QDPArchive?.active;
    const isProfile = profileViews.has(currentView) && window.QDPArchive?.active;
    toggleClass(document.body, "mobile-detail-open", detailOpen);
    toggleClass(document.body, "mobile-more-open", moreOpen);
    context.hidden = !(isDirectory || isProfile) || detailOpen || infoOpen;
    profileButton.hidden = !isProfile;
    profileButton.disabled = isProfile && profile.hidden;
    const name = document.querySelector(".archive-profile-heading")?.textContent;
    profileButton.setAttribute("aria-label", name ? `Info and links for ${name}` : "Info and links");
    for (const button of [discoverButton, discoverLink, profileButton]) button.setAttribute("aria-expanded", String(panelOpen));
    calendar.dataset.active = String(!currentView && !infoOpen);
    discoverButton.dataset.active = String(Boolean(currentView) && !infoOpen);
    moreButton.dataset.active = String(infoOpen);
    if (!currentView && !infoOpen) calendar.setAttribute("aria-current", "page");
    else calendar.removeAttribute("aria-current");
    backdrop.hidden = !panelOpen && !moreOpen;
    stage.inert = panelOpen || moreOpen;
    primary.inert = panelOpen || moreOpen;
    moreLinks.inert = panelOpen;
    track.inert = !panelOpen;
    if (moreOpen && !wasMoreOpen) requestAnimationFrame(() => moreClose.focus({ preventScroll: true }));
    wasMoreOpen = moreOpen;
    updateAlphabet();
  }
  function scheduleSync() {
    if (syncFrame) return;
    syncFrame = requestAnimationFrame(() => { syncFrame = 0; sync(); });
  }
  function setMode() {
    if (media.matches) {
      context.prepend(alphabet);
      track.setAttribute("role", "dialog");
      track.setAttribute("aria-modal", "true");
      track.setAttribute("aria-labelledby", "discoverHeading");
      moreLinks.setAttribute("role", "dialog");
      moreLinks.setAttribute("aria-modal", "true");
      moreLinks.setAttribute("aria-labelledby", "mobileMoreHeading");
      closeMore();
      sync();
    } else {
      const keepDiscover = discoverOpen();
      toggleClass(document.body, "mobile-discover-open", false);
      toggleClass(document.body, "mobile-more-open", false);
      toggleClass(document.body, "mobile-detail-open", false);
      closeMore();
      alphabetHome.append(alphabet);
      context.hidden = true;
      backdrop.hidden = true;
      for (const element of [stage, primary, moreLinks, track]) element.inert = false;
      for (const element of [track, moreLinks]) {
        element.removeAttribute("role");
        element.removeAttribute("aria-modal");
        element.removeAttribute("aria-labelledby");
      }
      alphabet.querySelectorAll("[aria-current]").forEach(button => button.removeAttribute("aria-current"));
      if (!window.QDPInfoView?.active && (window.QDPArchive?.active || keepDiscover)) window.QDPArchive.showMenu(view());
      else window.QDPArchive?.hideMenu();
    }
  }

  window.QDPMobile = { get active() { return media.matches; }, openDiscover, closeDiscover };
  discoverButton.addEventListener("click", event => { event.stopPropagation(); openDiscover(); });
  profileButton.addEventListener("click", event => { event.stopPropagation(); openDiscover(); });
  discoverClose.addEventListener("click", event => { event.stopPropagation(); closeDiscover({ restoreFocus: true, historyEntry: true }); });
  moreClose.addEventListener("click", event => { event.stopPropagation(); closeMore({ restoreFocus: true, historyEntry: true }); });
  moreButton.addEventListener("click", () => {
    if (!media.matches) return;
    if (nav.classList.contains("menu-open")) { closeDiscover(); pushPanel("more"); }
    else if (history.state?.qdpMobilePanel === "more") history.back();
    sync();
  });
  backdrop.addEventListener("click", event => {
    event.stopPropagation();
    if (discoverOpen()) closeDiscover({ restoreFocus: true, historyEntry: true });
    else closeMore({ restoreFocus: true, historyEntry: true });
  });
  document.addEventListener("click", event => {
    if (!media.matches || event.defaultPrevented && !event.target.closest("a[data-archive-link], #aboutLink, #meltLink")) return;
    const anchor = event.target.closest("a");
    if (!anchor || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (anchor.matches("[data-archive-link], #aboutLink, #meltLink")) {
      closeDiscover();
      closeMore();
      requestAnimationFrame(() => {
        sync();
        const target = window.QDPInfoView?.active
          ? document.getElementById(`${window.QDPInfoView.active}CloseButton`)
          : document.getElementById(window.QDPArchive?.active ? "archiveStack" : "eventStack");
        target?.focus({ preventScroll: true });
      });
    } else if (moreLinks.contains(anchor)) closeMore({ historyEntry: true });
  });
  document.addEventListener("keydown", event => {
    if (!media.matches) return;
    const root = discoverOpen() ? track : nav.classList.contains("menu-open") ? moreLinks : null;
    if (!root) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.stopImmediatePropagation();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (discoverOpen()) closeDiscover({ restoreFocus: true, historyEntry: true });
      else closeMore({ restoreFocus: true, historyEntry: true });
    } else if (event.key === "Tab") {
      const controls = [...root.querySelectorAll("a[href], button:not(:disabled)")].filter(element => element.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
        event.preventDefault(); first?.focus();
      }
    }
  }, true);
  window.addEventListener("popstate", event => {
    if (!media.matches) return;
    closeDiscover();
    closeMore();
    if (event.state?.qdpMobilePanel === "discover") openDiscover({ historyEntry: false });
    else if (event.state?.qdpMobilePanel === "more") {
      toggleClass(nav, "menu-open", true);
      moreButton.setAttribute("aria-expanded", "true");
    }
    scheduleSync();
  });
  archiveStack.addEventListener("scroll", () => {
    if (alphabetFrame) return;
    alphabetFrame = requestAnimationFrame(() => { alphabetFrame = 0; updateAlphabet(); });
  }, { passive: true });
  const observer = new MutationObserver(scheduleSync);
  observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  observer.observe(nav, { attributes: true, attributeFilter: ["class"] });
  observer.observe(detail, { attributes: true, attributeFilter: ["hidden"] });
  observer.observe(profile, { childList: true, attributes: true, attributeFilter: ["hidden"] });
  observer.observe(archiveStack, { childList: true });
  media.addEventListener("change", setMode);
  setMode();
})();
