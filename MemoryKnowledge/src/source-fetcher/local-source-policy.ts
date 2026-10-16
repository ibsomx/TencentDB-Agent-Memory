import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Explicit desktop-only opt-in. Missing/invalid configuration fails closed. */
function allowedRoots(): Array<{ lexical: string; real: string }> {
  if (process.env.KNOWLEDGE_ALLOW_LOCAL_SOURCES?.trim() !== "true") {
    throw new Error("Local sources disabled; set KNOWLEDGE_ALLOW_LOCAL_SOURCES=true for desktop use");
  }
  let values: unknown;
  try { values = JSON.parse(process.env.KNOWLEDGE_LOCAL_SOURCE_ROOTS ?? "[]"); }
  catch { throw new Error("KNOWLEDGE_LOCAL_SOURCE_ROOTS must be a JSON array of absolute directories"); }
  if (!Array.isArray(values) || values.length === 0 || values.some(v => typeof v !== "string" || !path.isAbsolute(v))) {
    throw new Error("Configure nonempty absolute KNOWLEDGE_LOCAL_SOURCE_ROOTS");
  }
  return values.map((value: string) => {
    rejectSpecialPath(value);
    const lexical = path.resolve(value);
    const real = fs.realpathSync(lexical);
    if (!fs.statSync(real).isDirectory()) throw new Error("Local source root must be a directory");
    return { lexical, real };
  });
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function rejectSpecialPath(value: string): void {
  if (/[\x00-\x1f\x7f]/.test(value) || value.startsWith("\\\\") || value.startsWith("//") ||
      (process.platform === "win32" && value.slice(path.parse(value).root.length).includes(":"))) {
    throw new Error("Network/device paths, control characters and alternate data streams are not allowed");
  }
}

/** Name-based exclusion is defense in depth, not a secret-content detector. */
function excluded(candidate: string): boolean {
  return candidate.split(/[\\/]/).some(part => {
    const name = part.toLowerCase();
    return [".git", "node_modules", ".codegraph", ".ssh", ".aws", ".azure", ".docker", ".kube", ".gnupg", ".config",
      ".npmrc", ".netrc", "_netrc", ".pypirc", ".git-credentials", ".gitconfig", "credentials", "secrets", "kubeconfig"].includes(name) ||
      name.startsWith(".env") || /\.env(?:[.-].*)?$/.test(name) ||
      /\.(?:pem|key|p12|pfx|jks|keystore|tfstate)(?:\..*)?$/.test(name) ||
      /^id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-].*)?$/.test(name) ||
      /^\.(?:npmrc|netrc|pypirc|git-credentials|gitconfig)\./.test(name) ||
      /^(?:credentials|secrets?|tokens?|client[_-]secret|service[_-]account)(?:[._-].*)?$/.test(name);
  });
}

export function resolveLocalSource(sourceUrl: string): string {
  const roots = allowedRoots();
  let source = sourceUrl;
  if (/^file:/i.test(sourceUrl)) {
    const url = new URL(sourceUrl);
    if ((url.hostname && url.hostname !== "localhost") || url.username || url.password || url.search || url.hash) {
      throw new Error("Only local file URLs without credentials, query or fragment are allowed");
    }
    source = fileURLToPath(url);
  }
  rejectSpecialPath(source);
  if (!path.isAbsolute(source) && !/^\.{1,2}[\\/]/.test(source)) throw new Error("Explicit local path required");
  const lexical = path.resolve(source);
  const candidates = roots.filter(root => inside(root.lexical, lexical));
  if (!candidates.length || excluded(lexical)) throw new Error("Local source outside allowed roots or excluded");
  const stat = fs.lstatSync(lexical);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Local source must be a directory, not a symbolic link");
  const real = fs.realpathSync(lexical);
  if (!candidates.some(root => inside(root.real, real)) || excluded(real)) throw new Error("Local source resolves outside allowed roots or is excluded");
  return real;
}

function permittedEntry(root: string, entry: string): boolean {
  if (excluded(entry)) return false;
  rejectSpecialPath(entry);
  const stat = fs.lstatSync(entry);
  // Reject ALL symlinks/junctions, even those pointing inside; never copy a link.
  if (stat.isSymbolicLink()) throw new Error("Symbolic links/junctions are not allowed in local sources");
  if (!inside(root, fs.realpathSync(entry))) throw new Error("Local source entry escapes its directory");
  if (!stat.isDirectory() && (!stat.isFile() || stat.nlink > 1)) {
    throw new Error("Only directories and regular non-hardlinked files are allowed");
  }
  return true;
}

/** Validate the complete eligible tree without traversing excluded entries. */
export function validateLocalSource(sourceUrl: string): string {
  const source = resolveLocalSource(sourceUrl);
  const inspect = (entry: string): void => {
    if (!permittedEntry(source, entry)) return;
    if (fs.lstatSync(entry).isDirectory()) {
      for (const name of fs.readdirSync(entry)) inspect(path.join(entry, name));
    }
  };
  inspect(source);
  return source;
}

/** Validate before removing a previous snapshot, then recheck each copied entry. */
export function copyLocalSource(sourceUrl: string, localPath: string): void {
  const source = validateLocalSource(sourceUrl);
  const destination = path.resolve(localPath);
  rejectSpecialPath(destination);
  if (inside(source, destination) || inside(destination, source) || destination === path.parse(destination).root) {
    throw new Error("Local source and destination must not overlap");
  }
  // Refuse symlinked destination ancestors before cp/rm can follow them.
  for (let current = destination; ; current = path.dirname(current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Destination symlinks/junctions are not allowed");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current === path.dirname(current)) break;
  }
  // Refresh authorization immediately before replacement as well.
  if (resolveLocalSource(sourceUrl) !== source) throw new Error("Local source changed during validation");
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: false,
    filter: entry => permittedEntry(source, entry),
  });
}
