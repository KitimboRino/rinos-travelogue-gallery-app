/**
 * upload-to-appwrite.js
 * Uploads all images from /public/gallery/ to an Appwrite Storage bucket.
 *
 * File IDs follow the convention:  {location}_{filename-without-ext}
 *   e.g.  jinja/1.jpg       → jinja_1
 *         kapchorwa/k1.jpg  → kapchorwa_k1
 *         fortportal/g8.jpg → fortportal_g8
 *
 * Already-uploaded files are skipped (idempotent).
 *
 * Usage:
 *   1. Copy .env.appwrite.example → .env.appwrite and fill in your credentials.
 *   2. npm run upload-to-appwrite
 *
 * Required env vars:
 *   APPWRITE_ENDPOINT    — e.g. https://cloud.appwrite.io/v1
 *   APPWRITE_PROJECT_ID  — your Appwrite project ID
 *   APPWRITE_BUCKET_ID   — your Appwrite storage bucket ID
 *   APPWRITE_API_KEY     — server API key with storage.write scope
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Minimal .env loader — reads .env.appwrite, then .env.local (no dotenv dep)
// ---------------------------------------------------------------------------
function loadEnvFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    content.split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) return;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (key && !(key in process.env)) {
        process.env[key] = val;
      }
    });
  } catch {
    // File doesn't exist — that's fine
  }
}

const root = path.join(__dirname, '..');
loadEnvFile(path.join(root, '.env.appwrite'));
loadEnvFile(path.join(root, '.env.local'));

// ---------------------------------------------------------------------------
// Validate config
// ---------------------------------------------------------------------------
const ENDPOINT = process.env.APPWRITE_ENDPOINT;
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
const BUCKET_ID = process.env.APPWRITE_BUCKET_ID;
const API_KEY = process.env.APPWRITE_API_KEY;

if (!ENDPOINT || !PROJECT_ID || !BUCKET_ID || !API_KEY) {
  console.error(
    '\nMissing Appwrite configuration. Please set:\n' +
      '  APPWRITE_ENDPOINT\n' +
      '  APPWRITE_PROJECT_ID\n' +
      '  APPWRITE_BUCKET_ID\n' +
      '  APPWRITE_API_KEY\n\n' +
      'Copy .env.appwrite.example → .env.appwrite and fill in the values.\n'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Appwrite SDK
// ---------------------------------------------------------------------------
const { Client, Storage, InputFile } = require('node-appwrite');

const client = new Client()
  .setEndpoint(ENDPOINT)
  .setProject(PROJECT_ID)
  .setKey(API_KEY);

const storage = new Storage(client);
const GALLERY_DIR = path.join(root, 'public', 'gallery');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const IMAGE_EXTS = /\.(jpg|jpeg|png|webp)$/i;

/** Converts location + filename → deterministic Appwrite file ID */
const toFileId = (location, filename) => {
  const name = path.parse(filename).name.replace(/[^a-zA-Z0-9]/g, '_');
  return `${location}_${name}`;
};

/** Returns true if the file already exists in the bucket */
async function fileExists(fileId) {
  try {
    await storage.getFile(BUCKET_ID, fileId);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------
async function uploadImages() {
  console.log(`\nAppwrite endpoint : ${ENDPOINT}`);
  console.log(`Project           : ${PROJECT_ID}`);
  console.log(`Bucket            : ${BUCKET_ID}`);
  console.log(`Gallery dir       : ${GALLERY_DIR}\n`);

  const locations = fs
    .readdirSync(GALLERY_DIR)
    .filter((f) => fs.statSync(path.join(GALLERY_DIR, f)).isDirectory())
    .sort();

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const location of locations) {
    const locationDir = path.join(GALLERY_DIR, location);
    const files = fs
      .readdirSync(locationDir)
      .filter((f) => IMAGE_EXTS.test(f))
      .sort();

    console.log(`\n[${location}] — ${files.length} image(s)`);

    for (const file of files) {
      const fileId = toFileId(location, file);
      const filePath = path.join(locationDir, file);

      if (await fileExists(fileId)) {
        console.log(`  skip  ${file}  (${fileId})`);
        skipped++;
        continue;
      }

      try {
        await storage.createFile(BUCKET_ID, fileId, InputFile.fromPath(filePath, file));
        console.log(`  ✓     ${file}  → ${fileId}`);
        uploaded++;
      } catch (err) {
        console.error(`  ✗     ${file}  — ${err.message}`);
        failed++;
      }
    }
  }

  console.log(`\n─────────────────────────────────`);
  console.log(`Uploaded : ${uploaded}`);
  console.log(`Skipped  : ${skipped}`);
  console.log(`Failed   : ${failed}`);
  console.log(`─────────────────────────────────\n`);

  if (failed > 0) process.exit(1);
}

uploadImages().catch((err) => {
  console.error('Upload failed:', err.message);
  process.exit(1);
});
