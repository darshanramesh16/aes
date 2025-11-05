// Prevent any accidental navigation or reload during encrypt
addEventListener("beforeunload", (e) => {
  if (sessionStorage.getItem("encrypting") === "1") {
    e.preventDefault();
    e.returnValue = "";
  }
});

const API_BASE = "http://localhost:4000";

function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const c of children)
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return n;
}

// Persistent preview area with a footer that we control
function ensurePreviewScaffold(container) {
  let content = container.querySelector(".preview-content");
  let footer = container.querySelector(".preview-footer");
  if (!content) {
    content = el("div", { className: "preview-content" });
    container.appendChild(content);
  } else {
    content.innerHTML = ""; // keep node, clear content
  }
  if (!footer) {
    footer = el("div", { className: "preview-footer" });
    container.appendChild(footer);
  }
  return { content, footer };
}

function previewFile(file, container) {
  const { content } = ensurePreviewScaffold(container);
  const type = file.type;

  if (type.startsWith("image/")) {
    const img = el("img");
    img.style.maxWidth = "100%";
    img.src = URL.createObjectURL(file);
    content.appendChild(img);
    return;
  }
  if (type === "application/pdf") {
    const obj = el("object");
    obj.type = "application/pdf";
    obj.data = URL.createObjectURL(file);
    obj.width = "100%";
    obj.height = "500";
    content.appendChild(obj);
    return;
  }
  if (type.startsWith("text/")) {
    const reader = new FileReader();
    reader.onload = () =>
      content.appendChild(el("pre", { textContent: reader.result }));
    reader.readAsText(file);
    return;
  }
  content.appendChild(
    el("p", {
      textContent: `Selected file: ${file.name} (${type || "unknown"})`,
    })
  );
}

// DOM refs
const fileInput = document.getElementById("fileInput");
const secretInput = document.getElementById("secretInput");
const encryptBtn = document.getElementById("encryptBtn");
const previewDiv = document.getElementById("preview");
const statusDiv = document.getElementById("status");

const decryptId = document.getElementById("decryptId");
const decryptSecret = document.getElementById("decryptSecret");
const decryptBtn = document.getElementById("decryptBtn");
const decryptedView = document.getElementById("decryptedView");

// Restore last values
addEventListener("DOMContentLoaded", () => {
  const lastId = localStorage.getItem("lastCipherId");
  if (lastId) decryptId.value = lastId;
  const lastSecret = localStorage.getItem("lastSecret");
  if (lastSecret) decryptSecret.value = lastSecret;
});

fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) previewFile(f, previewDiv);
});

// Draw persistent Encrypted ID just below the preview
function showEncryptedId(id) {
  const { footer } = ensurePreviewScaffold(previewDiv);
  footer.innerHTML = "";
  footer.appendChild(el("span", { className: "id-label" }, ["Encrypted ID: "]));
  footer.appendChild(el("code", {}, [id]));
  const copyBtn = el("button", { className: "copy-btn", type: "button" }, [
    "Copy",
  ]);
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(id);
      copyBtn.textContent = "Copied";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
    } catch {}
  });
  footer.appendChild(el("span", {}, [" "]));
  footer.appendChild(copyBtn);
}

// Encrypt & upload, without any navigation or clearing
encryptBtn.addEventListener("click", async (e) => {
  if (e && e.preventDefault) e.preventDefault();

  const file = fileInput.files?.[0];
  const secret = secretInput.value;
  if (!file || !secret) {
    statusDiv.textContent = "Choose file and enter secret";
    return;
  }

  // Make sure the preview exists and remains
  if (!previewDiv.querySelector(".preview-content"))
    previewFile(file, previewDiv);

  const fd = new FormData();
  fd.append("file", file);
  fd.append("secret", secret);

  sessionStorage.setItem("encrypting", "1");
  statusDiv.textContent = "Encrypting & uploading...";

  try {
    const res = await fetch(`${API_BASE}/api/encrypt`, {
      method: "POST",
      body: fd,
      keepalive: true,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "failed");

    // Persist and render ID below preview; do NOT clear preview
    decryptId.value = data.id;
    decryptSecret.value = secret;
    localStorage.setItem("lastCipherId", data.id);
    localStorage.setItem("lastSecret", secret);

    statusDiv.textContent = ""; // status area cleared so only the persistent footer shows the ID
    showEncryptedId(data.id);
  } catch (err) {
    statusDiv.textContent = "Encryption failed";
  } finally {
    sessionStorage.setItem("encrypting", "0");
  }
});

// Decrypt and render
decryptBtn.addEventListener("click", async (e) => {
  if (e && e.preventDefault) e.preventDefault();
  decryptedView.innerHTML = "Decrypting...";
  try {
    const res = await fetch(`${API_BASE}/api/decrypt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: decryptId.value.trim(),
        secret: decryptSecret.value,
      }),
    });
    if (res.ok) {
      const blob = await res.blob();
      const mime =
        res.headers.get("Content-Type") || "application/octet-stream";
      const url = URL.createObjectURL(blob);

      decryptedView.innerHTML = "";
      if (mime.startsWith("image/")) {
        const img = el("img");
        img.style.maxWidth = "100%";
        img.src = url;
        decryptedView.appendChild(img);
      } else if (mime === "application/pdf") {
        const obj = el("object");
        obj.type = "application/pdf";
        obj.data = url;
        obj.width = "100%";
        obj.height = "500";
        decryptedView.appendChild(obj);
      } else if (mime.startsWith("text/")) {
        const text = await blob.text();
        decryptedView.appendChild(el("pre", { textContent: text }));
      } else {
        const a = el("a", { href: url, download: "decrypted" }, [
          "Download decrypted file",
        ]);
        decryptedView.appendChild(a);
      }
    } else {
      const data = await res.json().catch(() => ({}));
      decryptedView.textContent = data.error || "Decryption failed";
    }
  } catch {
    decryptedView.textContent = "Decryption error";
  }
});
