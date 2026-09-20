import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { DomainError } from "./errors.ts";

const MIME_EXTENSIONS: Record<string, string[]> = {
  "application/vnd.ms-powerpoint": [".ppt"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
  "application/pdf": [".pdf"],
  "application/msword": [".doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "text/csv": [".csv"],
  "text/tab-separated-values": [".tsv"],
  "text/x-python": [".py"],
  "text/plain": [".txt", ".md"],
  "application/zip": [".zip"],
};

const OLE_SIGNATURE = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function startsWith(bytes: Uint8Array, signature: Uint8Array) {
  return bytes.byteLength >= signature.byteLength && signature.every((value, index) => bytes[index] === value);
}

function zipEntries(bytes: Uint8Array) {
  if (bytes.byteLength < 22) throw new DomainError("invalid_file_signature", "ZIP archive is incomplete");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const firstPossible = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= firstPossible; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new DomainError("invalid_file_signature", "ZIP central directory is missing");
  const count = view.getUint16(eocd + 10, true);
  const size = view.getUint32(eocd + 12, true);
  const start = view.getUint32(eocd + 16, true);
  if (!count || start + size > eocd || start + size > bytes.byteLength) throw new DomainError("invalid_file_signature", "ZIP central directory is invalid");
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const entries = new Set<string>();
  let offset = start;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) throw new DomainError("invalid_file_signature", "ZIP entry is invalid");
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (!nameLength || end > bytes.byteLength) throw new DomainError("invalid_file_signature", "ZIP entry is truncated");
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)).replace(/\\/g, "/");
    if (name.startsWith("/") || name.split("/").includes("..") || name.includes("\0")) throw new DomainError("invalid_file_signature", "ZIP contains an unsafe entry name");
    const localOffset = view.getUint32(offset + 42, true);
    const compressedSize = view.getUint32(offset + 20, true);
    if (localOffset + 30 > start || view.getUint32(localOffset, true) !== 0x04034b50) throw new DomainError("invalid_file_signature", "ZIP local entry is missing");
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localNameEnd = localOffset + 30 + localNameLength;
    const localDataEnd = localNameEnd + localExtraLength + compressedSize;
    if (localDataEnd > start || decoder.decode(bytes.subarray(localOffset + 30, localNameEnd)).replace(/\\/g, "/") !== name) throw new DomainError("invalid_file_signature", "ZIP local entry is inconsistent");
    entries.add(name);
    offset = end;
  }
  if (offset !== start + size) throw new DomainError("invalid_file_signature", "ZIP central directory size does not match");
  return entries;
}

export function validateFileSignature(originalName: string, mimeType: string, bytes: Uint8Array) {
  const metadata = validateFileMetadata(originalName, mimeType, bytes.byteLength, Number.MAX_SAFE_INTEGER);
  const mime = metadata.mimeType;
  let valid = true;
  if (mime === "application/vnd.ms-powerpoint" || mime === "application/msword") valid = startsWith(bytes, OLE_SIGNATURE);
  else if (mime === "application/pdf") valid = startsWith(bytes, new TextEncoder().encode("%PDF-")) && new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.byteLength - 2048))).includes("%%EOF");
  else if (mime === "image/png") valid = startsWith(bytes, PNG_SIGNATURE);
  else if (mime === "image/jpeg") valid = bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  else if (mime === "application/zip" || mime.includes("openxmlformats-officedocument")) {
    const entries = zipEntries(bytes);
    if (mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation") valid = ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml"].every((entry) => entries.has(entry));
    else if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") valid = ["[Content_Types].xml", "_rels/.rels", "word/document.xml"].every((entry) => entries.has(entry));
  }
  if (!valid) throw new DomainError("invalid_file_signature", "File content does not match its declared type");
}

export type QuarantinedAsset = {
  id: string;
  storageKey: string;
  originalName: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
};

function safeOriginalName(value: string) {
  const name = value.trim();
  if (!name || name.includes("\0") || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new DomainError("invalid_file_name", "File name is invalid");
  }
  return name;
}

