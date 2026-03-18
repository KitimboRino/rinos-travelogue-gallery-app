/**
 * appwrite-gallery.js
 * If Appwrite is configured, fetches locations + images from Appwrite Databases,
 * builds the gallery DOM (grids + menu items) dynamically, and resolves
 * window.__galleryReady so that demo.js can initialise after the DOM is ready.
 *
 * Falls back silently to the static HTML when Appwrite is not configured or
 * when a network error occurs.
 *
 * Depends on: Appwrite Web SDK loaded from CDN before this script.
 */
window.__galleryReady = (function () {
  return new Promise(function (resolve) {
    var endpoint  = window.APPWRITE_ENDPOINT;
    var projectId = window.APPWRITE_PROJECT_ID;
    var bucketId  = window.APPWRITE_BUCKET_ID;
    var dbId      = window.APPWRITE_DATABASE_ID;
    var locCol    = window.APPWRITE_LOCATIONS_COLLECTION_ID;
    var imgCol    = window.APPWRITE_IMAGES_COLLECTION_ID;

    function isPlaceholder(v) { return !v || v.charAt(0) === '%'; }

    if (
      isPlaceholder(endpoint)  || isPlaceholder(projectId) ||
      isPlaceholder(bucketId)  || isPlaceholder(dbId)      ||
      isPlaceholder(locCol)    || isPlaceholder(imgCol)
    ) {
      resolve(); // use static HTML as-is
      return;
    }

    var _Client    = Appwrite.Client;
    var _Databases = Appwrite.Databases;
    var _Query     = Appwrite.Query;

    var client    = new _Client().setEndpoint(endpoint).setProject(projectId);
    var databases = new _Databases(client);

    function fileViewUrl(fileId) {
      return (
        endpoint +
        '/storage/buckets/' + bucketId +
        '/files/' + fileId +
        '/view?project=' + projectId
      );
    }

    async function build() {
      // Fetch all locations ordered by their order field
      var locResult = await databases.listDocuments(dbId, locCol, [
        _Query.orderAsc('order'),
        _Query.limit(100),
      ]);
      var locs = locResult.documents;
      if (locs.length === 0) { resolve(); return; }

      // Fetch images for every location in parallel
      var imgResults = await Promise.all(
        locs.map(function (loc) {
          return databases.listDocuments(dbId, imgCol, [
            _Query.equal('locationId', loc.$id),
            _Query.orderAsc('order'),
            _Query.limit(200),
          ]);
        })
      );

      // ── Build DOM ──────────────────────────────────────────────────────────
      var gridWrap = document.querySelector('.grid-wrap');
      var menuEl   = document.querySelector('.menu');
      var backBtn  = document.querySelector('.gridback');

      // Remove static grids and menu items
      Array.from(gridWrap.querySelectorAll('.grid')).forEach(function (el) { el.remove(); });
      Array.from(menuEl.querySelectorAll('.menu__item')).forEach(function (el) { el.remove(); });

      var LAYOUT_COUNT = 7;

      locs.forEach(function (loc, idx) {
        var images    = imgResults[idx].documents;
        var layoutNum = (idx % LAYOUT_COUNT) + 1;

        // Grid
        var grid = document.createElement('div');
        grid.className = 'grid grid--layout-' + layoutNum;

        images.forEach(function (img) {
          var wrap = document.createElement('div');
          wrap.className = 'grid__item-wrap';
          var item = document.createElement('div');
          item.className = 'grid__item';
          item.dataset.bg = fileViewUrl(img.fileId);
          wrap.appendChild(item);
          grid.appendChild(wrap);
        });

        gridWrap.insertBefore(grid, backBtn);

        // Menu item
        var mi = document.createElement('div');
        mi.className = 'menu__item';
        mi.innerHTML =
          '<a class="menu__item-link">' + loc.name + '</a>' +
          '<a class="menu__item-explore">explore</a>';
        menuEl.appendChild(mi);
      });

      resolve();
    }

    build().catch(function (err) {
      console.warn('[appwrite-gallery] Failed to load from Appwrite — using static HTML.', err);
      resolve();
    });
  });
}());
