/**
 * admin.js — Gallery Admin Panel
 * Manages locations and images via Appwrite Databases + Storage.
 * Requires Appwrite Web SDK loaded from CDN (window.Appwrite).
 */
(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────────────────────────
  var ENDPOINT  = window.APPWRITE_ENDPOINT;
  var PROJECT   = window.APPWRITE_PROJECT_ID;
  var BUCKET    = window.APPWRITE_BUCKET_ID;
  var DB        = window.APPWRITE_DATABASE_ID;
  var LOC_COL   = window.APPWRITE_LOCATIONS_COLLECTION_ID;
  var IMG_COL   = window.APPWRITE_IMAGES_COLLECTION_ID;

  var isPlaceholder = function (v) { return !v || v.charAt(0) === '%'; };

  if ([ENDPOINT, PROJECT, BUCKET, DB, LOC_COL, IMG_COL].some(isPlaceholder)) {
    document.body.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#777;font-family:sans-serif">' +
      '<p>Appwrite not configured. Set REACT_APP_APPWRITE_* env vars in .env.local and rebuild.</p></div>';
    return;
  }

  // ── SDK init ─────────────────────────────────────────────────────────────
  var _A = Appwrite;
  var client    = new _A.Client().setEndpoint(ENDPOINT).setProject(PROJECT);
  var account   = new _A.Account(client);
  var databases = new _A.Databases(client);
  var storage   = new _A.Storage(client);
  var Q         = _A.Query;
  var ID        = _A.ID;

  // ── State ─────────────────────────────────────────────────────────────────
  var currentLocationId   = null;
  var currentLocationName = '';
  var uploadQueue         = []; // { file, status, docId? }

  // ── DOM refs ──────────────────────────────────────────────────────────────
  var $ = function (id) { return document.getElementById(id); };
  var loginScreen      = $('login-screen');
  var app              = $('app');
  var loginForm        = $('login-form');
  var loginBtn         = $('login-btn');
  var loginError       = $('login-error');
  var locationsList    = $('locations-list');
  var emptyState       = $('empty-state');
  var locationDetail   = $('location-detail');
  var uploadPanel      = $('upload-panel');
  var detailTitle      = $('detail-title');
  var detailSub        = $('detail-sub');
  var imagesGrid       = $('images-grid');
  var uploadDrop       = $('upload-drop');
  var uploadFileInput  = $('upload-file-input');
  var uploadQueueEl    = $('upload-queue');
  var btnStartUpload   = $('btn-start-upload');
  var toast            = $('toast');

  // Modals
  var modalConfirm     = $('modal-confirm');
  var confirmTitle     = $('confirm-title');
  var confirmBody      = $('confirm-body');
  var confirmOk        = $('confirm-ok');
  var confirmCancel    = $('confirm-cancel');
  var modalAddLoc      = $('modal-add-loc');
  var newLocName       = $('new-loc-name');
  var addLocError      = $('add-loc-error');

  // ── Toast ─────────────────────────────────────────────────────────────────
  var toastTimer;
  function showToast(msg, isError) {
    clearTimeout(toastTimer);
    toast.textContent = msg;
    toast.className   = 'show' + (isError ? ' error' : '');
    toastTimer = setTimeout(function () { toast.className = ''; }, 3000);
  }

  // ── Confirm dialog ────────────────────────────────────────────────────────
  function confirm(title, body) {
    return new Promise(function (resolve) {
      confirmTitle.textContent = title;
      confirmBody.textContent  = body;
      modalConfirm.hidden      = false;
      function cleanup(result) {
        modalConfirm.hidden = true;
        confirmOk.removeEventListener('click', ok);
        confirmCancel.removeEventListener('click', cancel);
        resolve(result);
      }
      var ok     = function () { cleanup(true);  };
      var cancel = function () { cleanup(false); };
      confirmOk.addEventListener('click', ok);
      confirmCancel.addEventListener('click', cancel);
    });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  async function checkSession() {
    try {
      await account.get();
      showApp();
    } catch {
      showLogin();
    }
  }

  function showLogin() {
    loginScreen.hidden = false;
    app.hidden         = true;
  }

  function showApp() {
    loginScreen.hidden = true;
    app.hidden         = false;
    loadLocations();
  }

  loginForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    loginError.textContent = '';
    loginBtn.disabled      = true;
    loginBtn.textContent   = 'Signing in…';
    try {
      await account.createEmailPasswordSession($('email').value, $('password').value);
      showApp();
    } catch (err) {
      loginError.textContent = err.message || 'Login failed.';
    } finally {
      loginBtn.disabled    = false;
      loginBtn.textContent = 'Sign in';
    }
  });

  $('btn-logout').addEventListener('click', async function () {
    try { await account.deleteSession('current'); } catch {}
    showLogin();
  });

  // ── Locations ─────────────────────────────────────────────────────────────
  async function loadLocations() {
    try {
      var result = await databases.listDocuments(DB, LOC_COL, [Q.orderAsc('order'), Q.limit(100)]);
      renderLocationsList(result.documents);
    } catch (err) {
      showToast('Failed to load locations: ' + err.message, true);
    }
  }

  function renderLocationsList(locs) {
    locationsList.innerHTML = '';
    locs.forEach(function (loc) {
      var li = document.createElement('li');
      li.className = 'loc-item' + (loc.$id === currentLocationId ? ' active' : '');
      li.dataset.id   = loc.$id;
      li.dataset.name = loc.name;

      li.innerHTML =
        '<span class="loc-item-name">' + escHtml(loc.name) + '</span>' +
        '<span class="loc-actions">' +
          '<button class="btn btn-icon" data-action="rename" title="Rename">✎</button>' +
          '<button class="btn btn-icon danger" data-action="delete" title="Delete">✕</button>' +
        '</span>';

      li.addEventListener('click', function (e) {
        var action = e.target.closest('[data-action]');
        if (action) {
          e.stopPropagation();
          if (action.dataset.action === 'rename') startRename(li, loc);
          if (action.dataset.action === 'delete') deleteLocation(loc);
        } else {
          selectLocation(loc.$id, loc.name);
        }
      });

      locationsList.appendChild(li);
    });
  }

  function selectLocation(id, name) {
    currentLocationId   = id;
    currentLocationName = name;
    document.querySelectorAll('.loc-item').forEach(function (el) {
      el.classList.toggle('active', el.dataset.id === id);
    });
    showDetail();
    loadImages(id);
  }

  function showDetail() {
    emptyState.hidden    = true;
    locationDetail.hidden = false;
    uploadPanel.hidden   = true;
    detailTitle.textContent = currentLocationName;
    detailSub.textContent   = '';
    imagesGrid.innerHTML    = '';
  }

  // ── Add location ──────────────────────────────────────────────────────────
  $('btn-add-location').addEventListener('click', function () {
    newLocName.value       = '';
    addLocError.textContent = '';
    modalAddLoc.hidden     = false;
    setTimeout(function () { newLocName.focus(); }, 50);
  });

  $('add-loc-cancel').addEventListener('click', function () { modalAddLoc.hidden = true; });

  $('add-loc-ok').addEventListener('click', async function () {
    var name = newLocName.value.trim();
    if (!name) { addLocError.textContent = 'Name is required.'; return; }
    $('add-loc-ok').disabled = true;
    try {
      var result = await databases.listDocuments(DB, LOC_COL, [Q.orderDesc('order'), Q.limit(1)]);
      var nextOrder = result.documents.length > 0 ? result.documents[0].order + 1 : 1;
      var slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      await databases.createDocument(DB, LOC_COL, ID.unique(), {
        name:  name,
        slug:  slug,
        order: nextOrder,
      });
      modalAddLoc.hidden = true;
      showToast('Location "' + name + '" created.');
      await loadLocations();
    } catch (err) {
      addLocError.textContent = err.message;
    } finally {
      $('add-loc-ok').disabled = false;
    }
  });

  newLocName.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('add-loc-ok').click();
    if (e.key === 'Escape') $('add-loc-cancel').click();
  });

  // ── Rename location ───────────────────────────────────────────────────────
  function startRename(li, loc) {
    var nameSpan = li.querySelector('.loc-item-name');
    var input    = document.createElement('input');
    input.className = 'inline-edit';
    input.value     = loc.name;
    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    async function commit() {
      var newName = input.value.trim();
      if (!newName || newName === loc.name) { cancelRename(); return; }
      try {
        await databases.updateDocument(DB, LOC_COL, loc.$id, { name: newName });
        showToast('Renamed to "' + newName + '".');
        if (currentLocationId === loc.$id) {
          currentLocationName       = newName;
          detailTitle.textContent   = newName;
        }
        loadLocations();
      } catch (err) {
        showToast('Rename failed: ' + err.message, true);
        cancelRename();
      }
    }

    function cancelRename() {
      var span = document.createElement('span');
      span.className   = 'loc-item-name';
      span.textContent = loc.name;
      input.replaceWith(span);
    }

    input.addEventListener('blur',    commit);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter')  { input.removeEventListener('blur', commit); commit(); }
      if (e.key === 'Escape') { input.removeEventListener('blur', commit); cancelRename(); }
    });
  }

  // ── Delete location ───────────────────────────────────────────────────────
  async function deleteLocation(loc) {
    var ok = await confirm(
      'Delete "' + loc.name + '"?',
      'This will permanently delete the location and all its images. This cannot be undone.'
    );
    if (!ok) return;
    try {
      // Delete all images for this location
      var imgs = await databases.listDocuments(DB, IMG_COL, [Q.equal('locationId', loc.$id), Q.limit(200)]);
      for (var i = 0; i < imgs.documents.length; i++) {
        var img = imgs.documents[i];
        try { await storage.deleteFile(BUCKET, img.fileId); } catch {}
        await databases.deleteDocument(DB, IMG_COL, img.$id);
      }
      await databases.deleteDocument(DB, LOC_COL, loc.$id);
      showToast('"' + loc.name + '" deleted.');
      if (currentLocationId === loc.$id) {
        currentLocationId   = null;
        currentLocationName = '';
        emptyState.hidden    = false;
        locationDetail.hidden = true;
        uploadPanel.hidden   = true;
      }
      loadLocations();
    } catch (err) {
      showToast('Delete failed: ' + err.message, true);
    }
  }

  // ── Images ────────────────────────────────────────────────────────────────
  async function loadImages(locationId) {
    imagesGrid.innerHTML = '<p style="color:var(--muted);font-size:13px">Loading…</p>';
    try {
      var result = await databases.listDocuments(DB, IMG_COL, [
        Q.equal('locationId', locationId),
        Q.orderAsc('order'),
        Q.limit(200),
      ]);
      detailSub.textContent = result.documents.length + ' image' + (result.documents.length !== 1 ? 's' : '');
      renderImagesGrid(result.documents);
    } catch (err) {
      imagesGrid.innerHTML = '';
      showToast('Failed to load images: ' + err.message, true);
    }
  }

  function previewUrl(fileId) {
    return ENDPOINT + '/storage/buckets/' + BUCKET + '/files/' + fileId +
      '/preview?width=300&project=' + PROJECT;
  }

  function renderImagesGrid(images) {
    imagesGrid.innerHTML = '';
    if (images.length === 0) {
      imagesGrid.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:20px 0">No images yet. Upload some above.</p>';
      return;
    }
    images.forEach(function (img) {
      var card = document.createElement('div');
      card.className = 'img-card';

      var imgEl  = document.createElement('img');
      imgEl.src  = previewUrl(img.fileId);
      imgEl.alt  = img.fileName;
      imgEl.loading = 'lazy';

      var overlay = document.createElement('div');
      overlay.className = 'img-overlay';
      overlay.innerHTML = '<button class="btn btn-danger" data-imgid="' + img.$id + '" data-fileid="' + img.fileId + '">Delete</button>';
      overlay.querySelector('button').addEventListener('click', function () {
        deleteImage(img);
      });

      card.appendChild(imgEl);
      card.appendChild(overlay);
      imagesGrid.appendChild(card);
    });
  }

  async function deleteImage(img) {
    var ok = await confirm('Delete image?', '"' + img.fileName + '" will be permanently removed.');
    if (!ok) return;
    try {
      try { await storage.deleteFile(BUCKET, img.fileId); } catch {}
      await databases.deleteDocument(DB, IMG_COL, img.$id);
      showToast('Image deleted.');
      loadImages(currentLocationId);
    } catch (err) {
      showToast('Delete failed: ' + err.message, true);
    }
  }

  // ── Upload ────────────────────────────────────────────────────────────────
  $('btn-upload').addEventListener('click', function () {
    if (!currentLocationId) return;
    uploadQueue = [];
    uploadQueueEl.innerHTML   = '';
    uploadDrop.className      = 'upload-drop';
    btnStartUpload.disabled   = true;
    $('upload-panel-title').textContent = currentLocationName;
    locationDetail.hidden = true;
    uploadPanel.hidden    = false;
  });

  $('btn-cancel-upload').addEventListener('click', function () {
    uploadPanel.hidden    = false;  // keep hidden
    uploadPanel.hidden    = true;
    locationDetail.hidden = false;
  });

  // Click to open file picker
  uploadDrop.addEventListener('click', function () { uploadFileInput.click(); });

  uploadFileInput.addEventListener('change', function () {
    addFilesToQueue(Array.from(uploadFileInput.files));
    uploadFileInput.value = '';
  });

  // Drag & drop
  uploadDrop.addEventListener('dragover',  function (e) { e.preventDefault(); uploadDrop.classList.add('dragging'); });
  uploadDrop.addEventListener('dragleave', function ()  { uploadDrop.classList.remove('dragging'); });
  uploadDrop.addEventListener('drop', function (e) {
    e.preventDefault();
    uploadDrop.classList.remove('dragging');
    addFilesToQueue(Array.from(e.dataTransfer.files).filter(function (f) { return f.type.startsWith('image/'); }));
  });

  function addFilesToQueue(files) {
    files.forEach(function (file) {
      uploadQueue.push({ file: file, status: 'pending', li: null });
      var li = document.createElement('li');
      li.innerHTML =
        '<span class="q-name">' + escHtml(file.name) + '</span>' +
        '<span class="q-status">queued</span>';
      uploadQueueEl.appendChild(li);
      uploadQueue[uploadQueue.length - 1].li = li;
    });
    btnStartUpload.disabled = uploadQueue.length === 0;
  }

  btnStartUpload.addEventListener('click', async function () {
    btnStartUpload.disabled = true;
    $('btn-cancel-upload').disabled = true;

    // Get current max order for this location
    var existing = await databases.listDocuments(DB, IMG_COL, [
      Q.equal('locationId', currentLocationId),
      Q.orderDesc('order'),
      Q.limit(1),
    ]);
    var nextOrder = existing.documents.length > 0 ? existing.documents[0].order + 1 : 1;

    for (var i = 0; i < uploadQueue.length; i++) {
      var item    = uploadQueue[i];
      var statusEl = item.li.querySelector('.q-status');
      statusEl.className   = 'q-status active';
      statusEl.textContent = 'uploading…';

      try {
        // Upload file to Storage
        var uploaded = await storage.createFile(BUCKET, ID.unique(), item.file);
        // Create DB document
        await databases.createDocument(DB, IMG_COL, ID.unique(), {
          locationId: currentLocationId,
          fileId:     uploaded.$id,
          fileName:   item.file.name,
          order:      nextOrder++,
        });
        statusEl.className   = 'q-status done';
        statusEl.textContent = 'done ✓';
      } catch (err) {
        statusEl.className   = 'q-status error';
        statusEl.textContent = 'failed: ' + err.message;
      }
    }

    showToast('Upload complete.');
    $('btn-cancel-upload').disabled = false;

    // Go back to detail after short delay
    setTimeout(function () {
      uploadPanel.hidden    = true;
      locationDetail.hidden = false;
      loadImages(currentLocationId);
      uploadQueue = [];
      uploadQueueEl.innerHTML = '';
    }, 1200);
  });

  // ── Helpers ───────────────────────────────────────────────────────────────
  function escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  checkSession();

}());
