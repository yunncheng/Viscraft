# Review the changes and the joins

Start with the accepted [complete film](../movie/final.mp4), then use the
actual sampled sequences to inspect a specific question:

| Evidence | What to inspect |
| --- | --- |
| [World comparison](world-comparison.png) | Wall, village/tower, boats, ridge and rider layout across the change of rendering |
| [Motion guide](motion-guide-grid.jpg) | The code animation supplied for motion/layout, distinct from the photo's appearance role |
| [Ride opening](ride-opening.jpg) and [ride contact sheet](ride-contact.jpg) | The returned clip's actual harbour, camera and movement toward the cove |
| [Tear sequence](final-tear-grid.jpg) and [composed tear](composed-tear-grid.jpg) | How the actual ride opening is exposed by the paper, then continues in the edit |
| [Ending](final-ending-grid.jpg), [home contact sheet](home-contact.jpg) and [stop/flock strip](home-stop-flock.jpg) | The change of shot size, stop, grounded foot, head turn, flock and retreat |

`anchor-review.json`, `ride-review.json` and `home-review.json` retain original
sampled visual observations and their limits. In particular, the second H3 shot
uses a closer beachside view; a request for the previous state did not produce an
identical camera frame. Landmarks and action should be assessed in the actual
edit, not inferred from the prompt.

`final-validation.json` records the original accepted movie: 600 frames at
24 fps, 25 seconds, complete decode, no exactly repeated adjacent frame, and
measured programme loudness of -17.8 LUFS / -2.4 dBTP. `final-frame-hashes.txt`
pins the decoded frames. Those facts establish media properties, not subjective
sound quality or a guarantee of smooth/natural performance. Original JSON
Build/Artifact IDs name the owner production, not a new Build of this reference.

For your own edit, inspect the actual changed passage and its neighbours; evaluate
sound with whatever listening capability is available and report its real scope.
The complete case is an optional reference, not a quality score or a mandatory
workflow.
