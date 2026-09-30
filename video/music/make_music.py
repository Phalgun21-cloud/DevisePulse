"""Original soundtrack for the DevicePulse showreel.

Fully synthesized (numpy + scipy), deterministic (fixed seed), 120 BPM in A minor.
Sections and sound effects are keyed to the storyboard times in ../index.html.
Run:  python music/make_music.py   ->  assets/music.wav
"""
import os
import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve
from scipy.io import wavfile

SR = 44100
LENGTH = 152.0          # 150 s video + tail
BPM = 120
BEAT = 60 / BPM         # 0.5 s
BAR = 4 * BEAT          # 2 s
N = int(LENGTH * SR)
rng = np.random.default_rng(7)


def buf():
    return np.zeros((N, 2))


def secs(n):
    return np.arange(n) / SR


def midi(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def place(bus, sig, t, gain=1.0, pan=0.0):
    """Add mono or stereo `sig` at time t (seconds)."""
    i = int(round(t * SR))
    if i >= N or i + len(sig) <= 0:
        return
    if sig.ndim == 1:
        l = np.cos((pan + 1) * np.pi / 4)
        r = np.sin((pan + 1) * np.pi / 4)
        sig = np.stack([sig * l, sig * r], axis=1) * np.sqrt(2)
    j = min(N, i + len(sig))
    s0 = max(0, -i)
    bus[max(i, 0):j] += sig[s0:j - i] * gain


def lp(x, fc, order=2):
    return sosfilt(butter(order, min(fc, SR * 0.45), "low", fs=SR, output="sos"), x, axis=0)


def hp(x, fc, order=2):
    return sosfilt(butter(order, fc, "high", fs=SR, output="sos"), x, axis=0)


def bp(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, hi], "band", fs=SR, output="sos"), x, axis=0)


def saw(freq, n, phase=0.0):
    t = secs(n)
    ph = (freq * t + phase) % 1.0
    # polyBLEP-free but softened saw: good enough after filtering
    return 2 * ph - 1


def sweep_lp(x, cutoff):
    """Time-varying low-pass: crossfade between statically filtered copies.
    cutoff: array (len N) of Hz."""
    cuts = np.geomspace(120, 16000, 10)
    versions = [lp(x, c) for c in cuts]
    pos = np.interp(np.log(np.clip(cutoff, cuts[0], cuts[-1])), np.log(cuts), np.arange(len(cuts)))
    lo = np.floor(pos).astype(int)
    hi = np.minimum(lo + 1, len(cuts) - 1)
    w = (pos - lo)[:, None]
    stack = np.stack(versions)  # (k, N, 2)
    idx = np.arange(len(x))
    return stack[lo, idx] * (1 - w) + stack[hi, idx] * w


def automation(points):
    """Piecewise-linear automation from [(t, value), ...] -> per-sample array."""
    ts, vs = zip(*points)
    return np.interp(secs(N), ts, vs)


def reverb_ir(seconds=2.6, predelay=0.02):
    n = int(seconds * SR)
    t = secs(n)
    env = np.exp(-t * 6.9 / seconds)
    ir = rng.standard_normal((n, 2)) * env[:, None]
    ir = lp(ir, 7000)
    ir[: int(predelay * SR)] = 0
    return ir / np.sqrt(np.sum(ir ** 2, axis=0))


def apply_reverb(x, ir, wet=0.3):
    out = np.stack([fftconvolve(x[:, c], ir[:, c])[: len(x)] for c in range(2)], axis=1)
    return x * (1 - wet * 0.5) + out * wet


def delay(x, time_s, feedback=0.35, mix=0.3, pingpong=True):
    d = int(time_s * SR)
    out = x.copy()
    tap = x.copy()
    for k in range(1, 6):
        tap = np.roll(tap, d, axis=0)
        tap[:d] = 0
        tap = tap * feedback
        if pingpong:
            tap = tap[:, ::-1]
        out += tap * mix / feedback
    return out


