# Captures

The short clips and stills that `workflow.md` refers to.

**Naming.** Numbered by step: `01-plan.gif`, `02-test.png`,
`03-leaf.gif`, `04-rail.gif`, `05-providers.png`. The number matches the
step, the word matches what the step shows, so a file is findable later without
opening it.

**Weight.** A GIF here stays under 5 MB and a PNG under 300 KB - the current capture is 4.4 MB of GIF and 270 KB of stills.
images through its own proxy, so a 40 MB GIF makes the page slow for everyone
and is the reason most repos with a demo have a broken one. Total folder should
stay under 15 MB.

**Video is not here.** Git is bad at it and GitHub will not play an MP4 from a
README anyway. The long walkthrough is served from the download site and linked
from `examples/README.md`; only the short loops live in this folder.

## Capturing

Terminal at 120x35 or thereabouts, dark theme, 14pt or larger - smaller than
that and the GIF is unreadable after scaling. Record the window to `raw.mkv`,
then derive everything from it:

```
# the GIF, 15 fps, 1280 wide, proper palette
ffmpeg -i raw.mkv -vf "fps=15,scale=1280:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" 01-plan.gif

# the MP4 for the site, H.264, web-optimised
ffmpeg -i raw.mkv -c:v libx264 -pix_fmt yuv420p -crf 23 -preset slow \
  -movflags +faststart -vf "scale=1280:-2" 01-plan.mp4

# the poster frame, for the video element on the site
ffmpeg -i 01-plan.mp4 -frames:v 1 01-plan-poster.jpg
```

Record in a scratch repository, not a work tree. No keys on screen, no
`C:\Users\...` or `/home/...` in a prompt, no other windows in frame. A capture
that leaks a path is worse than no capture - it is the one part of the docs
nobody re-reads before publishing.

## Where the video goes

`https://ahmedsajid.ca/gateway/` is behind the download gate, so anything served
under it is behind the same gate - a README image would get a login page
instead of pixels. The long video needs a path outside that gate (its own
`/gateway-media/` location block, no auth, cacheable by extension), and this
folder links to that page once it exists.
