'use strict';

document.addEventListener('error', (event) => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement)) return;
  const fallback = image.dataset.fallbackSrc;
  if (fallback) {
    delete image.dataset.fallbackSrc;
    image.src = fallback;
  } else {
    image.remove();
  }
}, true);
