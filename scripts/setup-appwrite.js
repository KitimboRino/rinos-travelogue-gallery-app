/**
 * setup-appwrite.js
 * One-time script that creates the Appwrite database, collections, attributes,
 * and indexes needed for the dynamic gallery.
 *
 * Usage:
 *   1. Fill in .env.appwrite (copy .env.appwrite.example)
 *   2. npm run setup-appwrite
 */

const { Client, Databases, Storage, Permission, Role, ID } = require('node-appwrite');
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
  } catch {
    // File missing — that's fine, use system env vars
  }
}

const root = path.join(__dirname, '..');
loadEnvFile(path.join(root, '.env.appwrite'));
loadEnvFile(path.join(root, '.env.local'));

const ENDPOINT = process.env.APPWRITE_ENDPOINT;
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
const BUCKET_ID = process.env.APPWRITE_BUCKET_ID;
const API_KEY = process.env.APPWRITE_API_KEY;

if (!ENDPOINT || !PROJECT_ID || !API_KEY) {
  console.error('\nMissing required env vars: APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY\n');
  process.exit(1);
}

const client = new Client().setEndpoint(ENDPOINT).setProject(PROJECT_ID).setKey(API_KEY);
const databases = new Databases(client);
const storage = new Storage(client);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryCreate(label, fn) {
  try {
    const result = await fn();
    console.log(`  ✓  ${label}`);
    return result;
  } catch (err) {
    if (err.code === 409) {
      console.log(`  →  ${label} (already exists)`);
      return null;
    }
    throw err;
  }
}

async function setup() {
  console.log('\n── Appwrite Gallery Setup ──────────────────────────────\n');

  // Database
  await tryCreate('database: gallery', () =>
    databases.create('gallery', 'Gallery')
  );

  // ── locations collection ──────────────────────────────────────────────────
  await tryCreate('collection: locations', () =>
    databases.createCollection('gallery', 'locations', 'Locations', [
      Permission.read(Role.any()),
      Permission.create(Role.users()),
      Permission.update(Role.users()),
      Permission.delete(Role.users()),
    ])
  );
  await sleep(500);
  await tryCreate('attribute: locations.name',  () => databases.createStringAttribute( 'gallery', 'locations', 'name',  100, true));
  await tryCreate('attribute: locations.slug',  () => databases.createStringAttribute( 'gallery', 'locations', 'slug',  100, true));
  await tryCreate('attribute: locations.order', () => databases.createIntegerAttribute('gallery', 'locations', 'order', true, 0));
  await sleep(1500); // Appwrite needs a moment before index creation
  await tryCreate('index: locations.order', () =>
    databases.createIndex('gallery', 'locations', 'idx_order', 'key', ['order'], ['ASC'])
  );

  // ── images collection ─────────────────────────────────────────────────────
  await tryCreate('collection: images', () =>
    databases.createCollection('gallery', 'images', 'Images', [
      Permission.read(Role.any()),
      Permission.create(Role.users()),
      Permission.update(Role.users()),
      Permission.delete(Role.users()),
    ])
  );
  await sleep(500);
  await tryCreate('attribute: images.locationId', () => databases.createStringAttribute( 'gallery', 'images', 'locationId', 100, true));
  await tryCreate('attribute: images.fileId',     () => databases.createStringAttribute( 'gallery', 'images', 'fileId',     100, true));
  await tryCreate('attribute: images.fileName',   () => databases.createStringAttribute( 'gallery', 'images', 'fileName',   200, true));
  await tryCreate('attribute: images.order',      () => databases.createIntegerAttribute('gallery', 'images', 'order',      true, 0));
  await sleep(1500);
  await tryCreate('index: images.locationId+order', () =>
    databases.createIndex('gallery', 'images', 'idx_loc_order', 'key', ['locationId', 'order'], ['ASC', 'ASC'])
  );

  // ── storage bucket permissions ────────────────────────────────────────────
  if (BUCKET_ID) {
    try {
      await storage.updateBucket(BUCKET_ID, 'Gallery Images', [
        Permission.read(Role.any()),
        Permission.create(Role.users()),
        Permission.update(Role.users()),
        Permission.delete(Role.users()),
      ]);
      console.log(`  ✓  bucket permissions updated: ${BUCKET_ID}`);
    } catch (err) {
      console.warn(`  ⚠  Could not update bucket permissions: ${err.message}`);
    }
  }

  console.log('\n── Setup complete ──────────────────────────────────────');
  console.log('\nAdd these vars to both .env.appwrite and .env.local:\n');
  console.log('  APPWRITE_DATABASE_ID=gallery');
  console.log('  APPWRITE_LOCATIONS_COLLECTION_ID=locations');
  console.log('  APPWRITE_IMAGES_COLLECTION_ID=images');
  console.log('  REACT_APP_APPWRITE_DATABASE_ID=gallery');
  console.log('  REACT_APP_APPWRITE_LOCATIONS_COLLECTION_ID=locations');
  console.log('  REACT_APP_APPWRITE_IMAGES_COLLECTION_ID=images\n');
  console.log('Then run: npm run seed-appwrite\n');
}

setup().catch((err) => {
  console.error('\nSetup failed:', err.message);
  process.exit(1);
});
