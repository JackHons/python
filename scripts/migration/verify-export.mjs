#!/usr/bin/env node

/**
 * Read-only verifier for a private migration export.
 *
 * The export root must contain PRIVATE-MANIFEST.json.  The manifest lists
 * every regular file below the root (except the manifest itself), using
 * root-relative POSIX paths, byte size and a lowercase SHA-256 digest.
 * Symlinks and special files are rejected so an archive cannot redirect a
 * restore outside the intended export root.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MANIFEST_FILENAME = "PRIVATE-MANIFEST.json";
export const MANIFEST_FORMAT = "learning-platform-private-export/v1";

function fail(message) {
  throw new Error(message);
}

function safeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0) fail("manifest path must be a non-empty string");
  if (value.includes("\\") || value.includes("\0") || isAbsolute(value)) {
    fail(`manifest path is not a relative POSIX path: ${JSON.stringify(value)}`);
  }
  if (value.includes(":")) fail(`manifest path contains a drive/colon: ${JSON.stringify(value)}`);
  const normalized = posix.normalize(value);
  if (normalized !== value || value === "." || value.startsWith("../") || value === "..") {
    fail(`manifest path is not canonical/safe: ${JSON.stringify(value)}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    fail(`manifest path has an unsafe component: ${JSON.stringify(value)}`);
  }
  return value;
}

function targetFor(rootDir, relativePath) {
  const target = resolve(rootDir, ...relativePath.split("/"));
  const escaped = relative(rootDir, target);
  if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
    fail(`manifest path escapes export root: ${JSON.stringify(relativePath)}`);
  }
  return target;
}

async function assertRegularDirectory(pathname, label) {
  let info;
  try {
    info = await lstat(pathname);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${label} is missing: ${pathname}`);
    throw error;
  }
  if (info.isSymbolicLink()) fail(`${label} must not be a symlink: ${pathname}`);
  if (!info.isDirectory()) fail(`${label} must be a directory: ${pathname}`);
  return info;
}

async function walkRegularFiles(rootDir, currentDir = rootDir, result = []) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const pathname = resolve(currentDir, entry.name);
    const info = await lstat(pathname);
    if (info.isSymbolicLink()) fail(`export contains a symlink: ${pathname}`);
    if (info.isDirectory()) {
      await walkRegularFiles(rootDir, pathname, result);
      continue;
    }
    if (!info.isFile()) fail(`export contains a non-regular file: ${pathname}`);
    const relativePath = relative(rootDir, pathname).split(sep).join("/");
    safeRelativePath(relativePath);
    result.push(relativePath);
  }
  return result;
}

async function hashFile(pathname) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(pathname)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest("hex") };
}

function validateDigest(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail(`${label} must be 64 lowercase hexadecimal characters`);
  }
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("manifest must be a JSON object");
  if (manifest.format !== MANIFEST_FORMAT) {
    fail(`unsupported manifest format: ${JSON.stringify(manifest.format)}`);
  }
  if (typeof manifest.sourceCommit !== "string" || manifest.sourceCommit.length === 0) {
    fail("manifest.sourceCommit is required");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail("manifest.files must be a non-empty array");

  const expected = new Map();
  for (const [index, entry] of manifest.files.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`manifest.files[${index}] must be an object`);
    const path = safeRelativePath(entry.path);
    if (path === MANIFEST_FILENAME) fail("manifest must not hash itself");
    if (expected.has(path)) fail(`manifest contains a duplicate path: ${path}`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) fail(`manifest size is invalid for ${path}`);
    validateDigest(entry.sha256, `manifest sha256 for ${path}`);
    expected.set(path, { size: entry.size, sha256: entry.sha256 });
  }
  return expected;
}

/**
 * Verify an export without changing any file.
 *
 * @param {{rootDir: string, manifestPath?: string}} options
 * @returns {Promise<{manifest: object, files: string[], rootDir: string}>}
 */
