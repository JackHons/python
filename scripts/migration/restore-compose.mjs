#!/usr/bin/env node

/**
 * One-shot, no-overwrite restore into a fresh Docker Compose project.
 *
 * This script deliberately has a stopped-by-default final state.  It verifies
 * the private export, copies .env and .local-secrets only when their targets
 * are absent, builds the six application services, creates (but does not
 * start) the containers, verifies Compose labels/mounts and empty volumes,
 * copies data into the backend mounts, and fixes ownership as UID/GID 1000.
 * Pass --start to request the final `docker compose up -d` in the same run.
 */

import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { verifyExport } from "./verify-export.mjs";

const SERVICES = ["gateway", "web", "backend", "runner", "converter", "email-worker"];
const VOLUME_KEYS = ["backend-db", "backend-storage", "backend-exports", "backend-backups"];
const MOUNT_EXPECTATIONS = {
  backend: {
    "/data/db": "backend-db",
    "/data/storage": "backend-storage",
    "/data/exports": "backend-exports",
    "/data/backups": "backend-backups",
  },
  converter: {
    "/data/db": "backend-db",
    "/data/storage": "backend-storage",
  },
  "email-worker": {
    "/data/db": "backend-db",
  },
  gateway: {},
  web: {},
  runner: {},
};
const DATA_DIRECTORIES = ["db", "storage", "exports", "backups"];
const FORBIDDEN_PROJECTS = new Set(["python-learning-platform", "functional-test"]);

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = { start: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--start") {
      options.start = true;
      continue;
    }
    const valueOptions = new Map([
      ["--private-root", "privateRoot"],
      ["--project", "project"],
      ["--workspace", "workspace"],
      ["--compose-file", "composeFile"],
    ]);
    const optionName = valueOptions.get(argument);
    if (optionName) {
      const value = argv[++index];
      if (!value) fail(`${argument} requires a value`);
      if (options[optionName]) fail(`${argument} was supplied more than once`);
      options[optionName] = value;
      continue;
    }
    fail(`unknown option: ${argument}`);
  }
  if (!options.privateRoot || !options.project) {
    fail("usage: node scripts/migration/restore-compose.mjs --private-root PRIVATE_EXPORT_ROOT --project NEW_PROJECT [--start]");
  }
  return options;
}

function usage() {
  return [
    "Restore a verified private export into a fresh, stopped-by-default Compose project.",
    "",
    "Usage:",
    "  node scripts/migration/restore-compose.mjs --private-root PRIVATE_EXPORT_ROOT --project NEW_PROJECT",
    "  node scripts/migration/restore-compose.mjs --private-root PRIVATE_EXPORT_ROOT --project NEW_PROJECT --start",
    "",
    "The workspace defaults to the current directory. Existing workspace .env, .local-secrets,",
    "Compose project containers, networks, or volumes are rejected; secret values are never printed.",
  ].join("\n");
}