# ------------------------------------------------------------------ harmony
# i - VI - III - VII in A minor, one chord per bar
CHORDS = [
    [57, 60, 64],  # Am  (A3 C4 E4)
    [53, 57, 60],  # F   (F3 A3 C4)
    [55, 60, 64],  # C   (G3 C4 E4) voiced
    [55, 59, 62],  # G   (G3 B3 D4)
]
ROOTS = [45, 41, 48, 43]  # A2 F2 C3 G2


def chord_at(t):
    return int(t // BAR) % 4


# ------------------------------------------------------------------ instruments
def kick():
    n = int(0.45 * SR)
    t = secs(n)
    f = 45 + 110 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t * 7.5)
    click = rng.standard_normal(n) * np.exp(-t * 300) * 0.25
    return np.tanh((body + hp(click, 2000)) * 1.6) * 0.9


def clap():
    n = int(0.35 * SR)
    t = secs(n)
    noise = rng.standard_normal(n)
    env = np.zeros(n)
    for k, off in enumerate([0, 0.011, 0.022]):
        i = int(off * SR)
        env[i:] += np.exp(-(t[: n - i]) * (160 if k < 2 else 16))
    return bp(noise * env, 900, 3200) * 0.6


def hat(open_=False):
    n = int((0.22 if open_ else 0.05) * SR)
    t = secs(n)
    x = hp(rng.standard_normal(n), 7500) * np.exp(-t * (14 if open_ else 90))
    return x * (0.22 if open_ else 0.16)


def snare():
    n = int(0.25 * SR)
    t = secs(n)
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 30) * 0.5
    noise = bp(rng.standard_normal(n), 1500, 8000) * np.exp(-t * 20)
    return (tone + noise) * 0.5


def bass_note(m, dur, bright=900):
    n = int(dur * SR)
    t = secs(n)
    f = midi(m)
    x = saw(f, n) * 0.6 + np.sin(2 * np.pi * f * t) * 0.7
    env = np.minimum(1, t / 0.005) * np.exp(-t * 2.2)
    return lp(x * env, bright, 4) * 0.8


def supersaw(notes, dur, detune=0.14, voices=5):
    n = int(dur * SR)
    t = secs(n)
    L = np.zeros(n)
    R = np.zeros(n)
    for m in notes:
        f = midi(m)
        for v in range(voices):
            d = (v - (voices - 1) / 2) / ((voices - 1) / 2) * detune
            fv = f * 2 ** (d / 12)
            w = saw(fv, n, phase=rng.random())
            if v % 2:
                L += w
            else:
                R += w
            if v == voices // 2:
                L += w * 0.5
                R += w * 0.5
    env = np.minimum(1, t / 0.02) * np.minimum(1, (dur - t) / 0.05).clip(0, 1)
    out = np.stack([L, R], axis=1) * env[:, None]
    return out / (len(notes) * voices) * 1.4


def pad(notes, dur):
    n = int(dur * SR)
    t = secs(n)
    x = supersaw(notes, dur, detune=0.09, voices=4)
    env = np.minimum(1, t / 1.2) * np.minimum(1, (dur - t) / 1.0).clip(0, 1)
    return lp(x, 1400) * env[:, None] * 1.3


def pluck(m, dur=0.22, bright=5000):
    n = int(dur * SR)
    t = secs(n)
    f = midi(m)
    x = saw(f, n) * 0.5 + np.sign(np.sin(2 * np.pi * f * 2 * t)) * 0.12
    env = np.exp(-t * 16)
    return lp(x * env, bright, 2) * 0.55


def lead(m, dur):
    n = int(dur * SR)
    t = secs(n)
    f = midi(m) * 2 ** (0.12 * np.sin(2 * np.pi * 5.5 * t) * np.minimum(1, t / 0.25) / 12)
    ph = 2 * np.pi * np.cumsum(f) / SR
    x = np.sign(np.sin(ph)) * 0.35 + np.sin(ph * 2) * 0.2 + ((ph / (2 * np.pi)) % 1 * 2 - 1) * 0.3
    env = np.minimum(1, t / 0.01) * np.exp(-t * 1.6) * np.minimum(1, (dur - t) / 0.03).clip(0, 1)
    return lp(x * env, 4200, 2) * 0.5


