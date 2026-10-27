import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "dist", "legal");

mkdirSync(destination, { recursive: true });

for (const file of [
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "README.md",
]) {
  copyFileSync(path.join(root, file), path.join(destination, file));
}

cpSync(path.join(root, "licenses"), path.join(destination, "licenses"), {
  recursive: true,
});

const samplesDestination = path.join(destination, "samples");
mkdirSync(samplesDestination, { recursive: true });
copyFileSync(
  path.join(root, "samples", "README.md"),
  path.join(samplesDestination, "README.md"),
);
copyFileSync(
  path.join(root, "samples", "sample-page.png"),
  path.join(samplesDestination, "sample-page.png"),
);

// Collect the license files that npm installed for runtime dependencies. The
// source repository declares them in package-lock.json; production builds carry
// their notices next to the app so a deployed bundle keeps the required texts.
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const runtimePackages = Object.entries(lock.packages).filter(
  ([key, metadata]) => key.startsWith("node_modules/") && !metadata.dev,
);

const npmDestination = path.join(destination, "npm");
mkdirSync(npmDestination, { recursive: true });

const rows = [];
for (const [key, metadata] of runtimePackages) {
  const packageName = key.replace(/^node_modules\//, "");
  const source = path.join(root, "node_modules", packageName);
  const outputName = packageName.replace(/^@/, "").replaceAll("/", "__");
  const output = path.join(npmDestination, outputName);
  const license = metadata.license || "see package";

  mkdirSync(output, { recursive: true });

  let licenseFiles = [];
  try {
    licenseFiles = readdirSync(source).filter(
      (name) =>
        /^(licen[cs]e|copying|notice)/i.test(name) &&
        statSync(path.join(source, name)).isFile(),
    );
  } catch {
    // The package may be optional and absent on this platform.
  }

  for (const file of licenseFiles) {
    copyFileSync(path.join(source, file), path.join(output, file));
  }

  if (licenseFiles.length === 0) {
    writeFileSync(
      path.join(output, "README.txt"),
      [
        `Package: ${packageName}`,
        `Version: ${metadata.version}`,
        `License: ${license}`,
        "",
        "No standalone license file was found in the installed package.",
        `Package page: https://www.npmjs.com/package/${packageName}/v/${metadata.version}`,
        "",
      ].join("\n"),
    );
  }

  rows.push(
    `| \`${packageName}\` | ${metadata.version} | ${license} | \`${outputName}/\` |`,
  );
}

writeFileSync(
  path.join(npmDestination, "README.md"),
  [
    "# Runtime npm dependency notices",
    "",
    "These license texts were collected from the runtime dependency graph in",
    "`package-lock.json` during the production build. The app bundles code from",
    "these packages; keep this directory with any redistributed build.",
    "",
    "| Package | Version | License | Folder |",
    "|---|---|---|---|",
    ...rows,
    "",
    "Packages without a standalone license file contain a `README.txt` with the",
    "package name, version, license identifier, and npm package page.",
    "",
  ].join("\n"),
);

console.log("Copied license and notice files to dist/legal/");