export function validateFileMetadata(originalName: string, mimeType: string, byteSize: number, maxBytes: number) {
  const safeName = safeOriginalName(originalName);
  const normalizedMime = mimeType.trim().toLowerCase().split(";", 1)[0];
  const dot = safeName.lastIndexOf(".");
  const extension = dot >= 0 ? safeName.slice(dot).toLowerCase() : "";
  if (!MIME_EXTENSIONS[normalizedMime]?.includes(extension)) {
    throw new DomainError("file_type_mismatch", "File extension and MIME type do not match");
  }
  if (!Number.isSafeInteger(byteSize) || byteSize < 0 || byteSize > maxBytes) {
    throw new DomainError("file_too_large", "File exceeds the configured size limit", 413);
  }
  return { originalName: safeName, mimeType: normalizedMime, byteSize };
}

export class LocalFileStorage {
  readonly root: string;
  readonly maxBytes: number;

  constructor(root: string, maxBytes = 25 * 1024 * 1024) {
    this.root = resolve(root);
    this.maxBytes = maxBytes;
  }

  private quarantinePath(id: string) {
    return resolve(this.root, "quarantine", `${id}.upload`);
  }

  private readyPath(id: string) {
    return resolve(this.root, "assets", `${id}.bin`);
  }

  private previewSlidePath(jobId: string, page: number) {
    return resolve(this.root, "previews", jobId, `slide-${page}.png`);
  }

  private assertInside(path: string) {
    const normalized = resolve(path);
    const relativePath = relative(this.root, normalized);
    if (relativePath && (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`))) {
      throw new DomainError("invalid_storage_key", "Storage key is invalid");
    }
    return normalized;
  }

  async quarantine(id: string, originalName: string, mimeType: string, bytes: Uint8Array): Promise<QuarantinedAsset> {
    const metadata = validateFileMetadata(originalName, mimeType, bytes.byteLength, this.maxBytes);
    const storageKey = `assets/${id}.bin`;
    const path = this.assertInside(this.quarantinePath(id));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    return {
      id,
      storageKey,
      originalName: metadata.originalName,
      mimeType: metadata.mimeType,
      byteSize: metadata.byteSize,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  async promote(id: string) {
    const source = this.assertInside(this.quarantinePath(id));
    const target = this.assertInside(this.readyPath(id));
    await mkdir(dirname(target), { recursive: true });
    await rename(source, target);
    return `assets/${id}.bin`;
  }

  async writeReady(id: string, bytes: Uint8Array) {
    if (!/^[0-9a-f-]+$/i.test(id)) throw new DomainError("invalid_storage_key", "Storage key is invalid");
    if (bytes.byteLength > this.maxBytes) throw new DomainError("file_too_large", "File exceeds the configured size limit", 413);
    const target = this.assertInside(this.readyPath(id));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    return `assets/${id}.bin`;
  }

  async writePreviewSlide(jobId: string, page: number, bytes: Uint8Array) {
    if (!/^[0-9a-f-]+$/i.test(jobId) || !Number.isSafeInteger(page) || page < 1 || page > 500) {
      throw new DomainError("invalid_storage_key", "Preview key is invalid");
    }
    const target = this.assertInside(this.previewSlidePath(jobId, page));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    return `previews/${jobId}/slide-${page}.png`;
  }

  async readPreviewSlide(jobId: string, page: number) {
    if (!/^[0-9a-f-]+$/i.test(jobId) || !Number.isSafeInteger(page) || page < 1 || page > 500) {
      throw new DomainError("invalid_storage_key", "Preview key is invalid");
    }
    return readFile(this.assertInside(this.previewSlidePath(jobId, page)));
  }

  async removePreview(jobId: string) {
    if (!/^[0-9a-f-]+$/i.test(jobId)) throw new DomainError("invalid_storage_key", "Preview key is invalid");
    await rm(this.assertInside(resolve(this.root, "previews", jobId)), { recursive: true, force: true });
  }

  async readQuarantine(id: string) {
    if (!/^[0-9a-f-]+$/i.test(id)) throw new DomainError("invalid_storage_key", "Storage key is invalid");
    return readFile(this.assertInside(this.quarantinePath(id)));
  }

  async removeQuarantine(id: string) {
    try {
      await unlink(this.assertInside(this.quarantinePath(id)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async read(storageKey: string) {
    if (!/^assets\/[0-9a-f-]+\.bin$/i.test(storageKey)) throw new DomainError("invalid_storage_key", "Storage key is invalid");
    return readFile(this.assertInside(resolve(this.root, storageKey)));
  }

  async remove(storageKey: string) {
    if (!/^assets\/[0-9a-f-]+\.bin$/i.test(storageKey)) throw new DomainError("invalid_storage_key", "Storage key is invalid");
    try {
      await unlink(this.assertInside(resolve(this.root, storageKey)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
