/**
 * scripts/optimize-images.js
 *
 * Drop raw photos into the right location folder under public/gallery/, then run:
 *   npm run optimize-images
 *
 * Folder structure:
 *   public/gallery/
 *     jinja/       ← photos from Jinja
 *     kampala/     ← photos from Kampala
 *     gulu/        ← photos from Gulu
 *     kabale/      ← photos from Kabale
 *     kapchorwa/   ← photos from Kapchorwa
 *     marchison/   ← photos from Marchison Falls
 *     fortportal/  ← photos from Fort Portal
 *
 * What it does:
 *  - Resizes images to a max width of 2400px (keeps aspect ratio, never enlarges)
 *  - Compresses JPEG at quality 78 with progressive encoding
 *  - Generates a .webp version alongside each image (~30% smaller)
 *  - Skips images that are already optimized (tracked in .optimized-manifest.json)
 *  - Prints a before/after size summary
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const GALLERY_DIR = path.join(__dirname, '../public/gallery');
const MANIFEST_FILE = path.join(GALLERY_DIR, '.optimized-manifest.json');
const MAX_WIDTH = 2400;
const JPEG_QUALITY = 78;
const WEBP_QUALITY = 80;
const SUPPORTED_EXTS = ['.jpg', '.jpeg', '.png', '.JPG', '.JPEG', '.PNG'];

// Load manifest of already-processed files
let manifest = {};
if (fs.existsSync(MANIFEST_FILE)) {
  try { manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')); } catch {}
}

// Recursively find all image files under a directory
function findImages(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findImages(fullPath));
    } else if (SUPPORTED_EXTS.includes(path.extname(entry.name)) && !entry.name.endsWith('.webp')) {
      results.push(fullPath);
    }
  }
  return results;
}

async function processImage(filePath) {
  const ext = path.extname(filePath);
  const webpPath = filePath.replace(/\.[^.]+$/, '.webp');
  const relPath = path.relative(GALLERY_DIR, filePath);

  const statBefore = fs.statSync(filePath).size;

  // Overwrite original with compressed+resized version
  const compressed = await sharp(filePath)
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, progressive: true, mozjpeg: true })
    .toBuffer();
  fs.writeFileSync(filePath, compressed);

  // Write WebP alongside
  await sharp(filePath)
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toFile(webpPath);

  const statAfter = fs.statSync(filePath).size;
  const saving = (((statBefore - statAfter) / statBefore) * 100).toFixed(1);
  const kb = n => `${(n / 1024).toFixed(0)}KB`;

  console.log(`  ✓ ${relPath.padEnd(30)} ${kb(statBefore).padStart(7)} → ${kb(statAfter).padStart(7)}  (${saving}% smaller)  +webp`);

  return { before: statBefore, after: statAfter };
}

async function run() {
  const allFiles = findImages(GALLERY_DIR);
  const toProcess = allFiles.filter(f => !manifest[path.relative(GALLERY_DIR, f)]);

  if (toProcess.length === 0) {
    console.log('\nNothing new to process.');
    console.log('To add photos: drop them into the right folder under public/gallery/ and re-run.\n');
    return;
  }

  console.log(`\nOptimizing ${toProcess.length} image(s)...\n`);

  let totalBefore = 0;
  let totalAfter = 0;

  for (const filePath of toProcess) {
    const relPath = path.relative(GALLERY_DIR, filePath);
    try {
      const { before, after } = await processImage(filePath);
      totalBefore += before;
      totalAfter += after;
      manifest[relPath] = { optimizedAt: new Date().toISOString() };
    } catch (err) {
      console.error(`  ✗ ${relPath}: ${err.message}`);
    }
  }

  // Save updated manifest
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));

  const mb = n => `${(n / 1024 / 1024).toFixed(1)}MB`;
  const totalSaving = (((totalBefore - totalAfter) / totalBefore) * 100).toFixed(1);
  console.log(`\nTotal: ${mb(totalBefore)} → ${mb(totalAfter)} (${totalSaving}% reduction)\n`);
}

run().catch(err => { console.error(err); process.exit(1); });
