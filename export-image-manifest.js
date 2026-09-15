const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const IMAGE_ROOT = path.join(ROOT, "images", "products");
const OUT = path.join(ROOT, "image-manifest.json");
const products = {};
const allowed = /\.(jpe?g|png|webp|gif)$/i;

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (allowed.test(entry.name)) {
      const rel = path.relative(IMAGE_ROOT, full).replace(/\\/g, "/");
      const alias = rel.split("/")[0];
      if (!products[alias]) products[alias] = [];
      products[alias].push({ name: entry.name, url: `/images/products/${rel}` });
    }
  }
}

walk(IMAGE_ROOT);
for (const list of Object.values(products)) {
  list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

const payload = {
  savedAt: new Date().toISOString(),
  products
};
fs.writeFileSync(OUT, JSON.stringify(payload), "utf8");
console.log(JSON.stringify({
  savedAt: payload.savedAt,
  products: Object.keys(products).length,
  images: Object.values(products).reduce((sum, list) => sum + list.length, 0)
}));
