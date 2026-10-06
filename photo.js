/* ===== Sprout & Paw: photo compression =====
   Shrinks each photo before saving, so the diary loads fast and
   doesn't fill up the phone. Two copies are saved:
   - full:  for the full-screen viewer
   - thumb: small copy for the timeline
   Want sharper or smaller photos? Change the numbers below. */
(function (global) {
  'use strict';

  const FULL_MAX = 1280;   // longest side in pixels
  const FULL_QUALITY = 0.72;
  const THUMB_MAX = 480;
  const THUMB_QUALITY = 0.7;

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Unsupported image')); };
      img.src = url;
    });
  }

  function resize(img, maxSide, quality) {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // transparent PNGs get a white background
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h); // browsers apply the photo's rotation automatically

    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Compression failed')), 'image/jpeg', quality);
    });
  }

  // Returns { full: Blob, thumb: Blob }
  async function compress(file) {
    const { img, url } = await loadImage(file);
    try {
      const full = await resize(img, FULL_MAX, FULL_QUALITY);
      const thumb = await resize(img, THUMB_MAX, THUMB_QUALITY);
      return { full, thumb };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  global.Photo = { compress };
})(window);
