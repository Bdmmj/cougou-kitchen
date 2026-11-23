import { cp, mkdir, rm, writeFile } from "node:fs/promises";
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

// Cloudflare Pages can serve /admin from /admin/index.html.
await cp(join(root, "admin.html"), join(out, "admin", "index.html"));

await writeFile(
  join(out, "_headers"),
  `/*
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

console.log("Cloudflare Pages static build ready:", out);
