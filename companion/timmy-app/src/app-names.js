// The unified Workspace order (2026-10-27): the names William chose for the hosted apps. Display words only: each app's
// stable id (card-lab, film-room, model-studio, stream-studio, animate), its URLs, its data folders and its receipts' `app`
// field are unchanged, so saved projects, links and receipts keep working. "Card Lab" stays in source and design references.
export const APP_NAMES = Object.freeze({
  'card-lab': 'Image Analysis',
  'film-room': 'Video Breakdown',
  'model-studio': '3D Model Studio',
  'stream-studio': 'Stream Studio',
  animate: 'Animate',
  // not hosted apps: the spatial tools Timmy runs as its own jobs (src/spatial/jobs.ts), and a file brought in from this computer
  spatial: 'Spatial tools',
  import: 'This computer',
});
/** Whether an id is a hosted app that can be opened (and its editable source reopened) in its own page. */
export const isHostedApp = (id) => ['card-lab', 'film-room', 'model-studio', 'stream-studio', 'animate'].includes(id);
/** An app's display name from its stable id (an unknown id is shown as it is). */
export const appName = (id) => APP_NAMES[id] || id;
