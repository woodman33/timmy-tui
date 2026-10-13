// Timmy After Effects starter: edit.jsx (ExtendScript, ES3).
// Run it from Timmy on a project author.jsx made:  /ae edit out/ae/promo-v1.aep edit.jsx
// Timmy's harness has opened that project and at once saved it as the next version (out/ae/promo-v2.aep), so
// whatever this script saves lands in the new version and the project given stays as it was. This script:
//   changes the Title layer's text in the comp Main
//   adds a layer, Subtitle, a smaller text layer under the title
(function () {
  var comp = null;
  for (var i = 1; i <= app.project.numItems; i++) {
    var item = app.project.item(i);
    if (item instanceof CompItem && item.name === 'Main') {
      comp = item;
      break;
    }
  }
  if (!comp) throw new Error('edit.jsx looks for a comp named Main (the one author.jsx makes) and found none');

  var title = comp.layer('Title');
  if (!title) throw new Error('edit.jsx looks for a layer named Title in Main and found none');
  var source = title.property('ADBE Text Properties').property('ADBE Text Document');
  var doc = source.value;
  doc.text = 'Title, edited';
  source.setValue(doc);

  var subtitle = comp.layers.addText('Subtitle');
  subtitle.name = 'Subtitle';
  var subSource = subtitle.property('ADBE Text Properties').property('ADBE Text Document');
  var subDoc = subSource.value;
  subDoc.fontSize = 48;
  subDoc.applyFill = true;
  subDoc.fillColor = [0.6, 0.85, 0.65];
  subDoc.justification = ParagraphJustification.CENTER_JUSTIFY;
  subSource.setValue(subDoc);
  subtitle.property('ADBE Transform Group').property('ADBE Position').setValue([comp.width / 2, comp.height / 2 + 40]);
}());