export async function verifyExport({ rootDir, manifestPath } = {}) {
  if (typeof rootDir !== "string" || rootDir.length === 0) fail("rootDir is required");
  const resolvedRoot = resolve(rootDir);
  await assertRegularDirectory(resolvedRoot, "export root");

  const resolvedManifest = resolve(manifestPath ?? resolve(resolvedRoot, MANIFEST_FILENAME));
  const manifestRelative = relative(resolvedRoot, resolvedManifest);
  if (manifestRelative === ".." || manifestRelative.startsWith(`..${sep}`) || isAbsolute(manifestRelative)) {
    fail("manifest must be inside the export root");
  }
  if (manifestRelative.split(sep).join("/") !== MANIFEST_FILENAME) {
    fail(`manifest must be named ${MANIFEST_FILENAME} at the export root`);
  }
  const manifestInfo = await lstat(resolvedManifest).catch((error) => {
    if (error?.code === "ENOENT") fail(`manifest is missing: ${resolvedManifest}`);
    throw error;
  });
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) fail("manifest must be a regular file and not a symlink");

  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolvedManifest, "utf8"));
  } catch (error) {
    fail(`cannot parse ${MANIFEST_FILENAME}: ${error.message}`);
  }
  const expected = validateManifest(manifest);

  await assertRegularDirectory(resolve(resolvedRoot, "data"), "data root");
  for (const directory of ["db", "storage", "exports", "backups"]) {
    await assertRegularDirectory(resolve(resolvedRoot, "data", directory), `data/${directory}`);
  }
  await assertRegularDirectory(resolve(resolvedRoot, ".local-secrets"), ".local-secrets");
  const envPath = resolve(resolvedRoot, ".env");
  const envInfo = await lstat(envPath).catch((error) => {
    if (error?.code === "ENOENT") fail("private export .env is missing");
    throw error;
  });
  if (envInfo.isSymbolicLink() || !envInfo.isFile()) fail("private export .env must be a regular file and not a symlink");
  if (!expected.has(".env")) fail("manifest must include .env");
  if (!expected.has("data/db/learning.sqlite")) fail("manifest must include data/db/learning.sqlite");

  const actualFiles = (await walkRegularFiles(resolvedRoot)).filter((path) => path !== MANIFEST_FILENAME);
  const actualSet = new Set(actualFiles);
  for (const path of expected.keys()) {
    if (!actualSet.has(path)) fail(`manifest-listed file is missing: ${path}`);
  }
  for (const path of actualFiles) {
    if (!expected.has(path)) fail(`unmanifested regular file found: ${path}`);
  }

  for (const [path, expectedDigest] of expected.entries()) {
    const actualDigest = await hashFile(targetFor(resolvedRoot, path));
    if (actualDigest.size !== expectedDigest.size || actualDigest.sha256 !== expectedDigest.sha256) {
      fail(`hash/size mismatch: ${path}`);
    }
  }
  return { manifest, files: actualFiles, rootDir: resolvedRoot };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--root" || argument === "--manifest") {
      const value = argv[++index];
      if (!value) fail(`${argument} requires a value`);
      options[argument === "--root" ? "rootDir" : "manifestPath"] = value;
      continue;
    }
    if (argument.startsWith("-")) fail(`unknown option: ${argument}`);
    if (options.rootDir) fail("only one export root is accepted");
    options.rootDir = argument;
  }
  if (!options.rootDir) fail("usage: node scripts/migration/verify-export.mjs --root PRIVATE_EXPORT_ROOT");
  return options;
}

export function usage() {
  return [
    "Read-only private export verification.",
    "",
    "Usage:",
    "  node scripts/migration/verify-export.mjs --root PRIVATE_EXPORT_ROOT",
    "",
    `The root must contain ${MANIFEST_FILENAME}; every regular file except the manifest must be listed and hash-matched.`,
  ].join("\n");
}

const isMain = process.argv[1] && resolve(fileURLToPath(pathToFileURL(process.argv[1]))) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else {
      const result = await verifyExport(options);
      console.log(`PASS: verified ${result.files.length} private export file(s); no hashes or secret values were printed.`);
    }
  } catch (error) {
    console.error(`verify-export: ${error.message}`);
    process.exitCode = 1;
  }
}
