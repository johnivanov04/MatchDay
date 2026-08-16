# End-to-end image fixtures

Two real, decodable baseline JPEGs used by `e2e/specs/phase8-avatar.spec.ts`.

| File | Dimensions | Why |
| --- | --- | --- |
| `avatar-landscape.jpg` | 900×600 | The ordinary case, and wider than it is tall, so a centre-crop has something to crop. |
| `avatar-portrait.jpg` | 640×960 | The other orientation, used for "change photo" so the second avatar is provably a different image. |

They are **generated**, not photographs: a gradient, an off-centre white
circle and a large letter, drawn on a canvas and encoded at quality 0.9. That
is deliberate on two counts — no real person's face lives in this repository,
and the off-centre circle makes a wrong crop visible to anybody who opens the
file.

Regenerating them is not something the suite needs; they are checked in so that
`npm run test:e2e` depends on a real file on disk rather than on bytes the test
assembles for itself. The whole point of these specs is that a real browser
decodes a real JPEG, resizes it on a real canvas, and uploads the result to a
real Storage service.
