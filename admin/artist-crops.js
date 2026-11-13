(() => {
  const meta = window.QDPProfileMetadata;
  const artist = document.getElementById("cropArtist");
  const workspace = document.getElementById("cropWorkspace");
  const stage = document.getElementById("cropStage");
  const controls = document.getElementById("cropControls");
  const zoom = document.getElementById("cropZoom");
  const x = document.getElementById("cropX");
  const y = document.getElementById("cropY");
  const save = document.getElementById("cropSave");
  const reset = document.getElementById("cropReset");
  const status = document.getElementById("cropStatus");
  const photos = new Map();
  const defaultCrop = aspect => ({ x: .5, y: .5, zoom: 1, aspect });
  const clamp = value => Math.max(0, Math.min(1, value));
  let crop, aspect, drag;
  let selection = 0;
  let saving = false;
  zoom.max = meta.maxPhotoZoom;

  function message(text, error = false) {
    status.textContent = text;
    status.toggleAttribute("data-error", error);
  }

  function paint() {
    const frame = meta.photoCropFrame(crop);
    stage.setAttribute("style", meta.photoCropStyle(crop));
    zoom.value = crop.zoom;
    x.value = crop.x;
    y.value = crop.y;
    x.disabled = frame.width <= 1;
    y.disabled = frame.height <= 1;
    reset.disabled = !photos.get(artist.value).crop;
  }

  async function loadPhoto() {
    const version = ++selection;
    const item = photos.get(artist.value);
    crop = drag = null;
    workspace.hidden = true;
    stage.querySelector("img")?.remove();
    if (!item) return message("");
    message("Loading photo…");
    try {
      const image = new Image();
      image.alt = "";
      image.draggable = false;
      image.src = item.src;
      await image.decode();
      if (version !== selection) return;
      aspect = image.naturalWidth / image.naturalHeight;
      crop = meta.photoCrop(item.crop || defaultCrop(aspect));
      if (!crop) return message("This photo’s dimensions cannot be cropped here.", true);
      stage.prepend(image);
      paint();
      workspace.hidden = false;
      message(item.crop ? "Manual crop saved." : "Centered crop is active. Save to use your framing.");
    } catch {
      if (version === selection) message("Could not load this artist’s photo.", true);
    }
  }

  artist.addEventListener("change", loadPhoto);
  controls.addEventListener("input", event => {
    if (!crop || saving) return;
    const input = event.target;
    const key = input === zoom ? "zoom" : input === x ? "x" : "y";
    crop[key] = input.valueAsNumber;
    paint();
    message("Unsaved crop.");
  });

  stage.addEventListener("pointerdown", event => {
    if (!crop || saving || drag || event.button !== 0) return;
    drag = {
      id: event.pointerId, startX: event.clientX, startY: event.clientY,
      x: crop.x, y: crop.y, size: stage.clientWidth, frame: meta.photoCropFrame(crop)
    };
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener("pointermove", event => {
    if (drag?.id !== event.pointerId) return;
    const roomX = (drag.frame.width - 1) * drag.size;
    const roomY = (drag.frame.height - 1) * drag.size;
    if (roomX > 0) crop.x = clamp(drag.x - (event.clientX - drag.startX) / roomX);
    if (roomY > 0) crop.y = clamp(drag.y - (event.clientY - drag.startY) / roomY);
    paint();
    if (status.textContent !== "Unsaved crop.") message("Unsaved crop.");
  });
  stage.addEventListener("lostpointercapture", event => {
    if (drag?.id === event.pointerId) drag = null;
  });

  async function saveCrop(value) {
    if (!crop || saving) return;
    const id = artist.value;
    const item = photos.get(id);
    saving = true;
    drag = null;
    artist.disabled = controls.disabled = true;
    message(value ? "Saving crop…" : "Restoring centered crop…");
    try {
      const response = await fetch("/admin/artist-photo-crop", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ id, src: item.src, crop: value })
      });
      if (response.redirected || response.status === 401 || response.status === 403) {
        throw new Error("Sign in to QDP Admin to save a crop.");
      }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save the crop.");
      item.crop = meta.photoCrop(result.crop);
      crop = item.crop ? { ...item.crop } : defaultCrop(aspect);
      paint();
      message(item.crop
        ? "Crop saved. Public photos may take a few minutes to update."
        : "Centered crop restored. Public photos may take a few minutes to update.");
    } catch (error) {
      message(error instanceof SyntaxError ? "Could not save the crop. Reload and try again." : error.message, true);
    } finally {
      artist.disabled = controls.disabled = saving = false;
    }
  }

  save.addEventListener("click", () => saveCrop(crop));
  reset.addEventListener("click", () => saveCrop(null));

  async function loadArtists() {
    try {
      const response = await fetch("/api/archive?resource=artists");
      if (!response.ok) throw new Error();
      const { artists } = await response.json();
      artists.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true }));
      for (const profile of artists) {
        const photo = meta.profileImage("artist", profile);
        if (!photo || !meta.validId(profile.id)) continue;
        photos.set(profile.id, { src: photo.src, crop: meta.photoCrop(profile.imageCrop) });
        artist.add(new Option(profile.name, profile.id));
      }
      artist.disabled = photos.size === 0;
      message(photos.size ? "" : "No published artist photos yet.");
    } catch {
      message("Could not load artists. Reload the page to try again.", true);
    }
  }

  loadArtists();
})();
