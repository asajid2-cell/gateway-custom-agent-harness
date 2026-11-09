# Captures

The session captures used in [workflow.md](../workflow.md) are kept here.

The number matches the example, and the name says what the capture shows: `01-plan.png`, `02-fix.png`, `03-pass.png`, and `01-session.gif`. The first session is the only one recorded so far.

The GIF is 28 seconds and 4.0 MB. Keep GIFs under 5 MB, PNGs under 300 KB, and this folder under 15 MB. These limits keep the captures small enough to load from a README.

No video in git. GitHub will not play an MP4 from a README, so the long video lives on the download site and only short captures belong here.

## Capturing

I record a terminal window and convert it with ffmpeg. A terminal around 120x35 with a dark theme and 14pt or larger text keeps the GIF readable after scaling. Record the window to `raw.mkv`, then make the GIF and the site video from that recording.

```
# the GIF, 15 fps, 1280 wide, proper palette
ffmpeg -i raw.mkv -vf "fps=15,scale=1280:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" 01-plan.gif

# the MP4 for the site, H.264, web-optimised
ffmpeg -i raw.mkv -c:v libx264 -pix_fmt yuv420p -crf 23 -preset slow \
  -movflags +faststart -vf "scale=1280:-2" 01-plan.mp4

# the poster frame, for the video element on the site
ffmpeg -i 01-plan.mp4 -frames:v 1 01-plan-poster.jpg
```

I record in a scratch repository, not a work tree. Keep keys off screen, and make sure no `C:\Users\...` or `/home/...` path or other window appears in the recording.

## Where the video goes

The download site is https://ahmedsajid.ca/gateway/. The long video lives on that site, not in git, and will be linked here once it is available.
