# Audio

`sea-waves.mp3` — the ambience under the site view.

- **Source**: the `sounds-for-focus` npm package, `audio/nature/waves.mp3`
  (https://github.com/planetabhi/sounds-for-focus), which is itself a curated
  catalogue after Moodist (https://moodist.mvze.net/).
- **Licence**: MIT. The package ships the audio and is MIT licensed; a copy of
  that licence is beside this file.
- **What was changed**: thirty-four seconds cut out of the ninety-nine second
  original on MP3 frame boundaries, to keep the download under a megabyte.
  Nothing was re-encoded.
- **Looping**: the join is crossfaded at load time, in the browser, on the
  decoded samples (`Sound.loadSea` in `js/audio.js`). Cutting a recording and
  looping it raw steps at the join; a three second equal-power crossfade into
  the head, with the loop starting after the head, cannot.
