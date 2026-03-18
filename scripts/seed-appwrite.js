/**
 * seed-appwrite.js
 * Migrates existing /public/gallery/ images into Appwrite Storage + Database.
 * Idempotent — already-uploaded files and documents are skipped.
 *
 * Usage:
 *   1. Run npm run setup-appwrite first
 *   2. npm run seed-appwrite
 */

const { Client, Databases, Storage, ID, Query, Permission, Role } = require('node-appwrite');
const { InputFile } = require('node-appwrite/file');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Load env files
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
      if (key && !(key in process.env)) process.env[key] = val;
    });
  } catch {}
}

const root = path.join(__dirname, '..');
loadEnvFile(path.join(root, '.env.appwrite'));
loadEnvFile(path.join(root, '.env.local'));

const ENDPOINT   = process.env.APPWRITE_ENDPOINT;
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
const BUCKET_ID  = process.env.APPWRITE_BUCKET_ID;
const API_KEY    = process.env.APPWRITE_API_KEY;
const DB_ID      = process.env.APPWRITE_DATABASE_ID                  || 'gallery';
const LOC_COL    = process.env.APPWRITE_LOCATIONS_COLLECTION_ID      || 'locations';
const IMG_COL    = process.env.APPWRITE_IMAGES_COLLECTION_ID         || 'images';

if (!ENDPOINT || !PROJECT_ID || !BUCKET_ID || !API_KEY) {
  console.error('\nMissing credentials. Ensure .env.appwrite is filled in.\n');
  process.exit(1);
}

const client = new Client().setEndpoint(ENDPOINT).setProject(PROJECT_ID).setKey(API_KEY);
const databases = new Databases(client);
const storage   = new Storage(client);

const GALLERY_DIR  = path.join(root, 'public', 'gallery');
const IMAGE_EXTS   = /\.(jpg|jpeg|png|webp)$/i;

// Human-readable display names for existing location folders
const DISPLAY_NAMES = {
  jinja:      'Jinja',
  kampala:    'Kampala',
  gulu:       'Gulu',
  kabale:     'Kabale',
  kapchorwa:  'Kapchorwa',
  marchison:  'Murchison Falls',
  fortportal: 'Fort Portal',
};

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

async function fileExistsInStorage(fileId) {
  try { await storage.getFile(BUCKET_ID, fileId); return true; }
  catch { return false; }
}

async function seed() {
  console.log('\n── Seeding Appwrite ────────────────────────────────────\n');
  console.log(`  Endpoint  : ${ENDPOINT}`);
  console.log(`  Project   : ${PROJECT_ID}`);
  console.log(`  Bucket    : ${BUCKET_ID}`);
  console.log(`  Database  : ${DB_ID}\n`);

  const locationFolders = fs
    .readdirSync(GALLERY_DIR)
    .filter((f) => fs.statSync(path.join(GALLERY_DIR, f)).isDirectory())
    .sort();

  for (let locIdx = 0; locIdx < locationFolders.length; locIdx++) {
    const slug        = locationFolders[locIdx];
    const displayName = DISPLAY_NAMES[slug] || capitalize(slug);
    const locationDir = path.join(GALLERY_DIR, slug);

    console.log(`\n[${displayName}]`);

    // ── get or create location document ────────────────────────────────────
    let locationDoc;
    const existing = await databases.listDocuments(DB_ID, LOC_COL, [
      Query.equal('slug', slug),
    ]);

    if (existing.documents.length > 0) {
      locationDoc = existing.documents[0];
      console.log(`  → location doc exists (${locationDoc.$id})`);
    } else {
      locationDoc = await databases.createDocument(DB_ID, LOC_COL, ID.unique(), {
        name:  displayName,
        slug:  slug,
        order: locIdx + 1,
      });
      console.log(`  ✓ created location doc (${locationDoc.$id})`);
    }

    // ── upload image files + create image documents ─────────────────────────
    const files = fs
      .readdirSync(locationDir)
      .filter((f) => IMAGE_EXTS.test(f))
      .sort();

    for (let imgIdx = 0; imgIdx < files.length; imgIdx++) {
      const file     = files[imgIdx];
      const filePath = path.join(locationDir, file);
      const fileId   = `${slug}_${path.parse(file).name.replace(/[^a-zA-Z0-9]/g, '_')}`;

      // Upload to storage
      if (await fileExistsInStorage(fileId)) {
        console.log(`  → skip upload  ${slug}/${file}`);
      } else {
        await storage.createFile(BUCKET_ID, fileId, InputFile.fromPath(filePath, file));
        console.log(`  ↑ uploaded     ${slug}/${file} → ${fileId}`);
      }

      // Create image document
      const existingImg = await databases.listDocuments(DB_ID, IMG_COL, [
        Query.equal('fileId', fileId),
      ]);
      if (existingImg.documents.length === 0) {
        await databases.createDocument(DB_ID, IMG_COL, ID.unique(), {
          locationId: locationDoc.$id,
          fileId:     fileId,
          fileName:   file,
          order:      imgIdx + 1,
        });
        console.log(`  ✓ image doc    ${file}`);
      } else {
        console.log(`  → image doc exists  ${file}`);
      }
    }
  }

  console.log('\n── Seeding complete ────────────────────────────────────\n');
}

seed().catch((err) => {
  console.error('\nSeeding failed:', err.message);
  process.exit(1);
});