def heartbeat():
    n = int(0.6 * SR)
    t = secs(n)
    lub = np.sin(2 * np.pi * (48 + 30 * np.exp(-t * 30)) * t) * np.exp(-t * 14)
    t2 = np.clip(t - 0.26, 0, None)
    dub = np.sin(2 * np.pi * (58 + 30 * np.exp(-t2 * 30)) * t2) * np.exp(-t2 * 18) * (t >= 0.26) * 0.75
    return np.tanh((lub + dub) * 2.0) * 0.9


def beep(freq=1046.5, dur=0.09):
    n = int(dur * SR)
    t = secs(n)
    env = np.minimum(1, t / 0.003) * np.minimum(1, (dur - t) / 0.02).clip(0, 1)
    return np.sin(2 * np.pi * freq * t) * env * 0.22


def impact(big=True):
    n = int(3.5 * SR)
    t = secs(n)
    sub = np.sin(2 * np.pi * np.cumsum(30 + 70 * np.exp(-t * 6)) / SR) * np.exp(-t * 1.4)
    crash = hp(rng.standard_normal(n), 3000) * np.exp(-t * 2.2) * 0.35
    thump = lp(rng.standard_normal(n), 400) * np.exp(-t * 18) * 1.2
    x = np.tanh((sub * 1.2 + thump) * 1.5) + crash
    return x * (1.0 if big else 0.6)


def whoosh(dur=0.9, up=True):
    n = int(dur * SR)
    t = secs(n)
    noise = rng.standard_normal((n, 2))
    env = np.sin(np.pi * t / dur) ** 2
    cut = np.geomspace(400, 7000, n) if up else np.geomspace(7000, 400, n)
    # approximate sweep with 3 bands
    lo = bp(noise, 300, 1200)
    mid = bp(noise, 1200, 3500)
    hi = bp(noise, 3500, 9000)
    k = np.log(cut / 400) / np.log(7000 / 400)
    x = lo * (1 - k)[:, None] + mid * (1 - abs(k - 0.5) * 2)[:, None] + hi * k[:, None]
    return x * env[:, None] * 0.35


def riser(dur):
    n = int(dur * SR)
    t = secs(n)
    noise = rng.standard_normal((n, 2))
    cut = automation_local(n, 300, 12000)
    x = sweep_lp_local(noise, cut)
    tone = np.sin(2 * np.pi * np.cumsum(np.geomspace(110, 880, n)) / SR) * 0.15
    env = (t / dur) ** 2.2
    return (x * 0.3 + tone[:, None]) * env[:, None]


def automation_local(n, a, b):
    return np.geomspace(a, b, n)


def sweep_lp_local(x, cutoff):
    cuts = np.geomspace(200, 14000, 8)
    versions = np.stack([lp(x, c) for c in cuts])
    pos = np.interp(np.log(cutoff), np.log(cuts), np.arange(len(cuts)))
    lo = np.floor(pos).astype(int)
    hi = np.minimum(lo + 1, len(cuts) - 1)
    w = (pos - lo)[:, None]
    idx = np.arange(len(x))
    return versions[lo, idx] * (1 - w) + versions[hi, idx] * w


def reverse_swell(dur):
    n = int(dur * SR)
    t = secs(n)
    x = hp(rng.standard_normal((n, 2)), 2500) * (t / dur)[:, None] ** 3
    return x * 0.45


def tick():
    n = int(0.03 * SR)
    t = secs(n)
    return hp(rng.standard_normal(n), 4000) * np.exp(-t * 200) * 0.35 + np.sin(2 * np.pi * 2400 * t) * np.exp(-t * 150) * 0.12


