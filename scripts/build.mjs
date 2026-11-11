import { build } from "esbuild";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
await mkdir("public/fonts", { recursive: true });
await copyFile(
  "node_modules/@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2",
  "public/fonts/dm-sans-latin.woff2",
);
await copyFile(
  "node_modules/@fontsource-variable/dm-sans/LICENSE",
  "public/fonts/OFL.txt",
);
const notices = [
  "motion/LICENSE.md",
  "framer-motion/LICENSE.md",
  "motion-dom/LICENSE.md",
  "motion-utils/LICENSE.md",
  "tslib/CopyrightNotice.txt",
  "tslib/LICENSE.txt",
];
await writeFile(
  "public/third-party-licenses.txt",
  (
    await Promise.all(
      notices.map(
        async (file) =>
          file + "\n\n" + (await readFile("node_modules/" + file, "utf8")),
      ),
    )
  ).join("\n\n"),
);
await build({
  entryPoints: ["frontend/motion-ui.js"],
  outfile: "public/motion-ui.js",
  bundle: true,
  format: "esm",
  minify: true,
  target: ["es2022"],
  legalComments: "eof",
});
