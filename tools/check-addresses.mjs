#!/usr/bin/env node
// Fails if a tracked file contains an e-mail address outside the reserved
// example domains (RFC 2606: example.com/.net/.org, .example, .test, .invalid,
// .localhost). Real addresses are data, and data never goes in this repo.
//
//   node tools/check-addresses.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ADDRESS = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const RESERVED = /(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i;
// Package scopes and versions look like addresses but are not.
const NOT_AN_ADDRESS = /^(?:\d+(?:\.\d+)*|[a-z]+\.(?:js|ts|mjs|json))$/i;

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(
    (path) => path && !/(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|bun\.lock)$/.test(path),
  );

const found = [];
for (const path of files) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue; // binary
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(ADDRESS)) {
      if (line[match.index - 1] === ":") continue; // user:password@host in a URL
      const domain = match[1].replace(/\.$/, "");
      if (!RESERVED.test(domain) && !NOT_AN_ADDRESS.test(domain))
        found.push(`${path}:${index + 1}: ${match[0]}`);
    }
  });
}

if (found.length) {
  console.error(`E-postadresser utanför exempeldomänerna (${found.length}):\n${found.join("\n")}`);
  console.error("Använd example.com, .example eller .test i kod, tester och dokumentation.");
  process.exit(1);
}
console.log(`Inga riktiga e-postadresser i ${files.length} filer.`);
