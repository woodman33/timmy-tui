// Timmy Illustrator starter: edit.jsx (ExtendScript, ES3).
// Run it from Timmy:  /illustrator edit out/illustrator/badge-v1.ai edit.jsx
// Timmy's harness has opened the document and at once saved it as its next version (out/illustrator/badge-v2.ai): the
// document you named is never written. This script changes the label to "TIMMY 2" and adds a thinner ring inside the
// first. It finds the badge's parts by the names badge.jsx gave them.
(function () {
  var doc = TIMMY.document;
  function named(items, name) {
    for (var i = 0; i < items.length; i++) if (items[i].name === name) return items[i];
    throw new Error('no item named ' + name + ': edit.jsx changes a badge that badge.jsx drew');
  }

  var label = named(doc.textFrames, 'Label');
  label.contents = 'TIMMY 2';

  var ring = named(doc.pathItems, 'Ring');
  var b = ring.geometricBounds; // left, top, right, bottom (y grows upward)
  var inner = ring.layer.pathItems.ellipse(b[1] - 14, b[0] + 14, (b[2] - b[0]) - 28, (b[1] - b[3]) - 28);
  inner.name = 'Inner ring';
  inner.filled = false;
  inner.stroked = true;
  inner.strokeColor = ring.strokeColor;
  inner.strokeWidth = 2;
}());
