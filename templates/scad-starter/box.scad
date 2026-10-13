// Timmy starter: a parametric box with a lid (OpenSCAD).
//
// Run it from Timmy:   /scad box.scad                          the values in box.params.json
//                      /scad box.scad width=80 part="lid" --png
// Each value below is a parameter. box.params.json beside this file sets them for /scad, and
// name=value words given to /scad override that file. Lengths are millimetres by OpenSCAD's
// convention (an STL records no unit).

/* [Size] */
// outer width of the box (x)
width = 60;
// outer depth of the box (y)
depth = 40;
// outer height of the box, without its lid (z)
height = 30;
// wall and floor thickness
wall = 2;
// radius of the outside corners (0: square corners)
corner = 3;

/* [Lid] */
// thickness of the lid's top plate
lid_thickness = 2;
// how far the lid's lip reaches down into the box
lip_depth = 4;
// clearance between the lip and the box's inner wall, on each side
lid_gap = 0.3;

/* [Layout] */
// which part to make: "box", "lid" or "both" (side by side, the lid upside down, ready to print)
part = "both";
// space between the two parts when both are made
spacing = 10;

/* [Hidden] */
$fn = 48;

// A slab of size [x, y, z] from the origin, its vertical edges rounded with radius r.
module slab(size, r) {
  if (r <= 0) {
    cube(size);
  } else {
    hull() {
      for (x = [r, size[0] - r], y = [r, size[1] - r])
        translate([x, y, 0]) cylinder(r = r, h = size[2]);
    }
  }
}

// The box: an open-topped shell with walls and a floor of thickness `wall`.
module box() {
  difference() {
    slab([width, depth, height], corner);
    translate([wall, wall, wall])
      slab([width - 2 * wall, depth - 2 * wall, height], max(corner - wall, 0));
  }
}

// The lid: a plate the size of the box, with a hollow lip that drops into the box with
// `lid_gap` of clearance on every side. Made upside down: the plate on the bed, the lip up.
module lid() {
  lip_w = width - 2 * wall - 2 * lid_gap;
  lip_d = depth - 2 * wall - 2 * lid_gap;
  lip_r = max(corner - wall - lid_gap, 0);
  union() {
    slab([width, depth, lid_thickness], corner);
    translate([wall + lid_gap, wall + lid_gap, lid_thickness])
      difference() {
        slab([lip_w, lip_d, lip_depth], lip_r);
        translate([wall, wall, -1])
          slab([lip_w - 2 * wall, lip_d - 2 * wall, lip_depth + 2], max(lip_r - wall, 0));
      }
  }
}

assert(wall > 0 && lid_gap >= 0 && lid_thickness > 0 && lip_depth > 0, "wall, lid_thickness and lip_depth must be above 0, lid_gap 0 or more");
assert(width > 4 * wall + 2 * lid_gap && depth > 4 * wall + 2 * lid_gap, "the box is too small for its walls and the lid's lip");
assert(corner >= 0 && 2 * corner < min(width, depth), "corner must be 0 or more and less than half the smaller side");
assert(part == "box" || part == "lid" || part == "both", "part is \"box\", \"lid\" or \"both\"");

if (part == "box" || part == "both") box();
if (part == "lid") lid();
if (part == "both") translate([width + spacing, 0, 0]) lid();
