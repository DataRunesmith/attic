#!/usr/bin/env node
// Assembles the documentation from README.md, docker/README.md and docs/:
//
//   node tools/docs-site.mjs && zensical build    # the site, in site-docs/
//   node tools/docs-site.mjs --wiki <dir>         # the GitHub wiki, in <dir>
//   node tools/docs-site.mjs --csp-hashes <dir>   # CSP hashes of the built site
//
// README.md becomes the start page and docker/README.md the Docker page; docs/
// is included as it is, except docs/agents/, which is written for coding agents.
// Links between those files are rewritten to the pages they become, and links
// to anything else in the repo point to the file on GitHub, so every link works
// on the site and in the wiki. The repo address is repo_url in zensical.toml,
// and the page titles and their order come from nav there. The README line that
// links to the site itself ("**Documentation:** ...") is left out.
//
// The wiki is a one-way mirror: its pages are flat (Home, Docker and one page
// per nav title), with _Sidebar.md for the menu and _Footer.md saying where to
// make changes. .github/workflows/wiki.yml writes it on every push to main.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { posix } from "node:path";

// --csp-hashes: print the CSP sources ('sha256-...') that allow the inline
// scripts in the built HTML under <dir>, for a Content-Security-Policy that
// does not allow inline scripts in general.
if (process.argv[2] === "--csp-hashes") {
  const hashes = new Set();
  const scan = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = posix.join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (path.endsWith(".html")) {
        for (const [, code] of readFileSync(path, "utf8").matchAll(
          /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g,
        )) {
          if (code) hashes.add(`'sha256-${createHash("sha256").update(code).digest("base64")}'`);
        }
      }
    }
  };
  scan(process.argv[3]);
  console.log([...hashes].sort().join(" "));
  process.exit(0);
}

const wiki = process.argv[2] === "--wiki";
const out = wiki ? process.argv[3] : "site-docs";
if (!out) throw new Error("usage: node tools/docs-site.mjs [--wiki <dir>]");
const config = readFileSync("zensical.toml", "utf8");
const repoUrl = config.match(/^repo_url\s*=\s*"([^"]+)"/m)?.[1];
if (!repoUrl) throw new Error("repo_url is missing in zensical.toml");

// Site path -> title, from nav entries like { "Arkitektur" = "architecture.md" }.
const titles = new Map(
  [...config.matchAll(/\{\s*"([^"]+)"\s*=\s*"([^"]+\.md)"\s*\}/g)].map(([, t, f]) => [f, t]),
);
titles.set("index.md", "Home");

// Repo path -> path on the site.
const pages = new Map();
for (const [src, dst] of [
  ["README.md", "index.md"],
  ["docker/README.md", "docker.md"],
]) {
  if (existsSync(src)) pages.set(src, dst);
}
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = posix.join(dir, entry.name);
    if (path === "docs/agents") continue;
    if (entry.isDirectory()) walk(path);
    else pages.set(path, path.slice("docs/".length));
  }
};
if (existsSync("docs")) walk("docs");

// Wiki page names are flat: the nav title with spaces as hyphens.
const wikiName = (page) =>
  (titles.get(page) ?? posix.basename(page, ".md")).replace(/[\s/]+/g, "-");
const onWiki = (page) => page.endsWith(".md");

const link = (src, dst, target) => {
  if (/^([a-z]+:|#|\/)/i.test(target)) return target;
  const [path, anchor] = target.split("#", 2);
  const suffix = anchor === undefined ? "" : `#${anchor}`;
  const resolved = posix.normalize(posix.join(posix.dirname(src), path)).replace(/\/$/, "");
  const page = pages.get(resolved);
  if (page && !wiki) return posix.relative(posix.dirname(dst), page) + suffix;
  if (page && onWiki(page)) return wikiName(page) + suffix;
  return `${repoUrl}/blob/main/${resolved}${suffix}`;
};

const rewrite = (src, dst, text) => {
  let fenced = false;
  return text
    .split("\n")
    .filter((line) => !(src === "README.md" && line.startsWith("**Documentation:**")))
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      return line.replace(
        /(\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g,
        (_, open, target, close) => open + link(src, dst, target) + close,
      );
    })
    .join("\n");
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let count = 0;
for (const [src, dst] of pages) {
  if (wiki && !onWiki(dst)) continue;
  const target = posix.join(out, wiki ? `${wikiName(dst)}.md` : dst);
  mkdirSync(posix.dirname(target), { recursive: true });
  if (src.endsWith(".md")) writeFileSync(target, rewrite(src, dst, readFileSync(src, "utf8")));
  else cpSync(src, target);
  count++;
}
if (wiki) {
  const menu = [...titles.keys()]
    .filter((page) => [...pages.values()].includes(page))
    .map((page) => `- [${page === "index.md" ? "Home" : titles.get(page)}](${wikiName(page)})`);
  writeFileSync(
    posix.join(out, "_Sidebar.md"),
    [...menu, `- [Source on GitHub](${repoUrl}#readme)`, ""].join("\n"),
  );
  writeFileSync(
    posix.join(out, "_Footer.md"),
    `This wiki is mirrored automatically from [the repo](${repoUrl}) (\`README.md\`, \`docker/README.md\` and \`docs/\`) on every merge to \`main\`. Edit there; changes here are overwritten.\n`,
  );
}
console.log(`${out}/: ${count} pages`);
