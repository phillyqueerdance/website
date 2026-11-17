(() => {
  function message(node, text, error = false) {
    node.textContent = text;
    node.toggleAttribute("data-error", error);
  }

  async function request(action, data = {}) {
    const response = await fetch("/admin/api", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ action, ...data })
    });
    const result = await response.json().catch(() => null);
    if (response.redirected || response.status === 401 || response.status === 403) {
      throw new Error("Sign in to QDP Admin to manage profiles.");
    }
    if (!response.ok || result?.ok !== "yes") {
      if (/^unknown admin action\.?$/i.test(result?.error || "")) {
        throw new Error("Deploy the updated Core.gs to use this feature.");
      }
      throw new Error(result?.error || "Could not reach the Index. Try again.");
    }
    return result;
  }

  function renderFields(container, fields) {
    const groups = new Map();
    const inputs = new Map();
    container.replaceChildren();
    for (const field of fields) {
      if (!groups.has(field.group)) {
        const group = document.createElement("fieldset");
        const legend = document.createElement("legend");
        const grid = document.createElement("div");
        group.className = "profile-group";
        legend.textContent = field.group;
        grid.className = "profile-grid";
        group.append(legend, grid);
        container.append(group);
        groups.set(field.group, grid);
      }

      const label = document.createElement("label");
      const title = document.createElement("span");
      const tag = field.type === "flag" ? "select" : field.type === "long" ? "textarea" : "input";
      const input = document.createElement(tag);
      label.className = "field";
      if (tag === "textarea") label.classList.add("profile-long");
      title.textContent = field.label;
      if (tag === "select") {
        for (const value of new Set(["", "Yes", "No", field.value])) {
          input.add(new Option(value || "Unspecified", value));
        }
      } else {
        input.maxLength = field.maxLength;
        if (tag === "textarea") input.rows = 4;
        if (["url", "drive", "instagram"].includes(field.type)) input.inputMode = "url";
        if (field.type === "ids") input.placeholder = "Comma-separated IDs";
      }
      input.value = field.value;
      input.disabled = field.readOnly;
      label.append(title, input);
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
    return inputs;
  }

  const paths = { artist: 'artist-crops', venue: 'venues', party: 'parties', collective: 'collectives' };
  function editUrl(kind, id) {
    return "/admin/" + paths[kind] + "?id=" + encodeURIComponent(id);
  }

  window.QDPAdminProfiles = { request, renderFields, editUrl, message };
  const panel = document.querySelector("[data-profile-kind]");
  if (!panel) return;
  const kind = panel.dataset.profileKind;

  function admin(action, data = {}) {
    return request(action, { kind, ...data });
  }

  const picker = document.getElementById("profilePicker");
  const loadStatus = document.getElementById("profileLoadStatus");
  const form = document.getElementById("profileForm");
  const recordId = document.getElementById("profileId");
  const fields = document.getElementById("profileFields");
  const save = document.getElementById("profileSave");
  const saveStatus = document.getElementById("profileSaveStatus");
  let inputs = new Map();
  let current = null;
  let busy = false;

  function optionLabel(profile) {
    return profile.name === profile.id ? profile.id : `${profile.name} · ${profile.id}`;
  }

  function changedFields() {
    return Object.fromEntries(
      Array.from(inputs)
        .filter(([, { input, original }]) => input.value !== original)
        .map(([key, { input }]) => [key, input.value])
    );
  }

  function updateSaveButton() {
    save.disabled = busy || !current || !Object.keys(changedFields()).length;
  }

  function setBusy(value) {
    busy = picker.disabled = fields.disabled = value;
    updateSaveButton();
  }

  function renderProfile(profile) {
    current = profile;
    recordId.textContent = `${profile.idHeader} ${profile.id}`;
    inputs = renderFields(fields, profile.fields);
    form.hidden = false;
    updateSaveButton();
  }

  async function loadProfiles() {
    try {
      const { profiles } = await admin("admin.profiles.list");
      for (const profile of profiles) picker.add(new Option(optionLabel(profile), profile.id));
      picker.disabled = profiles.length === 0;
      message(loadStatus, profiles.length ? "" : "No profiles found in the Index.");
      const requested = new URLSearchParams(window.location.search).get("id");
      if (profiles.some(profile => profile.id === requested)) {
        picker.value = requested;
        await loadSelectedProfile();
      }
    } catch (error) {
      message(loadStatus, error.message, true);
    }
  }

  async function loadSelectedProfile() {
    if (busy) return;
    if (Object.keys(changedFields()).length && !window.confirm("Discard your unsaved profile changes?")) {
      picker.value = current.id;
      return;
    }
    const profileId = picker.value;
    current = null;
    inputs.clear();
    form.hidden = true;
    message(saveStatus, "");
    message(loadStatus, profileId ? "Loading profile…" : "");
    if (!profileId) {
      updateSaveButton();
      return;
    }
    setBusy(true);
    try {
      const { profile } = await admin("admin.profile.read", { profileId });
      renderProfile(profile);
      message(loadStatus, "");
    } catch (error) {
      picker.value = "";
      message(loadStatus, error.message, true);
    } finally {
      setBusy(false);
    }
  }

  picker.addEventListener("change", loadSelectedProfile);
  form.addEventListener("input", updateSaveButton);
  form.addEventListener("change", updateSaveButton);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (save.disabled) return;
    const { id: profileId, revision: expectedRevision } = current;
    const changes = changedFields();
    setBusy(true);
    message(saveStatus, "Saving…");
    try {
      const { profile } = await admin("admin.profile.save", { profileId, expectedRevision, fields: changes });
      if (profile?.id !== profileId || !profile.revision) throw new Error("The Index could not confirm the save.");
      renderProfile(profile);
      picker.selectedOptions[0].textContent = optionLabel(profile);
      message(saveStatus, "Saved to the Index.");
    } catch (error) {
      message(saveStatus, error.message, true);
    } finally {
      setBusy(false);
    }
  });

  window.addEventListener("beforeunload", event => {
    if (Object.keys(changedFields()).length) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  void loadProfiles();
})();
