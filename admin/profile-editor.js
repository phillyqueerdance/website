(() => {
  const neighborhoods = Object.freeze([
    "Southwest", "South", "Center City", "West", "Lower North", "Upper North", "Kensington",
    "Roxborough/Manayunk", "Germantown/Chestnut Hill", "Olney/Oak Lane", "Near Northeast",
    "Far Northeast", "Fishtown", "Gayborhood", "Old City-Queen Village", "Northern Liberties",
    "Rittenhouse", "Fairmount", "Online"
  ]);
  function message(node, text, error = false) {
    node.textContent = text;
    node.toggleAttribute("data-error", error);
  }

  async function request(action, data = {}) {
    const label = action.startsWith("admin.backfill.") ? "Archive Backfill" : "QDP Admin";
    const endpoint = action === "admin.backfill.savebatch" ? "/admin/api?backfill=save" : "/admin/api";
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ action, ...data })
      });
    } catch {
      throw new Error(`${label} could not connect. Reload this page and retry.`);
    }
    if (response.redirected || response.status === 401 || response.status === 403) {
      throw new Error("Sign in to QDP Admin again, then reload this page.");
    }
    const result = await response.json().catch(() => null);
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      if ([504, 524].includes(response.status)) {
        throw new Error(`${label} timed out (HTTP ${response.status}). Reload and retry; reimporting the same collection keeps saved progress.`);
      }
      throw new Error(`${label} returned an unreadable response (HTTP ${response.status}). Reload this page and retry.`);
    }
    if (!response.ok || result?.ok !== "yes") {
      if (/^unknown (?:admin|archive backfill) action\.?$/i.test(result?.error || "")) {
        if (action.startsWith("admin.backfill.")) {
          throw new Error("Update the existing Apps Script web-app deployment with Core.gs and ArchiveBackfill.gs to use Archive Backfill.");
        }
        throw new Error("Deploy the updated Core.gs to use this feature.");
      }
      throw new Error(result?.error || `${label} returned an unexpected response (HTTP ${response.status}).`);
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
      const isNeighborhood = field.key === "Neighborhood";
      const tag = field.type === "flag" || isNeighborhood ? "select" : field.type === "long" ? "textarea" : "input";
      const input = document.createElement(tag);
      label.className = "field";
      if (tag === "textarea") label.classList.add("profile-long");
      title.textContent = field.label;
      if (tag === "select") {
        for (const value of new Set(["", ...(isNeighborhood ? neighborhoods : ["Yes", "No"]), field.value])) {
          const option = new Option(value || "Unspecified", value);
          if (isNeighborhood && value && !neighborhoods.includes(value)) option.disabled = true;
          input.add(option);
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

  window.QDPAdminProfiles = { request, renderFields, editUrl, message, neighborhoods };
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
      if (kind === "venue" && !["SECLOC-001", "TOBEAN-001"].every(id => profiles.some(profile => profile.id === id))) {
        message(loadStatus, "Deploy Core.gs 7.4.14 to include SECLOC-001 and TOBEAN-001.", true);
      } else {
        message(loadStatus, profiles.length ? "" : "No profiles found in the Index.");
      }
      for (const profile of profiles) picker.add(new Option(optionLabel(profile), profile.id));
      picker.disabled = profiles.length === 0;
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