async function pathInfo(pathname) {
  try {
    return await lstat(pathname);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function requireDirectory(pathname, label) {
  const info = await pathInfo(pathname);
  if (!info) fail(`${label} is missing: ${pathname}`);
  if (info.isSymbolicLink() || !info.isDirectory()) fail(`${label} must be a real directory: ${pathname}`);
}

async function requireFile(pathname, label) {
  const info = await pathInfo(pathname);
  if (!info) fail(`${label} is missing: ${pathname}`);
  if (info.isSymbolicLink() || !info.isFile()) fail(`${label} must be a real file: ${pathname}`);
}

async function requireAbsent(pathname, label) {
  if (await pathInfo(pathname)) fail(`${label} already exists; refusing to overwrite: ${pathname}`);
}

async function copyTreeNoOverwrite(source, destination) {
  const sourceInfo = await pathInfo(source);
  if (!sourceInfo || sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
    fail(`private ${source} must be a real directory`);
  }
  await mkdir(destination, { mode: 0o700 });
  await chmod(destination, 0o700).catch(() => {});
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const info = await lstat(sourcePath);
    if (info.isSymbolicLink()) fail(`private export contains a symlink: ${sourcePath}`);
    if (info.isDirectory()) {
      await copyTreeNoOverwrite(sourcePath, destinationPath);
      continue;
    }
    if (!info.isFile()) fail(`private export contains a non-regular file: ${sourcePath}`);
    await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
    await chmod(destinationPath, 0o600).catch(() => {});
  }
}

async function copyFileNoOverwrite(source, destination, label) {
  await requireFile(source, label);
  await requireAbsent(destination, label);
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  await chmod(destination, 0o600).catch(() => {});
}

function parseEnvKeys(contents) {
  const keys = [];
  for (const line of contents.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

async function composeEnvironment(envFile) {
  const contents = await readFile(envFile, "utf8");
  const environment = { ...process.env };
  // Compose gives shell variables precedence over --env-file. Remove every
  // key declared by the copied file so the preserved values are authoritative.
  for (const key of parseEnvKeys(contents)) delete environment[key];
  return environment;
}

function runDocker(args, { cwd, env, capture = false, label = "docker", allowFailure = false } = {}) {
  const result = spawnSync("docker", args, {
    cwd,
    env: env ?? process.env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true,
  });
  if (result.error) fail(`${label} could not run Docker CLI: ${result.error.message}`);
  const status = result.status ?? 1;
  if (status !== 0 && !allowFailure) fail(`${label} failed with exit code ${status}; no secret output was retained`);
  return {
    status,
    stdout: capture ? String(result.stdout ?? "") : "",
    stderr: capture ? String(result.stderr ?? "") : "",
  };
}

function lines(output) {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseJson(output, label) {
  try {
    return JSON.parse(output.trim());
  } catch (error) {
    fail(`${label} returned invalid JSON: ${error.message}`);
  }
}

function inspectJson(args, label) {
  const result = runDocker(["inspect", ...args], { capture: true, label });
  return parseJson(result.stdout, label);
}

function composeRunner({ workspace, composeFile, envFile, project, env }) {
  const prefix = ["compose", "-p", project, "--env-file", envFile, "-f", composeFile];
  return {
    run(args, options = {}) {
      return runDocker([...prefix, ...args], { cwd: workspace, env, ...options, label: options.label ?? `docker compose ${args[0]}` });
    },
    prefix,
  };
}

function validateProject(project) {
  if (!/^[a-z0-9][a-z0-9_-]{2,62}$/u.test(project)) {
    fail("--project must be 3-63 lowercase ASCII characters using only a-z, 0-9, '-' or '_'");
  }
  if (FORBIDDEN_PROJECTS.has(project)) fail(`refusing reserved live/test project name: ${project}`);
}

function resourceNames(compose, resource) {
  return lines(compose.run(["config", `--${resource}`], { capture: true, label: `compose config --${resource}` }).stdout);
}

function ensureDockerAvailable() {
  runDocker(["info"], { capture: true, label: "docker info" });
}

function directList(args, label) {
  return lines(runDocker(args, { capture: true, label }).stdout);
}

function assertFreshProject(project, volumeKeys, networkKeys) {
  const containers = directList(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`], "project container lookup");
  if (containers.length > 0) fail(`Compose project ${project} already has container resources; refusing to reuse it`);
  const labeledVolumes = directList(["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`], "project volume lookup");
  if (labeledVolumes.length > 0) fail(`Compose project ${project} already has labeled volumes; refusing to reuse them`);
  const labeledNetworks = directList(["network", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`], "project network lookup");
  if (labeledNetworks.length > 0) fail(`Compose project ${project} already has labeled networks; refusing to reuse them`);

  const allContainerNames = new Set(directList(["ps", "-aq", "--format", "{{.Names}}"], "container name lookup"));
  if ([...allContainerNames].some((name) => name.startsWith(`${project}-`) || name.startsWith(`${project}_`))) {
    fail(`a container name is already reserved by Compose project ${project}; refusing to reuse it`);
  }
  const allVolumeNames = new Set(directList(["volume", "ls", "--format", "{{.Name}}"], "volume name lookup"));
  const predictedVolumes = new Set(volumeKeys.flatMap((key) => [`${project}_${key}`, `${project}-${key}`]));
  for (const name of predictedVolumes) if (allVolumeNames.has(name)) fail(`volume ${name} already exists; refusing to reuse it`);
  const allNetworkNames = new Set(directList(["network", "ls", "--format", "{{.Name}}"], "network name lookup"));
  const predictedNetworks = new Set(networkKeys.flatMap((key) => [`${project}_${key}`, `${project}-${key}`]));
  for (const name of predictedNetworks) if (allNetworkNames.has(name)) fail(`network ${name} already exists; refusing to reuse it`);

  return { allVolumeNames };
}

function serviceContainer(compose, service) {
  const ids = lines(compose.run(["ps", "-aq", service], { capture: true, label: `compose container lookup (${service})` }).stdout);
  if (ids.length !== 1) fail(`expected exactly one stopped container for service ${service}; found ${ids.length}`);
  return ids[0];
}

function inspectContainer(containerId, service, project) {
  const result = inspectJson([containerId], `container inspect (${service})`);
  if (!Array.isArray(result) || result.length !== 1) fail(`container inspect returned an unexpected result for ${service}`);
  const container = result[0];
  const labels = container.Config?.Labels ?? {};
  if (labels["com.docker.compose.project"] !== project || labels["com.docker.compose.service"] !== service) {
    fail(`container labels do not match project/service for ${service}`);
  }
  return container;
}

function inspectVolume(volumeName, expectedProject, expectedKey) {
  const result = inspectJson(["volume", volumeName], `volume inspect (${volumeName})`);
  if (!Array.isArray(result) || result.length !== 1) fail(`volume inspect returned an unexpected result for ${volumeName}`);
  const labels = result[0].Labels ?? {};
  if (labels["com.docker.compose.project"] !== expectedProject || labels["com.docker.compose.volume"] !== expectedKey) {
    fail(`volume labels do not match project/key for ${volumeName}`);
  }
  return result[0];
}

function verifyServiceMounts(containerIds, project, previouslyExistingVolumes) {
  const discovered = new Map();
  for (const service of SERVICES) {
    const container = inspectContainer(containerIds[service], service, project);
    const mounts = Array.isArray(container.Mounts) ? container.Mounts : [];
    const expectations = MOUNT_EXPECTATIONS[service];
    for (const mount of mounts) {
      if (mount.Type === "bind") fail(`bind mount is not allowed during migration (${service}:${mount.Destination})`);
      if (mount.Type === "volume" && !Object.prototype.hasOwnProperty.call(expectations, mount.Destination)) {
        fail(`unexpected named volume mount (${service}:${mount.Destination})`);
      }
    }
    for (const [destination, expectedKey] of Object.entries(expectations)) {
      const mount = mounts.find((candidate) => candidate.Destination === destination);
      if (!mount || mount.Type !== "volume" || mount.RW !== true) {
        fail(`expected writable named volume mount is missing (${service}:${destination})`);
      }
      if (previouslyExistingVolumes.has(mount.Name)) fail(`volume ${mount.Name} existed before create; refusing to import into it`);
      inspectVolume(mount.Name, project, expectedKey);
      discovered.set(expectedKey, mount.Name);
    }
  }
  for (const key of VOLUME_KEYS) if (!discovered.has(key)) fail(`volume mount key was not discovered: ${key}`);
  return discovered;
}

function runBackendHelper(compose, command, label) {
  return compose.run(
    ["run", "--rm", "--no-deps", "--user", "0", "--entrypoint", "/bin/sh", "backend", "-c", command],
    { capture: true, label },
  );
}

async function main(options) {
  validateProject(options.project);
  const workspace = resolve(options.workspace ?? process.cwd());
  const privateRoot = resolve(options.privateRoot);
  const composeFile = resolve(workspace, options.composeFile ?? "docker-compose.yml");
  const envFile = resolve(workspace, ".env");
  const localSecrets = resolve(workspace, ".local-secrets");
  await requireDirectory(workspace, "workspace");
  await requireFile(composeFile, "Compose file");
  await requireAbsent(envFile, "workspace .env");
  await requireAbsent(localSecrets, "workspace .local-secrets");

  const verification = await verifyExport({ rootDir: privateRoot });
  const privateEnv = resolve(privateRoot, ".env");
  const privateSecrets = resolve(privateRoot, ".local-secrets");
  const env = await composeEnvironment(privateEnv);

  ensureDockerAvailable();
  const preflightCompose = composeRunner({ workspace, composeFile, envFile: privateEnv, project: options.project, env });
  const services = resourceNames(preflightCompose, "services");
  for (const service of SERVICES) if (!services.includes(service)) fail(`Compose file is missing required service: ${service}`);
  const volumeKeys = resourceNames(preflightCompose, "volumes");
  for (const key of VOLUME_KEYS) if (!volumeKeys.includes(key)) fail(`Compose file is missing required volume: ${key}`);
  const networkKeys = resourceNames(preflightCompose, "networks");
  const freshness = assertFreshProject(options.project, VOLUME_KEYS, networkKeys);

  // No destination secret is created until the namespace collision checks have
  // passed. This keeps a rejected run side-effect-free in the source checkout.
  await copyFileNoOverwrite(privateEnv, envFile, "private .env");
  await copyTreeNoOverwrite(privateSecrets, localSecrets);
  const compose = composeRunner({ workspace, composeFile, envFile, project: options.project, env });

  console.log(`Verified private export (${verification.files.length} files; source ${verification.manifest.sourceCommit}).`);
  console.log(`Building six services in fresh Compose project ${options.project}; secret values are not printed.`);
  compose.run(["build", "--pull", ...SERVICES], { label: "compose build" });
  compose.run(["create", "--no-build", ...SERVICES], { label: "compose create" });

  const containerIds = Object.fromEntries(SERVICES.map((service) => [service, serviceContainer(compose, service)]));
  verifyServiceMounts(containerIds, options.project, freshness.allVolumeNames);
  const emptyCheck = runBackendHelper(
    compose,
    [
      "set -eu",
      ...DATA_DIRECTORIES.map((directory) => `entry=$(find /data/${directory} -mindepth 1 -print -quit); if [ -n \"$entry\" ]; then printf 'NON_EMPTY:%s\\n' '/data/${directory}'; exit 7; fi`),
    ].join("; "),
    "empty-volume check",
  );
  if (emptyCheck.stdout.includes("NON_EMPTY:") || emptyCheck.stderr.includes("NON_EMPTY:")) {
    fail("new Compose volumes are not empty; refusing to import");
  }

  const backendId = containerIds.backend;
  const dataRoot = resolve(privateRoot, "data");
  for (const directory of DATA_DIRECTORIES) {
    const sourcePath = `${resolve(dataRoot, directory)}${sep}.`;
    runDocker(["cp", sourcePath, `${backendId}:/data/${directory}/`], { cwd: workspace, label: `docker cp data/${directory}` });
  }
  runBackendHelper(
    compose,
    ["set -eu", ...DATA_DIRECTORIES.map((directory) => `chown -R 1000:1000 '/data/${directory}'`)].join("; "),
    "ownership fix",
  );
  const ownershipCheck = runBackendHelper(
    compose,
    [
      "set -eu",
      ...DATA_DIRECTORIES.map((directory) => `bad=$(find /data/${directory} -xdev -not -uid 1000 -print -quit); if [ -n \"$bad\" ]; then printf 'BAD_OWNER:%s\\n' \"$bad\"; exit 8; fi`),
    ].join("; "),
    "ownership check",
  );
  if (ownershipCheck.stdout.includes("BAD_OWNER:") || ownershipCheck.stderr.includes("BAD_OWNER:")) {
    fail("imported files are not owned by node UID 1000");
  }

  if (options.start) {
    console.log("Restore is complete; --start requested, starting the new project now.");
    compose.run(["up", "-d"], { label: "compose up -d" });
    console.log(`Started ${options.project}. Use the same explicit -p/--env-file flags for all later Compose commands.`);
  } else {
    console.log("Restore is complete and services remain stopped by design.");
    console.log(`Start explicitly when ready: docker compose -p ${options.project} --env-file .env -f docker-compose.yml up -d`);
  }
}

const isMain = process.argv[1] && resolve(fileURLToPath(pathToFileURL(process.argv[1]))) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(usage());
    else await main(options);
  } catch (error) {
    console.error(`restore-compose: ${error.message}`);
    process.exitCode = 1;
  }
}

export { main as restoreCompose };
