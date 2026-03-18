/**
 * seed-appwrite.ts
 * Migrates existing /public/gallery/ images into Appwrite Storage + Database.
 * Idempotent — already-uploaded files and documents are skipped.
 *
 * Usage:
 *   1. Run npm run setup-appwrite first
 *   2. npm run seed-appwrite
 */

import { Client, Databases, Storage, ID, Query } from 'node-appwrite';
import { InputFile } from 'node-appwrite/file';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONCURRENCY = 5; // max parallel image uploads per location

function loadEnvFile(filePath: string): void {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {}
}

const root = path.join(__dirname, '..');
loadEnvFile(path.join(root, '.env.appwrite'));
loadEnvFile(path.join(root, '.env.local'));

const ENDPOINT   = process.env.APPWRITE_ENDPOINT;
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
const BUCKET_ID  = process.env.APPWRITE_BUCKET_ID;
const API_KEY    = process.env.APPWRITE_API_KEY;
const DB_ID      = process.env.APPWRITE_DATABASE_ID               ?? 'gallery';
const LOC_COL    = process.env.APPWRITE_LOCATIONS_COLLECTION_ID   ?? 'locations';
const IMG_COL    = process.env.APPWRITE_IMAGES_COLLECTION_ID      ?? 'images';

if (!ENDPOINT || !PROJECT_ID || !BUCKET_ID || !API_KEY) {
  console.error('\nMissing credentials. Ensure .env.appwrite is filled in.\n');
  process.exit(1);
}

const client    = new Client().setEndpoint(ENDPOINT).setProject(PROJECT_ID).setKey(API_KEY);
const databases = new Databases(client);
const storage   = new Storage(client);

const GALLERY_DIR = path.join(root, 'public', 'gallery');
const IMAGE_EXTS  = /\.(jpg|jpeg|png|webp)$/i;

const DISPLAY_NAMES: Record<string, string> = {
  jinja:      'Jinja',
  kampala:    'Kampala',
  gulu:       'Gulu',
  kabale:     'Kabale',
  kapchorwa:  'Kapchorwa',
  marchison:  'Murchison Falls',
  fortportal: 'Fort Portal',
};

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Runs tasks with at most `limit` in-flight at once. */
async function runConcurrent<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < tasks.length; i += limit) {
    const batch = await Promise.all(tasks.slice(i, i + limit).map((t) => t()));
    results.push(...batch);
  }
  return results;
}

/** Returns the full set of file IDs already in the bucket (handles pagination). */
async function fetchStorageFileIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | undefined;

  do {
    const queries: string[] = [Query.limit(100)];
    if (cursor) queries.push(Query.cursorAfter(cursor));

    const page = await storage.listFiles(BUCKET_ID!, queries);
    for (const f of page.files) ids.add(f.$id);

    cursor =
      page.files.length === 100
        ? page.files[page.files.length - 1].$id
        : undefined;
  } while (cursor);

  return ids;
}

/** Returns the set of fileIds already stored as image documents for a location. */
async function fetchExistingImageFileIds(locationDocId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | undefined;

  do {
    const queries: string[] = [
      Query.equal('locationId', locationDocId),
      Query.limit(100),
    ];
    if (cursor) queries.push(Query.cursorAfter(cursor));

    const page = await databases.listDocuments(DB_ID, IMG_COL, queries);
    for (const doc of page.documents) ids.add(doc.fileId as string);

    cursor =
      page.documents.length === 100
        ? page.documents[page.documents.length - 1].$id
        : undefined;
  } while (cursor);

  return ids;
}

// ---------------------------------------------------------------------------
// Per-location seeding
// ---------------------------------------------------------------------------
async function seedLocation(
  slug: string,
  locIdx: number,
  uploadedIds: Set<string>,
): Promise<void> {
  const displayName = DISPLAY_NAMES[slug] ?? capitalize(slug);
  const locationDir = path.join(GALLERY_DIR, slug);

  // ── get or create location document ──────────────────────────────────────
  const existing = await databases.listDocuments(DB_ID, LOC_COL, [
    Query.equal('slug', slug),
  ]);

  let locationDocId: string;
  if (existing.documents.length > 0) {
    locationDocId = existing.documents[0].$id;
    console.log(`[${displayName}]  → location doc exists (${locationDocId})`);
  } else {
    const created = await databases.createDocument(DB_ID, LOC_COL, ID.unique(), {
      name:  displayName,
      slug,
      order: locIdx + 1,
    });
    locationDocId = created.$id;
    console.log(`[${displayName}]  ✓ created location doc (${locationDocId})`);
  }

  // ── batch-fetch existing image docs for this location (one round-trip) ───
  const existingImgFileIds = await fetchExistingImageFileIds(locationDocId);

  // ── collect image files ───────────────────────────────────────────────────
  const files = fs
    .readdirSync(locationDir)
    .filter((f) => IMAGE_EXTS.test(f))
    .sort();

  // ── process images with bounded concurrency ───────────────────────────────
  const tasks = files.map((file, imgIdx) => async () => {
    const filePath = path.join(locationDir, file);
    const fileId   = `${slug}_${path.parse(file).name.replace(/[^a-zA-Z0-9]/g, '_')}`;

    // Upload to storage
    if (uploadedIds.has(fileId)) {
      console.log(`  [${displayName}] → skip upload  ${slug}/${file}`);
    } else {
      await storage.createFile(BUCKET_ID!, fileId, InputFile.fromPath(filePath, file));
      uploadedIds.add(fileId); // mark so sibling tasks don't double-upload
      console.log(`  [${displayName}] ↑ uploaded     ${slug}/${file} → ${fileId}`);
    }

    // Create image document if missing
    if (!existingImgFileIds.has(fileId)) {
      await databases.createDocument(DB_ID, IMG_COL, ID.unique(), {
        locationId: locationDocId,
        fileId,
        fileName:   file,
        order:      imgIdx + 1,
      });
      console.log(`  [${displayName}] ✓ image doc    ${file}`);
    } else {
      console.log(`  [${displayName}] → image doc exists  ${file}`);
    }
  });

  await runConcurrent(tasks, CONCURRENCY);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function seed(): Promise<void> {
  console.log('\n── Seeding Appwrite ────────────────────────────────────\n');
  console.log(`  Endpoint  : ${ENDPOINT}`);
  console.log(`  Project   : ${PROJECT_ID}`);
  console.log(`  Bucket    : ${BUCKET_ID}`);
  console.log(`  Database  : ${DB_ID}\n`);

  // Pre-fetch all storage file IDs once (avoids N individual getFile calls)
  console.log('  Fetching existing storage files…');
  const uploadedIds = await fetchStorageFileIds();
  console.log(`  Found ${uploadedIds.size} file(s) already in bucket.\n`);

  const locationFolders = fs
    .readdirSync(GALLERY_DIR)
    .filter((f) => fs.statSync(path.join(GALLERY_DIR, f)).isDirectory())
    .sort();

  // Process all locations in parallel (they are fully independent)
  await Promise.all(locationFolders.map((slug, locIdx) =>
    seedLocation(slug, locIdx, uploadedIds),
  ));

  console.log('\n── Seeding complete ────────────────────────────────────\n');
}

seed().catch((err: Error) => {
  console.error('\nSeeding failed:', err.message);
  process.exit(1);
});
