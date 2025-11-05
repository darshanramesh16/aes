import express from "express";
import multer from "multer";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import cors from "cors";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const STORAGE_DIR = path.join(__dirname, "storage");
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

const upload = multer({ storage: multer.memoryStorage() });

// ---- Crypto helpers ----
function deriveKey(secret, salt) {
  return crypto.scryptSync(secret, salt, 32);
}
function encryptBuffer(buf, secret) {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(secret, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(buf), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag, salt };
}
function decryptBuffer(payload, secret) {
  const { ciphertext, iv, authTag, salt } = payload;
  const key = deriveKey(secret, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
function writeUInt32LE(n) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32LE(n, 0);
  return b;
}
function readUInt32LE(buf, offset) {
  return buf.readUInt32LE(offset);
}

// ---- Routes ----

// Upload + encrypt
app.post("/api/encrypt", upload.single("file"), (req, res) => {
  try {
    const secret = req.body.secret ?? "";
    if (!req.file || !secret)
      return res.status(400).json({ error: "file and secret required" });

    const { originalname, buffer, mimetype } = req.file;

    const enc = encryptBuffer(buffer, secret);

    const nameBuf = Buffer.from(originalname, "utf8");
    const mimeBuf = Buffer.from(mimetype || "application/octet-stream", "utf8");

    // Header: [salt16][iv12][tag16][nameLen4][name][mimeLen4][mime]
    const header = Buffer.concat([
      enc.salt,
      enc.iv,
      enc.authTag,
      writeUInt32LE(nameBuf.length),
      nameBuf,
      writeUInt32LE(mimeBuf.length),
      mimeBuf,
    ]);

    const blob = Buffer.concat([header, enc.ciphertext]);

    const id = crypto.randomUUID() + ".bin";
    fs.writeFileSync(path.join(STORAGE_DIR, id), blob);
    return res.json({ id, originalName: originalname, size: buffer.length });
  } catch (e) {
    console.error("encrypt error:", e);
    return res.status(500).json({ error: "encryption failed" });
  }
});

// Decrypt
app.post("/api/decrypt", (req, res) => {
  try {
    const { id, secret } = req.body || {};
    console.log("decrypt req", { id, hasSecret: Boolean(secret) });
    if (!id || !secret)
      return res.status(400).json({ error: "id and secret required" });

    const filePath = path.join(STORAGE_DIR, id);
    if (!fs.existsSync(filePath))
      return res.status(404).json({ error: "not found" });

    const blob = fs.readFileSync(filePath);
    let offset = 0;

    // Robust, bounds-checked parsing
    const need = (n) => {
      if (offset + n > blob.length) throw new Error("truncated header");
    };

    need(16);
    const salt = blob.subarray(offset, offset + 16);
    offset += 16;
    need(12);
    const iv = blob.subarray(offset, offset + 12);
    offset += 12;
    need(16);
    const authTag = blob.subarray(offset, offset + 16);
    offset += 16;

    need(4);
    const nameLen = readUInt32LE(blob, offset);
    offset += 4;
    need(nameLen);
    const name = blob.subarray(offset, offset + nameLen).toString("utf8");
    offset += nameLen;

    need(4);
    const mimeLen = readUInt32LE(blob, offset);
    offset += 4;
    need(mimeLen);
    const mime = blob.subarray(offset, offset + mimeLen).toString("utf8");
    offset += mimeLen;

    const ciphertext = blob.subarray(offset);
    if (!ciphertext.length) throw new Error("missing ciphertext");

    const plain = decryptBuffer({ ciphertext, iv, authTag, salt }, secret);

    res.setHeader("Content-Type", mime || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${name || "file"}"`
    );
    return res.send(plain);
  } catch (e) {
    console.error("decrypt error:", e?.message || e);
    return res
      .status(400)
      .json({ error: "decryption failed (wrong secret or corrupt data)" });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server on :${PORT}`));