def ui_click():
    n = int(0.06 * SR)
    t = secs(n)
    return np.sin(2 * np.pi * 1800 * t) * np.exp(-t * 90) * 0.25 + hp(rng.standard_normal(n), 3000) * np.exp(-t * 400) * 0.2


def chime():
    out = np.zeros(int(1.6 * SR))
    for i, m in enumerate([81, 88, 93]):
        n = len(out) - int(i * 0.07 * SR)
        t = secs(n)
        out[int(i * 0.07 * SR):] += np.sin(2 * np.pi * midi(m) * t) * np.exp(-t * 3) * 0.12
    return out


def glitch(dur=0.45):
    n = int(dur * SR)
    x = rng.standard_normal(n) * 0.3
    seg = int(0.03 * SR)
    for i in range(0, n, seg):
        f = rng.choice([220, 440, 880, 1760, 3520])
        tt = secs(min(seg, n - i))
        x[i:i + len(tt)] = np.sign(np.sin(2 * np.pi * f * tt)) * 0.25 * rng.random() + x[i:i + len(tt)] * rng.random()
    return np.round(x * 8) / 8 * 0.6


# ------------------------------------------------------------------ arrangement
drums = buf()
bass = buf()
chords = buf()
arp = buf()
leadbus = buf()
fx = buf()
padbus = buf()

K = kick()
CL = clap()
SN = snare()
kick_times = []


def section_on(t, spans):
    return any(a <= t < b for a, b in spans)


# Section spans (seconds)
KICK_SPANS = [(16, 29.5), (32, 96), (108, 110), (112, 143.5)]
FULL_SPANS = [(32, 60), (78, 96), (112, 140)]
GROOVE_SPANS = [(16, 29.5), (60, 78), (140, 143.5)]
BREAK_SPANS = [(96, 110)]

# Kicks
t = 0.0
while t < LENGTH:
    if section_on(t, KICK_SPANS):
        place(drums, K, t, 0.95)
        kick_times.append(t)
    t += BEAT
# Claps on 2 and 4 in full + groove (not the intro build first 4 bars)
for b in range(int(LENGTH / BAR)):
    for beat in (1, 3):
        t = b * BAR + beat * BEAT
        if section_on(t, FULL_SPANS + [(24, 29.5), (60, 78), (140, 143.5)]):
            place(drums, CL, t, 0.8, pan=0.05)

# Hats: 8th off-beats (open) in full; 16ths closed from 20s
step = BEAT / 4
t = 0.0
k = 0
while t < LENGTH:
    if section_on(t, [(20, 29.5), (32, 96), (112, 143.5)]):
        vel = 1.0 if k % 4 == 2 else (0.55 if k % 2 else 0.35)
        place(drums, hat(False), t, vel, pan=0.25 * np.sin(k))
    if section_on(t, FULL_SPANS) and k % 4 == 2:
        place(drums, hat(True), t, 0.7, pan=-0.2)
    t += step
    k += 1

# Snare rolls into the drops
for (a, b) in [(27.5, 29.5), (108.0, 112.0)]:
    t = a
    while t < b - 1e-6:
        frac = (t - a) / (b - a)
        rate = BEAT / 2 if frac < 0.5 else (BEAT / 4 if frac < 0.8 else BEAT / 8)
        place(drums, SN, t, 0.25 + 0.6 * frac, pan=0.1)
        t += rate

# Bass: off-beat 8ths (classic pumping), roots follow chords
t = 0.0
while t < LENGTH:
    if section_on(t, [(16, 29.5), (32, 96), (112, 143.5)]):
        ci = chord_at(t)
        beat_i = int(round((t % BAR) / (BEAT / 2)))
        m = ROOTS[ci] - 12
        if beat_i % 2 == 1:  # off-beats
            m2 = m + (12 if (section_on(t, FULL_SPANS) and beat_i in (3, 7)) else 0)
            place(bass, bass_note(m2, BEAT / 2 * 0.9, bright=700 if t < 32 else 1100), t, 0.9)
        elif section_on(t, FULL_SPANS):
            place(bass, bass_note(m, BEAT / 2 * 0.9, bright=500), t, 0.55)
    t += BEAT / 2

