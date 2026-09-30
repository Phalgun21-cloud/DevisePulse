# DevicePulse showreel: design

## Style Prompt
A premium, energetic product film for DevicePulse, predictive health monitoring for laptops. Deep ink-blue darkness
lit by a single teal "pulse" accent that behaves like a heartbeat trace: it draws, spikes, glows and flows between
scenes. The feel is a medical monitor redesigned by a luxury tech brand. Motion is confident and beat-locked
(120 BPM: 0.5 s per beat, 2 s per bar). Data is always honest: real results are tagged REAL, illustrative data is
tagged SIMULATED, and a forecast is always a range with a confidence label, never a date.

## Colors
- `#05080c` ground (every scene; never pure black)
- `#0d141c` panel, `#1a2530` hairline
- `#e8f0f4` foreground text, `#8fa0ae` muted text
- `#2dd4bf` pulse teal (the one accent), `#99f6e4` highlight
- `#b4a3ff` Simulated tag only
- Severity: Information `#7fb3d5`, Watch `#f5b841`, Attention `#fb7a3c`, Urgent `#f43f5e`

## Typography
- **Unbounded** 700-900: brand voice, headlines, the wordmark
- **IBM Plex Mono** 400-600: the machine's voice, used for data, labels and readouts (the dashboard's own font)
- **Instrument Serif** italic: the human voice, used for a few emotional lines ("Every laptop has a pulse.")

## Motion
- Entrances: `expo.out`, `power4.out` and `back.out(1.6)` for chips; staggers under 0.5 s.
- Hits land on beats; scene changes land on bar lines.
- Ambient: breathing radial glows, a drifting grid and film grain.

## What NOT to Do
- No exact failure dates, anywhere. Say "may reach", with a range and a confidence label.
- No unlabelled data: anything illustrative carries a SIMULATED tag.
- No gradient text, no purple-to-blue gradients, no pure #000 or #fff.
- No full-screen linear gradients (banding); use radial glows.
- No zeros for missing sensors: show "Not available on this device".
