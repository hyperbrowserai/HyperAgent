import fs from "fs";
import path from "path";
import esbuild from "esbuild";

fs.mkdirSync(path.join(__dirname, "./inject"), { recursive: true });

esbuild.buildSync({
  entryPoints: [path.join(__dirname, "build-dom-view.ts")],
  bundle: true,
  outfile: path.join(__dirname, "inject", "build-dom-view-script.js"),
});

const scriptContent = fs.readFileSync(
  path.join(__dirname, "./inject/build-dom-view-script.js"),
  "utf8",
);
const lines = scriptContent.trim().split("\n");
const trimmedContent = `(() => {
${lines.slice(2, -1).join("\n")}
  return buildDomView();
})();`;
fs.writeFileSync(
  path.join(__dirname, "./inject/build-dom-view-script.js"),
  trimmedContent,
);
const escapedContent = trimmedContent
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");
const tsConstFile = `export const buildDomViewJs = \`${escapedContent}\`;`;

fs.writeFileSync(
  path.join(__dirname, "./inject/build-dom-view.ts"),
  tsConstFile,
);
