import { spawnSync } from "node:child_process";

const waivers = new Map([
  [1138808, "2026-12-05"],
  [1138809, "2026-12-05"]
]);
const result = spawnSync("npm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
if (!result.stdout) throw new Error(result.stderr || "npm audit returned no report");
const report = JSON.parse(result.stdout);
const today = new Date().toISOString().slice(0, 10);

function findings(name, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const vulnerability = report.vulnerabilities?.[name];
  if (!vulnerability || !["high", "critical"].includes(vulnerability.severity)) return [];
  const unresolved = [];
  for (const cause of vulnerability.via || []) {
    if (typeof cause === "string") unresolved.push(...findings(cause, new Set(seen)));
    else if (["high", "critical"].includes(cause.severity) && (waivers.get(cause.source) || "") < today) {
      unresolved.push(`${cause.name}: ${cause.url || cause.source}`);
    }
  }
  return unresolved.length || vulnerability.via?.length ? unresolved : [name];
}

const unresolved = [...new Set(Object.keys(report.vulnerabilities || {}).flatMap((name) => findings(name)))];
if (unresolved.length) {
  console.error(`Unwaived high/critical advisories:\n${unresolved.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("No unwaived high/critical dependency advisories.");
}
