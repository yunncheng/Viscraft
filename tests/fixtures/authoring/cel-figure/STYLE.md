# Cel-layering invariants

Maintenance notes for [the fixture](README.md) and its
[rendering tests](../../../module-cel-figure.e2e.ts).

- Draw the whole subject in order: base fill, clipped hard shadow and static
  marks, clipped highlight, then the offset ink contour.
- Figure poses and vehicle travel use the held pose clock. Vehicle wheel rotation
  follows travelled distance divided by wheel radius.
- Lighting uses actual frame time; registration is a constant offset. These
  remain independent of the pose cadence.
- Seeded static marks must stay stable across frames and sampling order.
- Keep both subjects and multiple aspect ratios so geometry and canvas resizing
  are exercised independently of palette changes.
