// Runs in the browser. Change it, then reload the preview.
const note = document.querySelector('#note');
if (note) note.textContent = `Served ${new Date().toLocaleTimeString()}: edit src/main.js, then reload.`;
