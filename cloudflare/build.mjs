import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(here, "public");

const files = [
  "index.html",
  "styles.css",
  "app.js",
  "admin.html",
  "admin.css",
  "admin.js",
];

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "admin"), { recursive: true });

for (const file of files) {
  await cp(join(root, file), join(out, file));
}

// Add a content hash to CSS/JS URLs. A new deployment therefore cannot be
// mixed with JS or CSS left in a browser's disk cache.
const versions = {};
for (const file of ["styles.css", "app.js", "admin.css", "admin.js"]) {
  const bytes = await readFile(join(root, file));
  versions[file] = createHash("sha256").update(bytes).digest("hex").slice(0, 10);
}

function rewriteAssetUrls(html) {
  return html
    .replaceAll('href="/styles.css"', `href="/styles.css?v=${versions["styles.css"]}"`)
    .replaceAll('href="styles.css"', `href="/styles.css?v=${versions["styles.css"]}"`)
    .replaceAll('src="/app.js"', `src="/app.js?v=${versions["app.js"]}"`)
    .replaceAll('src="app.js"', `src="/app.js?v=${versions["app.js"]}"`)
    .replaceAll('href="/admin.css"', `href="/admin.css?v=${versions["admin.css"]}"`)
    .replaceAll('href="admin.css"', `href="/admin.css?v=${versions["admin.css"]}"`)
    .replaceAll('src="/admin.js"', `src="/admin.js?v=${versions["admin.js"]}"`)
    .replaceAll('src="admin.js"', `src="/admin.js?v=${versions["admin.js"]}"`);
}

const indexHtml = rewriteAssetUrls(await readFile(join(root, "index.html"), "utf8"));
const adminHtml = rewriteAssetUrls(await readFile(join(root, "admin.html"), "utf8"));
await writeFile(join(out, "index.html"), indexHtml);
await writeFile(join(out, "admin.html"), adminHtml);
// Cloudflare Pages can serve /admin from /admin/index.html.
await writeFile(join(out, "admin", "index.html"), adminHtml);

await writeFile(
  join(out, "_headers"),
  `/*
  Cache-Control: no-store, no-cache, must-revalidate
  Pragma: no-cache
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: same-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
`,
);

await writeFile(
  join(out, "_redirects"),
  `/join/* / 200
`,
);

console.log("Cloudflare Pages static build ready:", out, versions);
