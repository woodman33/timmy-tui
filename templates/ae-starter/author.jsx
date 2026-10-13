// Timmy After Effects starter: author.jsx (ExtendScript, which is ES3: var, no let/const or arrow functions).
// Run it from Timmy:  /ae author author.jsx --name promo
// Timmy's harness has already made a new, empty project and saved it as out/ae/<name>-v<N>.aep. After this
// script it saves the project again and reads its comps back into the run's result file. This script only builds:
//   Main        a 1920x1080, 30 fps, 10 second comp
//   Background  a dark solid filling the frame
//   Title       a text layer, centred
//   Mover       a small solid that crosses the frame between two Position keyframes (0 s and 2 s)
// Properties are found by match name (ADBE ...), so the script works in any language After Effects runs in.
(function () {
  var W = 1920;
  var H = 1080;
  var FPS = 30;
  var SECONDS = 10;

  var comp = app.project.items.addComp('Main', W, H, 1, SECONDS, FPS);

  // New layers go on top: add from the bottom of the stack up.
  comp.layers.addSolid([0.07, 0.07, 0.08], 'Background', W, H, 1);

  var title = comp.layers.addText('Title');
  title.name = 'Title';
  var source = title.property('ADBE Text Properties').property('ADBE Text Document');
  var doc = source.value;
  doc.fontSize = 120;
  doc.applyFill = true;
  doc.fillColor = [0.93, 0.93, 0.9];
  doc.justification = ParagraphJustification.CENTER_JUSTIFY;
  source.setValue(doc);
  title.property('ADBE Transform Group').property('ADBE Position').setValue([W / 2, H / 2 - 80]);

  var mover = comp.layers.addSolid([0.2, 0.75, 0.4], 'Mover', 160, 160, 1);
  var position = mover.property('ADBE Transform Group').property('ADBE Position');
  position.setValueAtTime(0, [240, H / 2 + 220]);
  position.setValueAtTime(2, [W - 240, H / 2 + 220]);

  if (comp.openInViewer) comp.openInViewer();
}());
