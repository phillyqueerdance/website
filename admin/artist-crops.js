(() => {
  const meta = window.QDPProfileMetadata;
  const byId = id => document.getElementById(id);
  const artist = byId("cropArtist");
  const artistStatus = byId("artistStatus");
  const editor = byId("artistEditor");
  const profile = byId("artistProfile");
  const fields = byId("artistFields");
  const profileSave = byId("artistSave");
  const profileStatus = byId("profileStatus");
  const workspace = byId("cropWorkspace");
  const stage = byId("cropStage");
  const controls = byId("cropControls");
  const zoom = byId("cropZoom");
  const x = byId("cropX");
  const y = byId("cropY");
  const save = byId("cropSave");
  const reset = byId("cropReset");
  const cropStatus = byId("cropStatus");
  const catalog = new Map();
  const inputs = new Map();
  const clamp = value => Math.max(0, Math.min(1, value));
  const defaultCrop = aspect => ({ x: .5, y: .5, zoom: 1, aspect });
  const needsDeployment = "Deploy the updated Core.gs to edit artist profiles here.";
  let indexMode = true;
  let current;
  let selected = "";
  let crop, savedCrop, photoSrc, drag;
  let profileVersion = 0;
  let photoVersion = 0;
  let saving = false;
  zoom.max = meta.maxPhotoZoom;

  function message(node, text, error = false) {
    node.textContent = text;
    node.toggleAttribute("data-error", error);
  }

  async function request(path, body) {
    const response = await fetch(path, body ? {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body)
    } : { headers: { Accept: "application/json" } });
    if (response.redirected || response.status === 401 || response.status === 403) {
      throw new Error("Sign in to QDP Admin to edit artists.");
    }
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) throw new Error(result?.error || "Could not reach the artist editor. Try again.");
    return result;
  }

  async function admin(action, details = {}) {
    const result = await request("/admin/api", { action, ...details });
    if (result.ok !== "yes") throw new Error(result.error || "The Index did not confirm this request.");
    return result;
  }

  function changedFields() {
    return Object.fromEntries(Array.from(inputs, ([key, { input, original }]) =>
      [key, input.value, original])
      .filter(([, value, original]) => value !== original)
      .map(([key, value]) => [key, value]));
  }

  function syncButtons() {
    profileSave.disabled = saving || !Object.keys(changedFields()).length;
  }

  function setSaving(value) {
    saving = artist.disabled = fields.disabled = controls.disabled = value;
    syncButtons();
  }

  function populateProfile(record) {
    const groups = new Map();
    inputs.clear();
    fields.replaceChildren();
    byId("artistId").textContent = "ArtistID " + record.id;
    for (const field of record.fields) {
      if (!groups.has(field.group)) {
        const section = document.createElement("fieldset");
        const legend = document.createElement("legend");
        const grid = document.createElement("div");
        section.className = "artist-group";
        grid.className = "artist-group-fields";
        legend.textContent = field.group;
        section.append(legend, grid);
        fields.append(section);
        groups.set(field.group, grid);
      }
      const label = document.createElement("label");
      const title = document.createElement("span");
      const input = document.createElement(field.type === "long" ? "textarea" : field.type === "flag" ? "select" : "input");
      label.className = "field";
      title.textContent = field.label;
      label.append(title, input);
      if (field.type === "flag") {
        const choices = new Set(["", "Yes", "No", field.value]);
        for (const value of choices) input.add(new Option(value || "Unspecified", value));
      } else {
        input.maxLength = field.maxLength;
        if (field.type === "long") input.rows = 5;
        if (["url", "drive", "instagram"].includes(field.type)) input.inputMode = "url";
        if (field.type === "ids") input.placeholder = "Comma-separated IDs";
      }
      input.value = field.value;
      input.disabled = field.readOnly;
      if (field.readOnly) {
        const hint = document.createElement("small");
        hint.className = "field-help";
        hint.textContent = "Set by a Sheet formula";
        label.append(hint);
      } else {
        inputs.set(field.key, { input, original: input.value });
      }
      groups.get(field.group).append(label);
    }
    profile.hidden = false;
    syncButtons();
  }

  function paint() {
    const frame = meta.photoCropFrame(crop);
    stage.setAttribute("style", meta.photoCropStyle(crop));
    zoom.value = crop.zoom;
    x.value = crop.x;
    y.value = crop.y;
    x.disabled = frame.width <= 1;
    y.disabled = frame.height <= 1;
    reset.disabled = !savedCrop;
  }

  async function loadPhoto(record) {
    const version = ++photoVersion;
    crop = savedCrop = drag = null;
    workspace.hidden = true;
    stage.querySelector("img")?.remove();
    photoSrc = meta.profileImage("artist", record)?.src || "";
    if (!photoSrc) {
      message(cropStatus, indexMode ? "Save a photo link in the profile to crop it here." : "This artist has no photo.");
      return;
    }
    message(cropStatus, "Loading photo…");
    try {
      const image = new Image();
      image.alt = "";
      image.draggable = false;
      image.referrerPolicy = "no-referrer";
      image.src = photoSrc;
      await image.decode();
      if (version !== photoVersion) return;
      const aspect = image.naturalWidth / image.naturalHeight;
      savedCrop = meta.photoCrop(record.imageCrop);
      crop = meta.photoCrop({ ...(savedCrop || defaultCrop(aspect)), aspect });
      if (!crop) throw new Error("This photo’s dimensions cannot be cropped here.");
      stage.prepend(image);
      paint();
      workspace.hidden = false;
      message(cropStatus, savedCrop ? "Manual crop saved." : "Centered crop is active.");
    } catch (error) {
      if (version === photoVersion) {
        message(cropStatus, error.message || "Could not load this artist’s photo.", true);
      }
    }
  }

  function hasEdits() {
    if (Object.keys(changedFields()).length) return true;
    const original = savedCrop || (crop && defaultCrop(crop.aspect));
    return crop && ["x", "y", "zoom"].some(key => crop[key] !== original[key]);
  }

  async function loadArtist() {
    if (current && hasEdits() && !window.confirm("Discard your unsaved artist changes?")) {
      artist.value = selected;
      return;
    }
    const version = ++profileVersion;
    ++photoVersion;
    selected = artist.value;
    current = crop = null;
    inputs.clear();
    editor.hidden = profile.hidden = workspace.hidden = true;
    message(profileStatus, "");
    message(cropStatus, "");
    if (!selected) {
      message(artistStatus, indexMode ? "" : needsDeployment);
      return;
    }
    message(artistStatus, "Loading artist…");
    try {
      const option = catalog.get(selected);
      const record = indexMode ? (await admin("admin.artist.read", { artistId: selected })).artist : option;
      if (version !== profileVersion) return;
      if (record?.id !== selected || (indexMode && !Array.isArray(record.fields))) {
        throw new Error("The Index did not return this profile.");
      }
      current = record;
      editor.hidden = false;
      if (indexMode) populateProfile(record);
      message(artistStatus, indexMode ? "" : needsDeployment);
      void loadPhoto(record);
    } catch (error) {
      if (version === profileVersion) message(artistStatus, error.message, true);
    }
  }

  profile.addEventListener("input", syncButtons);
  profile.addEventListener("submit", async event => {
    event.preventDefault();
    const updates = changedFields();
    if (!current || !indexMode || saving || !Object.keys(updates).length) return;
    setSaving(true);
    message(profileStatus, "Saving profile…");
    try {
      const { artist: record } = await admin("admin.artist.save", {
        artistId: current.id, expectedRevision: current.revision, fields: updates
      });
      if (record?.id !== selected || !Array.isArray(record.fields)) {
        throw new Error("The Index did not confirm this profile save. Reload to check.");
      }
      current = record;
      artist.selectedOptions[0].textContent = record.name;
      populateProfile(record);
      if ((meta.profileImage("artist", record)?.src || "") !== photoSrc) void loadPhoto(record);
      message(profileStatus, "Saved to Artists. Publish archive changes to update the website now.");
    } catch (error) {
      message(profileStatus, error.message, true);
    } finally {
      setSaving(false);
    }
  });

  artist.addEventListener("change", loadArtist);
  controls.addEventListener("input", event => {
    if (!crop || saving) return;
    const input = event.target;
    const key = input === zoom ? "zoom" : input === x ? "x" : "y";
    crop[key] = input.valueAsNumber;
    paint();
    message(cropStatus, "Unsaved crop.");
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
    message(cropStatus, "Unsaved crop.");
  });
  stage.addEventListener("lostpointercapture", event => {
    if (drag?.id === event.pointerId) drag = null;
  });

  async function saveCrop(value) {
    if (!crop || saving) return;
    const aspect = crop.aspect;
    drag = null;
    setSaving(true);
    message(cropStatus, value ? "Saving crop…" : "Restoring centered crop…");
    try {
      const result = await request("/admin/artist-photo-crop", {
        id: selected, src: photoSrc, crop: value, source: indexMode ? "index" : "archive"
      });
      savedCrop = meta.photoCrop(result.crop);
      crop = savedCrop ? { ...savedCrop } : defaultCrop(aspect);
      paint();
      message(cropStatus, savedCrop
        ? "Crop saved. Public photos may take a few minutes to update."
        : "Centered crop restored. Public photos may take a few minutes to update.");
    } catch (error) {
      message(cropStatus, error.message, true);
    } finally {
      setSaving(false);
    }
  }

  save.addEventListener("click", () => saveCrop(crop));
  reset.addEventListener("click", () => saveCrop(null));

  async function loadArtists() {
    try {
      let artists;
      try {
        ({ artists } = await admin("admin.artists.list"));
      } catch (error) {
        if (error.message !== "Unknown admin action.") throw error;
        ({ artists } = await request("/api/archive?resource=artists"));
        indexMode = false;
      }
      artists.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true }));
      for (const record of artists) {
        if (!meta.validId(record.id)) continue;
        catalog.set(record.id, record);
        artist.add(new Option(record.name, record.id));
      }
      artist.disabled = !catalog.size;
      message(artistStatus, indexMode ? (catalog.size ? "" : "No artists in the Index.") : needsDeployment);
      const requested = new URLSearchParams(window.location.search).get("id");
      if (catalog.has(requested)) {
        artist.value = requested;
        await loadArtist();
      }
    } catch (error) {
      message(artistStatus, error.message || "Could not load artists. Reload and try again.", true);
    }
  }

  void loadArtists();
})();
