/* ===== Sprout & Paw: storage =====
   Saves diaries, days, and photos on the phone using IndexedDB
   (localStorage is too small for photos). Nothing is uploaded anywhere.

   diaries store: { id, category: "plant" | "animal", name, created }
   entries store: { id: "<diaryId>:2026-10-04", diaryId, category, date, note, photoIds: [...] }
   photos store:  { id, thumb: Blob, full: Blob } */
(function (global) {
  'use strict';

  const DB_NAME = 'sprout-and-paw';
  const DB_VERSION = 2; // v2 added the diaries store
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        ['diaries', 'entries', 'photos'].forEach(name => {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function done(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAll(store) {
    const db = await open();
    return done(db.transaction(store).objectStore(store).getAll());
  }

  const getDiaries = () => getAll('diaries');
  const getEntries = () => getAll('entries');

  async function getPhoto(id) {
    const db = await open();
    return done(db.transaction('photos').objectStore('photos').get(id));
  }

  // One safe write: everything succeeds together or nothing changes.
  // { putDiaries, deleteDiaryIds, putEntries, deleteEntryIds, putPhotos, deletePhotoIds }
  // Deletes run before puts, so an entry can be moved to a new id.
  async function write(change) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['diaries', 'entries', 'photos'], 'readwrite');
      const s = { diaries: tx.objectStore('diaries'), entries: tx.objectStore('entries'), photos: tx.objectStore('photos') };

      (change.deleteDiaryIds || []).forEach(id => s.diaries.delete(id));
      (change.deleteEntryIds || []).forEach(id => s.entries.delete(id));
      (change.deletePhotoIds || []).forEach(id => s.photos.delete(id));
      (change.putDiaries || []).forEach(d => s.diaries.put(d));
      (change.putEntries || []).forEach(e => s.entries.put(e));
      (change.putPhotos || []).forEach(p => s.photos.put(p));

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Save cancelled'));
    });
  }

  global.DB = { getDiaries, getEntries, getPhoto, write };
})(window);
