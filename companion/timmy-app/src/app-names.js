// The unified Workspace order (2026-10-27): the names William chose for the hosted apps. Display words only: each app's
// stable id (card-lab, film-room, model-studio, stream-studio, animate), its URLs, its data folders and its receipts' `app`
// field are unchanged, so saved projects, links and receipts keep working. "Card Lab" stays in source and design references.
export const APP_NAMES = Object.freeze({
  'card-lab': 'Image Analysis',
  'film-room': 'Video Breakdown',
  'model-studio': '3D Model Studio',
  'stream-studio': 'Stream Studio',
  animate: 'Animate',
});
/** An app's display name from its stable id (an unknown id is shown as it is). */
export const appName = (id) => APP_NAMES[id] || id;
