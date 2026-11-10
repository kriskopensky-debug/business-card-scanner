(() => {
  "use strict";

  const FOLDER_NAME = "Business Card Scanner";
  const INDEX_FILENAME = "contacts-index.json";
  const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
  const DRIVE_API = "https://www.googleapis.com";

  const state = {
    clientId: localStorage.getItem("bcs_clientId") || "",
    accessToken: sessionStorage.getItem("bcs_accessToken") || "",
    tokenExpiry: Number(sessionStorage.getItem("bcs_tokenExpiry") || 0),
    folderId: localStorage.getItem("bcs_folderId") || "",
    indexFileId: null,
    cards: [],
    currentPhoto: null, // { blob, base64, mediaType }
    tokenClient: null,
  };

  // ---------- DOM ----------
  const el = (id) => document.getElementById(id);
  const connectBtn = el("connectBtn");
  const fileInput = el("fileInput");
  const preview = el("preview");
  const scanBtn = el("scanBtn");
  const scanStatus = el("scanStatus");
  const reviewSection = el("reviewSection");
  const reviewForm = el("reviewForm");
  const saveBtn = el("saveBtn");
  const addContactBtn = el("addContactBtn");
  const discardBtn = el("discardBtn");
  const saveStatus = el("saveStatus");
  const cardList = el("cardList");
  const listStatus = el("listStatus");
  const searchBox = el("searchBox");
  const settingsModal = el("settingsModal");
  const clientIdInput = el("clientIdInput");
  const saveClientIdBtn = el("saveClientIdBtn");

  function setStatus(node, msg, isError = false) {
    node.hidden = !msg;
    node.textContent = msg || "";
    node.classList.toggle("error", isError);
  }

  // ---------- Google auth ----------
  function openSettings() {
    clientIdInput.value = state.clientId;
    settingsModal.hidden = false;
  }

  saveClientIdBtn.addEventListener("click", () => {
    const value = clientIdInput.value.trim();
    if (!value) return;
    state.clientId = value;
    localStorage.setItem("bcs_clientId", value);
    settingsModal.hidden = true;
    initTokenClient();
    requestToken();
  });

  function initTokenClient() {
    if (!window.google || !state.clientId) return;
    state.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: state.clientId,
      scope: DRIVE_SCOPE,
      callback: (resp) => {
        if (resp.error) {
          setStatus(listStatus, "Google sign-in failed: " + resp.error, true);
          return;
        }
        state.accessToken = resp.access_token;
        state.tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
        sessionStorage.setItem("bcs_accessToken", state.accessToken);
        sessionStorage.setItem("bcs_tokenExpiry", String(state.tokenExpiry));
        onConnected();
      },
    });
  }

  function requestToken(silent = false) {
    if (!state.clientId) {
      openSettings();
      return;
    }
    if (!state.tokenClient) initTokenClient();
    if (!state.tokenClient) {
      setStatus(listStatus, "Google sign-in library is still loading — try again in a moment.", true);
      return;
    }
    state.tokenClient.requestAccessToken({ prompt: silent ? "" : "consent" });
  }

  connectBtn.addEventListener("click", () => requestToken(false));

  function hasValidToken() {
    return state.accessToken && Date.now() < state.tokenExpiry;
  }

  async function onConnected() {
    connectBtn.textContent = "✓ Drive connected";
    connectBtn.disabled = true;
    await refreshCardList();
  }

  // ---------- Drive helpers ----------
  class AuthExpiredError extends Error {}

  async function driveFetch(path, options = {}) {
    if (!hasValidToken()) throw new AuthExpiredError();
    const res = await fetch(`${DRIVE_API}/${path}`, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${state.accessToken}` },
    });
    if (res.status === 401) throw new AuthExpiredError();
    return res;
  }

  async function withAuth(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        setStatus(listStatus, "Your Google session expired — reconnecting…");
        connectBtn.disabled = false;
        connectBtn.textContent = "Connect Google Drive";
        requestToken(false);
      }
      throw err;
    }
  }

  async function ensureFolder() {
    if (state.folderId) {
      const check = await driveFetch(`drive/v3/files/${state.folderId}?fields=id,trashed`);
      if (check.ok) {
        const data = await check.json();
        if (!data.trashed) return state.folderId;
      }
    }
    const q = encodeURIComponent(
      `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
    );
    const listRes = await driveFetch(`drive/v3/files?q=${q}&fields=files(id,name)`);
    const listData = await listRes.json();
    if (listData.files && listData.files.length) {
      state.folderId = listData.files[0].id;
      localStorage.setItem("bcs_folderId", state.folderId);
      return state.folderId;
    }
    const createRes = await driveFetch("drive/v3/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
    });
    const createData = await createRes.json();
    state.folderId = createData.id;
    localStorage.setItem("bcs_folderId", state.folderId);
    return state.folderId;
  }

  async function loadIndex() {
    const folderId = await ensureFolder();
    const q = encodeURIComponent(`name='${INDEX_FILENAME}' and '${folderId}' in parents and trashed=false`);
    const res = await driveFetch(`drive/v3/files?q=${q}&fields=files(id)`);
    const data = await res.json();
    if (!data.files || !data.files.length) {
      state.indexFileId = null;
      return [];
    }
    state.indexFileId = data.files[0].id;
    const contentRes = await driveFetch(`drive/v3/files/${state.indexFileId}?alt=media`);
    const text = await contentRes.text();
    try {
      return JSON.parse(text);
    } catch {
      return [];
    }
  }

  async function saveIndex(cards) {
    const folderId = await ensureFolder();
    const body = JSON.stringify(cards, null, 2);
    if (state.indexFileId) {
      await driveFetch(`upload/drive/v3/files/${state.indexFileId}?uploadType=media`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body,
      });
    } else {
      const boundary = "bcsboundary" + Date.now();
      const metadata = { name: INDEX_FILENAME, parents: [folderId], mimeType: "application/json" };
      const multipartBody =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
      const res = await driveFetch(`upload/drive/v3/files?uploadType=multipart&fields=id`, {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body: multipartBody,
      });
      const data = await res.json();
      state.indexFileId = data.id;
    }
  }

  async function uploadPhoto(blob, filename) {
    const folderId = await ensureFolder();
    const metadata = { name: filename, parents: [folderId], mimeType: blob.type || "image/jpeg" };
    const boundary = "bcsboundary" + Date.now();
    const head =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: ${metadata.mimeType}\r\n\r\n`;
    const tail = `\r\n--${boundary}--`;
    const multipartBody = new Blob([head, blob, tail]);
    const res = await driveFetch(`upload/drive/v3/files?uploadType=multipart&fields=id`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: multipartBody,
    });
    const data = await res.json();
    return data.id;
  }

  async function deletePhoto(fileId) {
    if (!fileId) return;
    try {
      await driveFetch(`drive/v3/files/${fileId}`, { method: "DELETE" });
    } catch {
      /* best effort */
    }
  }

  // ---------- Image capture / resize ----------
  function resizeImage(file, maxDim = 1600, quality = 0.85) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read file."));
      reader.onload = (e) => {
        const img = new Image();
        img.onerror = () => reject(new Error("Could not load image."));
        img.onload = () => {
          let { width, height } = img;
          if (width > height && width > maxDim) {
            height = Math.round(height * (maxDim / width));
            width = maxDim;
          } else if (height > maxDim) {
            width = Math.round(width * (maxDim / height));
            height = maxDim;
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          canvas.getContext("2d").drawImage(img, 0, 0, width, height);
          canvas.toBlob(
            (blob) => {
              const fr = new FileReader();
              fr.onload = () =>
                resolve({ blob, dataUrl: canvas.toDataURL("image/jpeg", quality), base64: fr.result.split(",")[1] });
              fr.onerror = () => reject(new Error("Could not encode image."));
              fr.readAsDataURL(blob);
            },
            "image/jpeg",
            quality
          );
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    setStatus(scanStatus, "");
    try {
      const { blob, dataUrl, base64 } = await resizeImage(file);
      state.currentPhoto = { blob, base64, mediaType: "image/jpeg" };
      preview.src = dataUrl;
      preview.hidden = false;
      scanBtn.hidden = false;
    } catch (err) {
      setStatus(scanStatus, err.message, true);
    }
  });

  scanBtn.addEventListener("click", async () => {
    if (!state.currentPhoto) return;
    scanBtn.disabled = true;
    setStatus(scanStatus, "Reading card…");
    try {
      const res = await fetch("/.netlify/functions/ocr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: state.currentPhoto.base64, mediaType: state.currentPhoto.mediaType }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "OCR failed.");
      populateForm(data.fields || {});
      setStatus(scanStatus, "");
      reviewSection.hidden = false;
      reviewSection.scrollIntoView({ behavior: "smooth" });
    } catch (err) {
      setStatus(scanStatus, err.message, true);
    } finally {
      scanBtn.disabled = false;
    }
  });

  function populateForm(fields) {
    reviewForm.name.value = fields.name || "";
    reviewForm.title.value = fields.title || "";
    reviewForm.company.value = fields.company || "";
    reviewForm.phones.value = (fields.phones || []).join("\n");
    reviewForm.emails.value = (fields.emails || []).join("\n");
    reviewForm.website.value = fields.website || "";
    reviewForm.address.value = fields.address || "";
    reviewForm.notes.value = fields.notes || "";
  }

  function readForm() {
    const splitLines = (v) => v.split("\n").map((s) => s.trim()).filter(Boolean);
    return {
      name: reviewForm.name.value.trim(),
      title: reviewForm.title.value.trim(),
      company: reviewForm.company.value.trim(),
      phones: splitLines(reviewForm.phones.value),
      emails: splitLines(reviewForm.emails.value),
      website: reviewForm.website.value.trim(),
      address: reviewForm.address.value.trim(),
      notes: reviewForm.notes.value.trim(),
    };
  }

  discardBtn.addEventListener("click", resetScan);

  function resetScan() {
    state.currentPhoto = null;
    fileInput.value = "";
    preview.hidden = true;
    scanBtn.hidden = true;
    reviewSection.hidden = true;
    reviewForm.reset();
    setStatus(scanStatus, "");
    setStatus(saveStatus, "");
  }

  // ---------- Save ----------
  saveBtn.addEventListener("click", async () => {
    const fields = readForm();
    if (!fields.name && !fields.company) {
      setStatus(saveStatus, "Add at least a name or company before saving.", true);
      return;
    }
    if (!hasValidToken()) {
      setStatus(saveStatus, "Connect Google Drive first.", true);
      requestToken(false);
      return;
    }
    saveBtn.disabled = true;
    setStatus(saveStatus, "Saving to Drive…");
    try {
      await withAuth(async () => {
        let photoFileId = null;
        if (state.currentPhoto) {
          const filename = `${(fields.name || "card").replace(/\s+/g, "_")}-${Date.now()}.jpg`;
          photoFileId = await uploadPhoto(state.currentPhoto.blob, filename);
        }
        const cards = await loadIndex();
        const entry = { id: crypto.randomUUID(), ...fields, photoFileId, createdAt: new Date().toISOString() };
        cards.unshift(entry);
        await saveIndex(cards);
        state.cards = cards;
      });
      setStatus(saveStatus, "Saved ✓");
      renderList();
      resetScan();
    } catch (err) {
      if (!(err instanceof AuthExpiredError)) setStatus(saveStatus, err.message, true);
    } finally {
      saveBtn.disabled = false;
    }
  });

  // ---------- vCard / Add to Contacts ----------
  function buildVCard(card) {
    const esc = (s = "") => String(s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,");
    const lines = ["BEGIN:VCARD", "VERSION:3.0"];
    if (card.name) {
      lines.push(`FN:${esc(card.name)}`);
      const parts = card.name.trim().split(/\s+/);
      const last = parts.length > 1 ? parts.pop() : "";
      const first = parts.join(" ");
      lines.push(`N:${esc(last)};${esc(first)};;;`);
    } else if (card.company) {
      lines.push(`FN:${esc(card.company)}`);
    }
    if (card.title) lines.push(`TITLE:${esc(card.title)}`);
    if (card.company) lines.push(`ORG:${esc(card.company)}`);
    (card.phones || []).forEach((p) => lines.push(`TEL;TYPE=WORK,VOICE:${esc(p)}`));
    (card.emails || []).forEach((e) => lines.push(`EMAIL;TYPE=WORK:${esc(e)}`));
    if (card.website) lines.push(`URL:${esc(card.website)}`);
    if (card.address) lines.push(`ADR;TYPE=WORK:;;${esc(card.address)};;;;`);
    if (card.notes) lines.push(`NOTE:${esc(card.notes)}`);
    lines.push("END:VCARD");
    return lines.join("\r\n");
  }

  function addToContacts(card) {
    const vcard = buildVCard(card);
    const blob = new Blob([vcard], { type: "text/vcard" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  addContactBtn.addEventListener("click", () => addToContacts(readForm()));

  // ---------- List ----------
  async function refreshCardList() {
    setStatus(listStatus, "Loading your saved cards…");
    try {
      await withAuth(async () => {
        state.cards = await loadIndex();
      });
      setStatus(listStatus, state.cards.length ? "" : "No cards saved yet.");
      renderList();
    } catch (err) {
      if (!(err instanceof AuthExpiredError)) setStatus(listStatus, err.message, true);
    }
  }

  function renderList() {
    const query = searchBox.value.trim().toLowerCase();
    const items = state.cards.filter((c) => {
      if (!query) return true;
      const hay = [c.name, c.company, c.title, ...(c.emails || []), ...(c.phones || [])].join(" ").toLowerCase();
      return hay.includes(query);
    });
    cardList.innerHTML = "";
    items.forEach((card) => cardList.appendChild(renderCardItem(card)));
  }

  function renderCardItem(card) {
    const li = document.createElement("li");
    li.className = "card-item";
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span><span class="name">${escapeHtml(card.name || "(no name)")}</span>
      ${card.company ? `<br><span class="company">${escapeHtml(card.company)}</span>` : ""}</span><span>▾</span>`;
    const details = document.createElement("div");
    details.className = "details";
    details.hidden = true;
    details.innerHTML = [
      card.title ? `<div>${escapeHtml(card.title)}</div>` : "",
      (card.phones || []).map((p) => `<div>📞 ${escapeHtml(p)}</div>`).join(""),
      (card.emails || []).map((e) => `<div>✉️ ${escapeHtml(e)}</div>`).join(""),
      card.website ? `<div>🔗 ${escapeHtml(card.website)}</div>` : "",
      card.address ? `<div>📍 ${escapeHtml(card.address)}</div>` : "",
      card.notes ? `<div>📝 ${escapeHtml(card.notes)}</div>` : "",
    ].join("");

    const actions = document.createElement("div");
    actions.className = "details-actions";
    const addBtn = document.createElement("button");
    addBtn.className = "btn btn-secondary";
    addBtn.textContent = "➕ Add to iPhone";
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      addToContacts(card);
    });
    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-text";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete ${card.name || card.company || "this card"}?`)) return;
      await withAuth(async () => {
        state.cards = state.cards.filter((c) => c.id !== card.id);
        await saveIndex(state.cards);
        await deletePhoto(card.photoFileId);
      }).catch((err) => {
        if (!(err instanceof AuthExpiredError)) alert(err.message);
      });
      renderList();
    });
    actions.appendChild(addBtn);
    actions.appendChild(delBtn);
    details.appendChild(actions);

    row.addEventListener("click", () => (details.hidden = !details.hidden));
    li.appendChild(row);
    li.appendChild(details);
    return li;
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  searchBox.addEventListener("input", renderList);

  // ---------- Init ----------
  function waitForGoogle(cb, attempts = 0) {
    if (window.google && window.google.accounts) return cb();
    if (attempts > 50) return; // ~5s, give up quietly — Connect button will lazy-init instead
    setTimeout(() => waitForGoogle(cb, attempts + 1), 100);
  }

  window.addEventListener("load", () => {
    if (!state.clientId) return;
    waitForGoogle(() => {
      initTokenClient();
      if (hasValidToken()) onConnected();
    });
  });
})();
