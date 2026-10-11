// Timmy Illustrator starter: badge.jsx (ExtendScript, which is ES3: var, no let/const or arrow functions).
// Run it from Timmy:  /illustrator author badge.jsx --name badge
// Timmy's harness has already made a new, empty RGB document and saved it as out/illustrator/<name>-v<N>.ai; that
// document is TIMMY.document here. After this script the harness saves it again, exports SVG, PDF and PNG beside it,
// reads it back into the run's result file and closes it. This script only draws, on one artboard of 600 x 400 pt:
//   Badge   a charcoal rectangle with a green border, the badge's ground
//   Ring    a circle, outlined in green
//   Spark   a five-pointed star inside the ring
//   Rule    a line under the ring
//   Label   one point text, "TIMMY", centred under the rule
// Positions are taken from the artboard's own top left corner, so the script works in either of Illustrator's
// coordinate systems. The colours are Timmy Homebrew's (src/theme/tokens.ts): charcoal, off-white and green.
(function () {
  var doc = TIMMY.document;
  var W = 600;
  var H = 400;

  // One artboard of W x H, its top left corner kept where it is. In Illustrator's scripting y grows upward: down is minus.
  var board = doc.artboards[0];
  var r = board.artboardRect;
  var L = r[0];
  var T = r[1];
  board.artboardRect = [L, T, L + W, T - H];
  board.name = 'Badge';

  function rgb(red, green, blue) {
    var c = new RGBColor();
    c.red = red;
    c.green = green;
    c.blue = blue;
    return c;
  }
  var CHARCOAL = rgb(18, 18, 18); // Homebrew surface, #121212
  var OFFWHITE = rgb(232, 230, 225); // Homebrew text, #E8E6E1
  var GREEN = rgb(40, 254, 20); // Homebrew accent, #28FE14

  var layer = doc.layers[0];
  layer.name = 'Badge';

  // rectangle(top, left, width, height)
  var ground = layer.pathItems.rectangle(T - 20, L + 20, W - 40, H - 40);
  ground.name = 'Badge';
  ground.filled = true;
  ground.fillColor = CHARCOAL;
  ground.stroked = true;
  ground.strokeColor = GREEN;
  ground.strokeWidth = 4;

  // ellipse(top, left, width, height): a circle 180 pt across, centred 150 pt below the top
  var ring = layer.pathItems.ellipse(T - 60, L + W / 2 - 90, 180, 180);
  ring.name = 'Ring';
  ring.filled = false;
  ring.stroked = true;
  ring.strokeColor = GREEN;
  ring.strokeWidth = 6;

  // star(centre x, centre y, radius, inner radius, points)
  var spark = layer.pathItems.star(L + W / 2, T - 150, 60, 24, 5);
  spark.name = 'Spark';
  spark.filled = true;
  spark.fillColor = GREEN;
  spark.stroked = false;

  var rule = layer.pathItems.add();
  rule.setEntirePath([[L + 140, T - 270], [L + W - 140, T - 270]]);
  rule.name = 'Rule';
  rule.closed = false;
  rule.filled = false;
  rule.stroked = true;
  rule.strokeColor = OFFWHITE;
  rule.strokeWidth = 2;

  // A point text anchored at its baseline; centred on the anchor.
  var label = layer.textFrames.pointText([L + W / 2, T - 330]);
  label.name = 'Label';
  label.contents = 'TIMMY';
  label.textRange.characterAttributes.size = 48;
  label.textRange.characterAttributes.fillColor = OFFWHITE;
  label.paragraphs[0].paragraphAttributes.justification = Justification.CENTER;
}());
