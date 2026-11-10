import {
  closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Read a file-backed environment value without following symlinks or leaving its config directory. */
function readSecretValue(envFile, reference) {
  const base = realpathSync(dirname(resolve(envFile)));
  const requested = reference.slice(1);
  if (!requested || isAbsolute(requested))
    throw new Error("File-backed environment values must use a relative path.");
  const target = resolve(base, requested);
  const rel = relative(base, target);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    throw new Error("File-backed environment value escapes its configuration directory.");

  let current = base;
  const parts = rel.split(sep);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink())
      throw new Error("File-backed environment values cannot use symlinks.");
    if (i < parts.length - 1 && !stat.isDirectory())
      throw new Error("File-backed environment value parent must be a directory.");
    if (i === parts.length - 1 && !stat.isFile())
      throw new Error("File-backed environment value must be a regular file.");
  }

  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (!fstatSync(fd).isFile())
      throw new Error("File-backed environment value must be a regular file.");
    return readFileSync(fd, "utf8").trimEnd();
  } finally {
    closeSync(fd);
  }
}

/** Parse the shared KEY=value format, including quoted, escaped, and file-backed values. */
export function parseEnv(file) {
  const envPath = resolve(file);
  const fileStat = lstatSync(envPath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink())
    throw new Error("Environment file must be a regular, non-symlink file.");
  const fd = openSync(envPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let source;
  try {
    if (!fstatSync(fd).isFile())
      throw new Error("Environment file must be a regular file.");
    source = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }

  const values = new Map();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2];
    if (value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
         (value.startsWith("'") && value.endsWith("'"))))
      value = value.slice(1, -1);
    if (value.startsWith("@"))
      value = readSecretValue(envPath, value);
    else
      value = value.replaceAll("\\n", "\n");
    values.set(match[1], value);
  }
  return values;
}
