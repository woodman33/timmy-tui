# First seal

How to take one box from the packing table to a buyer's hands so that every
step leaves a receipt nobody can quietly change. Written for the person doing
it, not the person who built it. If a step needs a computer, the exact thing
to type is shown. If it needs hands, it says where to put them.

The whole thing, in one line: **write down what is inside, seal the box with a
sticker that can tell when it has been lifted, and tap the sticker at every
handover.** The taps write the history. The sticker makes the history true.

---

## 1. What to buy

| Item | What to ask for | Why this one |
|---|---|---|
| Stickers | **NTAG 424 DNA TagTamper** NFC labels, 7-byte UID, on a paper or PET face you can print on | Two things in one: a chip that proves itself with a fresh code every tap, and a conductive loop in the label that the chip watches. Cut the loop and every later tap says so, forever. Plain "NTAG 424 DNA" has the chip but no loop: fine for the bench, not for a box. |
| Reader | **ACR122U** USB NFC reader | Cheap, everywhere, and what the programming tool speaks to. |
| A Mac | Any with USB, on the tailnet | It runs the programming tool. No drivers to install. |
| Phones | Any iPhone (XS or newer) or Android with NFC | The taps. Nothing to install; the sticker opens a web page. |
| Boxes | Whatever ships, as long as the lid has one seam a sticker can cross | The sticker must sit **across** the place the box opens. |
| Printer | A label printer if you want the serial on the face; optional | The chip carries the identity. Printing is for people. |

Buy ten stickers more than you need. Some will be spent proving the process.

*[photo: the stickers, the reader and a box on the table]*

---

## 2. Before the first box: program the stickers

Stickers arrive blank, with factory keys everyone in the world knows. The
programming tool writes our address into each one, turns on the part that
makes each tap unique, and replaces the factory keys with keys that exist for
that one sticker only.

Plug in the reader. In a terminal on the Mac, in the repo:

```
timmy nfc selftest
```

That runs the checks that do not need a sticker. All green, or stop and ask.

Then, for a batch called `paradise-001` of ten stickers:

```
timmy nfc program --batch paradise-001 --count 10 --serial-start VC0100
```

The tool asks for one sticker at a time. Lay a sticker flat on the reader,
wait for the line that says `sealed`, lift it off, mark it with its serial
(VC0100, VC0101, …) in pencil on the backing, and lay the next one down.

What the tool refuses to do, on purpose:

- program a production batch when the batch keys are missing or are the
  factory zeros. It stops before it touches a sticker. Keys are set up once
  per batch by whoever holds them; see `lanes/nfc/README.md`.
- seal a receipt for a sticker it could not read back and verify. That sticker
  is set aside by its UID and does not go on a box.
- program a plain sticker as a TagTamper one, or the reverse.

Program **one** sticker first, tap it with a phone, and see the page open
before doing the other nine.

*[photo: sticker on the reader, terminal showing "read-back verified"]*

### If TagTamper stock is late

Use plain NTAG 424 DNA stickers on the bench to learn the flow:

```
timmy nfc program --batch bench-001 --count 1 --bench --part plain
```

The receipt says `bench` and `part=NTAG424DNA`, so nobody later mistakes a
bench sticker for a production seal. A plain sticker on a real box proves the
chip but cannot tell you the box was opened. Do not ship on one.

---

## 3. Commit the box, with the lid open

This is the step people skip, and it is the one that matters. **Before** the
sticker goes on, write down what is inside and seal that list.

Make a plain text file, one line per item, in the order they were packed:

```
2024 Topps Chrome hobby box, factory sealed, lot 7A
Certificate of authenticity 0041
Two slab holders, empty
```

Then:

```
timmy custody commit --serial VC0100 --contents contents.txt --product "Chrome hobby box" --by "Will" --where "Paradise, CA" --photos 3
```

The tool seals a receipt called `custody.commit` that carries a fingerprint of
that list. The list itself is kept beside the receipts. Later, anyone can ask
"what did the record say was inside?" and get the exact list, and the
fingerprint proves it was not edited afterwards.

Take the photos now, lid open, contents visible, serial in frame.

*[photo: open box, contents laid out, the serial card visible]*

---

## 4. Put the sticker on

Close the lid. The sticker goes **across the seam**: half on the lid, half on
the body, so that opening the box tears or lifts the label.

The loop the chip watches runs around the edge of the label. What matters is
that the seam passes *through* the label, not that the label sits near it.
Press it down firmly, edge to edge, for ten seconds. Do not stretch it. Do not
put it over a corner.

If the lid has two seams (a tuck flap and a fold), the sticker crosses the one
that has to move for the box to open.

*[photo: sticker across the lid seam, both halves flat]*

---

## 5. The first tap: seal it

With the sticker on, hold a phone to it. A page opens. That first tap writes
`custody.seal`: the box is now closed, with this contents list, and the
sticker's loop is intact. The page shows **SEALED**.

Look at the page and check three things before the box leaves the table:

1. the serial on the page is the serial on the box
2. the page says **sealed**, with a loop status of **closed**
3. the tap count is 1

*[photo: phone on the sticker, page showing SEALED]*

---

## 6. Sell it

At the point of sale, tap the box again. The page shows sealed and the tap
count goes up by one. Nothing else changes. Write the receipt number from the
sale in the notes if the shop keeps one; the tap is the proof of handover
time.

If the page shows anything other than sealed, do not sell it. See section 9.

---

## 7. Claim it

The buyer taps the box with their own phone. The page offers **claim**; they
put in their initials and city. From then on, the record says who holds it.
They can tap it any time and see the same page you saw.

---

## 8. Open it

When the buyer opens the box, the loop breaks. The next tap shows **OPENED**,
in orange, with the time of that tap and the city. The chip remembers this
forever: every tap after that, on any phone, says the box was opened.

If a *reveal* sticker was placed inside the box (some series do this), its
first tap records the reveal against the same serial.

---

## 9. What each page means

| The page says | What happened | What to do |
|---|---|---|
| **SEALED**, loop closed, green | The sticker is real, has not been lifted, and this tap is new | Nothing. This is normal. |
| **OPENED**, orange | The loop has been broken at some point since sealing | Expected after the buyer opens it. Before a sale: do not sell. |
| **VERIFIED** | A tap that checked out, on a page that has already been opened or claimed | Normal. |
| **Not a valid tap** (red) | The code on the sticker did not check out | The sticker is not one of ours, or was copied. Set the box aside. |
| **Already seen** (red) | This exact tap was recorded before | Someone re-used an old link (a screenshot, a copied URL). A real tap is always new. |
| **Unknown tag** | The sticker is real but not in the batch list | It was programmed but never added to the registry. Check the batch file. |

The page is the same one whichever phone taps. There is no app.

---

## 10. Where the receipts live

Every step above wrote a line into the same chain of receipts: the commit,
the seal, each sale or claim tap, the open. `timmy verify` checks the whole
chain and says `ok:true` or names the broken link. The daily head of the edge
chain is anchored into the root chain every morning by a scheduled job, so a
receipt written today is fixed in place by tomorrow.

To see a box's history, tap it, or open `/p/<serial>` on the site.

---

## Checklist for one box

- [ ] sticker programmed, `sealed` seen in the terminal, serial pencilled on the backing
- [ ] contents file written, one item per line
- [ ] `timmy custody commit` run **with the lid open**
- [ ] photos taken, lid open, serial in frame
- [ ] lid closed, sticker across the seam, pressed flat
- [ ] first tap: page says SEALED, loop closed, tap count 1
- [ ] box leaves the table

*[photo slot: the finished box, sticker across the seam, phone showing SEALED]*
