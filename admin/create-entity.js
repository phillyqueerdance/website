(() => {
  const { request, renderFields, editUrl, message } = window.QDPAdminProfiles;
  const kind = document.getElementById("createKind");
  const form = document.getElementById("createForm");
  const idLabel = document.getElementById("createIdLabel");
  const id = document.getElementById("createId");
  const fields = document.getElementById("createFields");
  const profileFields = document.getElementById("createProfileFields");
  const save = document.getElementById("createSave");
  const status = document.getElementById("createStatus");
  const created = document.getElementById("createdProfile");
  let inputs = new Map();
  let selected = "";
  let schema;
  let attempt;
  let busy = false;

  function haveEdits() {
    return Boolean(id.value.trim() || Array.from(inputs.values()).some(({ input }) => input.value.trim()));
  }

  function updateSave() {
    save.disabled = busy || !inputs.get(schema?.nameKey)?.input.value.trim();
  }

  function setBusy(value) {
    busy = kind.disabled = fields.disabled = value;
    updateSave();
  }

  function showFields(nextSchema) {
    schema = nextSchema;
    id.value = "";
    idLabel.textContent = schema.idHeader;
    inputs = renderFields(profileFields, schema.fields);
    inputs.get(schema.nameKey).input.required = true;
    form.hidden = false;
    updateSave();
  }

  kind.addEventListener("change", async () => {
    if (haveEdits() && !window.confirm("Discard the new entity’s unsaved fields?")) {
      kind.value = selected;
      return;
    }
    selected = kind.value;
    form.hidden = created.hidden = true;
    id.value = "";
    inputs.clear();
    attempt = null;
    message(status, "");
    if (!selected) return;
    setBusy(true);
    message(status, "Loading profile fields…");
    try {
      const result = await request("admin.profile.schema", { kind: selected });
      showFields(result.schema);
      message(status, "");
    } catch (error) {
      selected = kind.value = "";
      message(status, error.message, true);
    } finally {
      setBusy(false);
    }
  });

  form.addEventListener("input", updateSave);
  form.addEventListener("change", updateSave);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (save.disabled) return;
    const values = Object.fromEntries(Array.from(inputs)
      .filter(([, { input }]) => input.value.trim())
      .map(([key, { input }]) => [key, input.value]));
    const body = { kind: selected, profileId: id.value.trim(), fields: values };
    const fingerprint = JSON.stringify(body);
    if (attempt?.fingerprint !== fingerprint) attempt = { fingerprint, requestId: crypto.randomUUID() };
    setBusy(true);
    created.hidden = true;
    message(status, "Creating entity…");
    try {
      const { profile } = await request("admin.profile.create", { ...body, requestId: attempt.requestId });
      if (!profile?.id) throw new Error("The Index could not confirm the creation.");
      message(status, `Created ${profile.name} · ${profile.id}`);
      created.href = editUrl(selected, profile.id);
      created.textContent = "Edit " + profile.name;
      created.hidden = false;
      attempt = null;
      showFields(schema);
    } catch (error) {
      message(status, error.message, true);
    } finally {
      setBusy(false);
    }
  });

  window.addEventListener("beforeunload", event => {
    if (haveEdits()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
})();