# Sub drone in intro and breakdown
for (a, b) in [(0, 16), (96, 110), (144, 151)]:
    n = int((b - a) * SR)
    tt = secs(n)
    f = midi(33)
    drone = np.sin(2 * np.pi * f * tt) * np.minimum(1, tt / 2) * np.minimum(1, (b - a - tt) / 1.5).clip(0, 1) * 0.35
    place(bass, drone, a)

# Supersaw chords (full sections), stab rhythm: dotted pattern per bar
STAB = [0, 0.75, 1.5, 2.0, 2.75, 3.5]  # in beats
for b in range(int(LENGTH / BAR)):
    t0 = b * BAR
    if not section_on(t0, FULL_SPANS):
        continue
    notes = CHORDS[b % 4]
    notes = notes + [notes[0] + 12]
    for s in STAB:
        place(chords, supersaw(notes, BEAT * 0.62), t0 + s * BEAT, 0.9)

# Pads: intro, groove, breakdown, outro
for b in range(int(LENGTH / BAR)):
    t0 = b * BAR
    if section_on(t0, [(0, 16), (16, 32), (60, 78), (96, 112), (144, 150)]):
        notes = [n - 12 for n in CHORDS[b % 4]] + CHORDS[b % 4]
        g = 0.55 if t0 < 16 else 0.45
        place(padbus, pad(notes, BAR + 0.8), t0, g)
# Final held chord for the logo (Am add9)
place(padbus, pad([45, 57, 60, 64, 71], 7.5), 144.0, 0.9)

# Arp: 16ths of chord tones
ARP = [0, 1, 2, 3, 2, 1, 3, 2]
t = 0.0
k = 0
while t < LENGTH:
    if section_on(t, [(18, 29.5), (32, 96), (96, 108), (112, 143.5)]):
        ci = chord_at(t)
        tones = CHORDS[ci] + [CHORDS[ci][0] + 12]
        m = tones[ARP[k % 8]] + 12
        bright = 1800 if section_on(t, BREAK_SPANS) else 4200
        place(arp, pluck(m, 0.2, bright), t, 0.5, pan=0.35 * np.sin(k * 0.7))
    t += BEAT / 2 / 2
    k += 1

# Lead hook in the final drop (and a softer version in the groove section)
HOOK = [  # (beat offset within 4-bar phrase, midi, length in beats)
    (0, 76, 1), (1.5, 76, 0.5), (2, 74, 0.5), (2.5, 72, 1), (3.5, 69, 0.5),
    (4, 72, 1), (5.5, 72, 0.5), (6, 74, 0.5), (6.5, 76, 1.5),
    (8, 79, 1), (9.5, 76, 0.5), (10, 74, 0.5), (10.5, 72, 1.5),
    (12, 71, 1), (13, 74, 1), (14, 79, 1), (15, 77, 1),
]
for (a, b, g) in [(112, 140, 0.8), (60, 76, 0.45)]:
    t0 = a
    while t0 < b - 0.01:
        for off, m, ln in HOOK:
            ts = t0 + off * BEAT
            if ts < b:
                place(leadbus, lead(m, ln * BEAT * 0.95), ts, g)
        t0 += 4 * BAR

# ------------------------------------------------------------------ sound effects (keyed to visuals)
HB = heartbeat()
for t in (1.0, 2.5, 4.0, 5.5, 7.0):
    place(fx, HB, t - 0.02, 0.8)
    place(fx, beep(), t, 0.9, pan=0.1)
for t in (8.5, 8.8, 9.05):  # arrhythmia
    place(fx, HB, t, 0.55)
    place(fx, beep(1174.7, 0.06), t, 0.8)
# flatline tone
n = int(3.2 * SR)
tt = secs(n)
flat = np.sin(2 * np.pi * 1046.5 * tt) * 0.16 * np.minimum(1, tt / 0.02) * np.minimum(1, (3.2 - tt) / 1.4).clip(0, 1)
place(fx, flat, 9.3)
place(fx, glitch(0.5), 15.55, 0.8)
for t in (16.0, 19.0, 22.0):
    place(fx, whoosh(0.5), t - 0.25, 0.7)
    place(fx, impact(False)[: int(0.6 * SR)], t, 0.5)
for t in (25.0, 25.5, 26.0):
    place(fx, impact(False)[: int(0.8 * SR)], t, 0.8)
for i in range(22):  # typewriter ticks
    place(fx, tick(), 27.0 + i * 0.07, 0.5, pan=0.2 * np.sin(i))
place(fx, reverse_swell(2.5), 29.5, 1.0)
place(fx, riser(2.5), 29.5, 0.9)
place(fx, HB, 30.4, 0.9)
for t in (32.0, 112.0, 144.0):
    place(fx, impact(True), t, 1.0)
for t in (44.0, 60.0, 78.0, 96.0, 126.0, 140.0):
    place(fx, whoosh(0.8), t - 0.4, 1.0)
place(fx, ui_click(), 98.0, 1.0)
for i in range(11):  # countdown 10 -> 0
    place(fx, tick(), 98.5 + i * 0.4, 0.8)
for t in (103.0, 103.5, 104.0, 104.5):
    place(fx, beep(880 + (t - 103) * 400, 0.07), t, 0.6)
place(fx, chime(), 106.5, 1.0)
place(fx, riser(4.0), 108.0, 0.9)
place(fx, reverse_swell(2.0), 142.0, 0.8)
place(fx, HB, 146.98, 0.6)
place(fx, beep(), 147.0, 0.8)

# ------------------------------------------------------------------ mix
# sidechain envelope from kicks
sc = np.ones(N)
rel = int(0.28 * SR)
duck = 1 - 0.65 * np.exp(-np.arange(rel) / (0.07 * SR))
for kt in kick_times:
    i = int(kt * SR)
    j = min(N, i + rel)
    sc[i:j] = np.minimum(sc[i:j], duck[: j - i])
sc = sc[:, None]

# master filter automation for the build (intro build 16-29.5 opens up) and breakdown
build_cut = automation([(0, 16000), (16, 900), (29.5, 9000), (32, 16000), (96, 16000), (96.2, 1200),
                        (108, 1500), (112, 16000), (LENGTH, 16000)])

arp = delay(arp, BEAT * 0.75, feedback=0.4, mix=0.35)
leadbus = delay(leadbus, BEAT * 0.75, feedback=0.3, mix=0.3)
music = (bass * 0.9 + chords * 0.55 + arp * 0.5 + leadbus * 0.55) * sc + padbus * (0.4 + 0.6 * sc)
music = sweep_lp(music, build_cut)
ir = reverb_ir(2.6)
music = apply_reverb(music, ir, wet=0.28)
drums_mix = sweep_lp(drums, automation([(0, 16000), (16, 1500), (29.5, 12000), (32, 16000), (LENGTH, 16000)]))
fxmix = apply_reverb(fx, reverb_ir(3.2), wet=0.25)

mix = music * 0.8 + drums_mix * 0.85 + fxmix * 0.9
mix = hp(mix, 28)

# final fade
t_all = secs(N)
fade = np.clip((151.5 - t_all) / 3.0, 0, 1)
mix *= fade[:, None]

# glue + limiter
mix = mix / np.max(np.abs(mix)) * 1.4
mix = np.tanh(mix) / np.tanh(1.4)
mix = mix / np.max(np.abs(mix)) * 0.89

out = os.path.join(os.path.dirname(__file__), "..", "assets", "music.wav")
os.makedirs(os.path.dirname(out), exist_ok=True)
wavfile.write(out, SR, (mix * 32767).astype(np.int16))
print("wrote", os.path.abspath(out), f"{LENGTH:.0f}s")
