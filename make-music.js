/*
-----------------------------------------
make-music.js

Creates 10 ORIGINAL background tracks (2 for each mood) and saves them
in the "music" folder. Nobody else owns these tracks: the computer
composes them from scratch, so they are free to use in reels you sell.

Run it once:   node make-music.js
Make new ones: node make-music.js --force
-----------------------------------------
*/

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const SR = 44100; // samples per second
const LENGTH = 120; // seconds per track
const OUT_DIR = path.join(__dirname, "music");

const FORCE = process.argv.includes("--force");

/*
-----------------------------------------
BUILDING BLOCKS
-----------------------------------------
*/

// "Random" numbers that repeat the same way every run
function makeRandom(seed) {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// MIDI note number -> frequency in Hz
const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

// Notes that make up each kind of chord
const CHORDS = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  sus: [0, 5, 7]
};

function newLayer() {
  return {
    l: new Float32Array(SR * LENGTH),
    r: new Float32Array(SR * LENGTH)
  };
}

// One cycle of a wave. p is how far through the cycle we are (0 to 1)
function wave(type, cycles) {
  const p = cycles - Math.floor(cycles);

  switch (type) {
    case "triangle":
      return 4 * Math.abs(p - 0.5) - 1;
    case "saw":
      return 2 * p - 1;
    case "square":
      return p < 0.5 ? 1 : -1;
    case "piano":
      return (
        (Math.sin(2 * Math.PI * p) +
          0.45 * Math.sin(4 * Math.PI * p) +
          0.2 * Math.sin(6 * Math.PI * p) +
          0.08 * Math.sin(8 * Math.PI * p)) /
        1.6
      );
    default:
      return Math.sin(2 * Math.PI * p);
  }
}

// Play one note into a layer
function addTone(layer, start, duration, freq, o) {
  const first = Math.floor(start * SR);
  const total = Math.floor((duration + o.release) * SR);

  const angle = ((o.pan || 0) + 1) * (Math.PI / 4);
  const gainL = o.amp * Math.cos(angle);
  const gainR = o.amp * Math.sin(angle);

  const detunes = o.detune ? [1 - o.detune, 1, 1 + o.detune] : [1];

  for (let i = 0; i < total; i++) {
    const index = first + i;
    if (index >= layer.l.length) break;

    const t = i / SR;

    // Volume shape: fade in, then either ring out (plucks) or hold (pads)
    let env = t < o.attack ? t / o.attack : o.decay ? Math.exp(-(t - o.attack) * o.decay) : 1;

    // Fade out after the note ends
    if (t > duration) env *= Math.max(0, 1 - (t - duration) / o.release);

    let v = 0;
    for (const d of detunes) v += wave(o.type, freq * d * t);
    v /= detunes.length;

    layer.l[index] += v * env * gainL;
    layer.r[index] += v * env * gainR;
  }
}

/*
-----------------------------------------
DRUMS (drawn from noise and sine waves)
-----------------------------------------
*/

function addKick(layer, start, amp) {
  const first = Math.floor(start * SR);
  const total = Math.floor(0.32 * SR);
  let phase = 0;

  for (let i = 0; i < total; i++) {
    const index = first + i;
    if (index >= layer.l.length) break;

    const t = i / SR;
    phase += (2 * Math.PI * (46 + 95 * Math.exp(-t * 32))) / SR;

    const v = Math.sin(phase) * Math.exp(-t * 9) * amp;

    layer.l[index] += v;
    layer.r[index] += v;
  }
}

function addSnare(layer, start, amp, random, dry) {
  const first = Math.floor(start * SR);
  const total = Math.floor((dry ? 0.12 : 0.22) * SR);

  for (let i = 0; i < total; i++) {
    const index = first + i;
    if (index >= layer.l.length) break;

    const t = i / SR;
    const noise = (random() * 2 - 1) * Math.exp(-t * (dry ? 34 : 22));
    const tone = Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30);
    const v = (noise * 0.7 + tone * 0.45) * amp;

    layer.l[index] += v;
    layer.r[index] += v;
  }
}

function addHat(layer, start, amp, open, random, pan) {
  const first = Math.floor(start * SR);
  const total = Math.floor((open ? 0.22 : 0.05) * SR);
  const gainL = amp * (1 - 0.4 * pan);
  const gainR = amp * (1 + 0.4 * pan);
  let previous = 0;

  for (let i = 0; i < total; i++) {
    const index = first + i;
    if (index >= layer.l.length) break;

    const t = i / SR;
    const x = random() * 2 - 1;

    // Taking the difference of neighbouring noise samples keeps only the high "tss"
    const v = (x - previous) * 0.5 * Math.exp(-t * (open ? 15 : 80));
    previous = x;

    layer.l[index] += v * gainL;
    layer.r[index] += v * gainR;
  }
}

function addWood(layer, start, amp, freq) {
  const first = Math.floor(start * SR);
  const total = Math.floor(0.08 * SR);

  for (let i = 0; i < total; i++) {
    const index = first + i;
    if (index >= layer.l.length) break;

    const t = i / SR;
    const v =
      (Math.sin(2 * Math.PI * freq * t) + 0.4 * Math.sin(2 * Math.PI * freq * 2.4 * t)) *
      Math.exp(-t * 55) *
      amp;

    layer.l[index] += v;
    layer.r[index] += v;
  }
}

/*
-----------------------------------------
EFFECTS
-----------------------------------------
*/

// Soften harsh high sounds
function lowpass(layer, cutoff) {
  const dt = 1 / SR;
  const rc = 1 / (2 * Math.PI * cutoff);
  const a = dt / (rc + dt);

  for (const channel of [layer.l, layer.r]) {
    let y = 0;

    for (let i = 0; i < channel.length; i++) {
      y += a * (channel[i] - y);
      channel[i] = y;
    }
  }
}

// Make the music "breathe" with the kick drum (only while the drums play)
function pump(layer, beat, bar, depth, release, drumsOnAtBar) {
  for (let i = 0; i < layer.l.length; i++) {
    const t = i / SR;

    if (!drumsOnAtBar(Math.floor(t / bar))) continue;

    const g = 1 - depth * Math.exp(-(t % beat) / release);

    layer.l[i] *= g;
    layer.r[i] *= g;
  }
}

/*
-----------------------------------------
THE FIVE STYLES
-----------------------------------------
*/

const STYLES = {
  energetic: {
    drums: true,
    pad: { amp: 0.05, attack: 0.15, cutoff: 2200, type: "saw" },
    padGain: 2.6,
    arpGain: 2.3,
    bassGain: 1.1,
    drumGain: 0.8,
    pumpDepth: 0.55
  },
  upbeat: {
    drums: true,
    pad: { amp: 0.045, attack: 0.1, cutoff: 1800, type: "saw" },
    padGain: 2.2,
    arpGain: 2.1,
    bassGain: 1,
    drumGain: 0.8,
    pumpDepth: 0.3
  },
  calm: {
    drums: false,
    pad: { amp: 0.06, attack: 0.9, cutoff: 1300, type: "saw" },
    padGain: 1,
    arpGain: 0.7,
    bassGain: 0.8,
    drumGain: 0,
    pumpDepth: 0
  },
  emotional: {
    drums: false,
    pad: { amp: 0.06, attack: 1.0, cutoff: 1500, type: "saw" },
    padGain: 1,
    arpGain: 1,
    bassGain: 0.9,
    drumGain: 0,
    pumpDepth: 0
  },
  funny: {
    drums: true,
    pad: { amp: 0.03, attack: 0.05, cutoff: 1500, type: "triangle" },
    padGain: 1.3,
    arpGain: 1.6,
    bassGain: 1,
    drumGain: 0.8,
    pumpDepth: 0
  }
};

/*
-----------------------------------------
THE TEN TRACKS
Each chord is [bass note, chord type]. One chord per bar.
-----------------------------------------
*/

const TRACKS = [
  { file: "energetic-1", style: "energetic", bpm: 128, seed: 11,
    prog: [[45, "min"], [41, "maj"], [48, "maj"], [43, "maj"]] },
  { file: "energetic-2", style: "energetic", bpm: 140, seed: 12,
    prog: [[40, "min"], [48, "maj"], [43, "maj"], [38, "maj"]] },

  { file: "upbeat-1", style: "upbeat", bpm: 112, seed: 21,
    prog: [[48, "maj"], [43, "maj"], [45, "min"], [41, "maj"]] },
  { file: "upbeat-2", style: "upbeat", bpm: 120, seed: 22,
    prog: [[43, "maj"], [38, "maj"], [40, "min"], [48, "maj"]] },

  { file: "calm-1", style: "calm", bpm: 68, seed: 31,
    prog: [[48, "maj7"], [45, "min7"], [41, "maj7"], [43, "sus"]] },
  { file: "calm-2", style: "calm", bpm: 76, seed: 32,
    prog: [[50, "maj7"], [47, "min7"], [43, "maj7"], [45, "sus"]] },

  { file: "emotional-1", style: "emotional", bpm: 72, seed: 41,
    prog: [[45, "min"], [41, "maj"], [48, "maj"], [43, "maj"]] },
  { file: "emotional-2", style: "emotional", bpm: 66, seed: 42,
    prog: [[38, "min"], [46, "maj"], [41, "maj"], [48, "maj"]] },

  { file: "funny-1", style: "funny", bpm: 122, seed: 51,
    prog: [[48, "maj"], [41, "maj"], [48, "maj"], [43, "maj"]] },
  { file: "funny-2", style: "funny", bpm: 132, seed: 52,
    prog: [[41, "maj"], [46, "maj"], [41, "maj"], [48, "maj"]] }
];

/*
-----------------------------------------
COMPOSING ONE TRACK
-----------------------------------------
*/

function composeTrack(config) {
  const style = STYLES[config.style];
  const random = makeRandom(config.seed);

  const beat = 60 / config.bpm;
  const bar = beat * 4;
  const bars = Math.ceil(LENGTH / bar);

  const pad = newLayer();
  const arp = newLayer();
  const bass = newLayer();
  const drums = newLayer();

  // Every 16 bars, the first 4 are a gentle intro without drums and bass
  const grooveOn = (b) => style.drums && b % 16 >= 4;
  const bassOn = (b) => (style.drums ? b % 16 >= 4 : true);

  for (let b = 0; b < bars; b++) {
    const [root, type] = config.prog[b % config.prog.length];
    const intervals = CHORDS[type];
    const t0 = b * bar;

    // The notes the chord is built from, in a few octaves
    const arpNotes = [];
    for (const octave of [24, 36]) {
      for (const i of intervals) arpNotes.push(root + octave + i);
    }

    /* --- PAD: the warm chord underneath --- */
    intervals.forEach((interval, k) => {
      addTone(pad, t0, bar, hz(root + 12 + interval), {
        type: style.pad.type,
        amp: style.pad.amp,
        attack: style.pad.attack,
        release: 0.5,
        detune: 0.004,
        pan: (k - (intervals.length - 1) / 2) * 0.35
      });
    });

    /* --- ARPEGGIO (the melody-like notes) AND BASS --- */
    if (config.style === "energetic") {
      for (let s = 0; s < 16; s++) {
        const pattern = [0, 1, 2, 1, 3, 2, 4, 2];
        const note = arpNotes[pattern[s % 8] % arpNotes.length];

        addTone(arp, t0 + s * (beat / 4), beat / 4, hz(note), {
          type: "triangle", amp: 0.07, attack: 0.004, decay: 9, release: 0.05,
          pan: s % 2 ? 0.45 : -0.45
        });
      }

      if (bassOn(b)) {
        for (let i = 0; i < 4; i++) {
          addTone(bass, t0 + i * beat + beat / 2, beat * 0.42, hz(root), {
            type: "saw", amp: 0.22, attack: 0.005, release: 0.04, pan: 0
          });
        }
      }
    }

    if (config.style === "upbeat") {
      for (let s = 0; s < 8; s++) {
        const pattern = [0, 2, 1, 3, 2, 4, 3, 1];
        const note = arpNotes[pattern[s] % arpNotes.length];

        addTone(arp, t0 + s * (beat / 2), beat / 2, hz(note), {
          type: "triangle", amp: 0.09, attack: 0.004, decay: 7, release: 0.06,
          pan: s % 2 ? 0.4 : -0.4
        });
      }

      if (bassOn(b)) {
        const plan = [
          [0, root], [1.5, root + 7], [2, root], [3, root + 12], [3.5, root + 7]
        ];

        for (const [position, note] of plan) {
          addTone(bass, t0 + position * beat, beat * 0.4, hz(note), {
            type: "triangle", amp: 0.3, attack: 0.005, decay: 6, release: 0.05, pan: 0
          });
        }
      }
    }

    if (config.style === "calm") {
      for (let s = 0; s < 8; s++) {
        if (s % 2 === 1 && random() < 0.4) continue; // leave a little space

        const note = arpNotes[(s * 2 + (b % 3)) % arpNotes.length] + 12;

        addTone(arp, t0 + s * (beat / 2), beat, hz(note), {
          type: "sine", amp: 0.085, attack: 0.01, decay: 2.6, release: 0.2,
          pan: s % 2 ? 0.5 : -0.5
        });
      }

      addTone(bass, t0, bar, hz(root), {
        type: "sine", amp: 0.16, attack: 0.15, release: 0.5, pan: 0
      });
    }

    if (config.style === "emotional") {
      // Slow, broken-chord "piano"
      for (let s = 0; s < 8; s++) {
        const pattern = [0, 1, 2, 4, 2, 1, 3, 1];
        const note = arpNotes[pattern[s] % arpNotes.length];

        addTone(arp, t0 + s * (beat / 2), beat * 1.5, hz(note), {
          type: "piano", amp: 0.12, attack: 0.006, decay: 1.9, release: 0.25,
          pan: s % 2 ? 0.3 : -0.3
        });
      }

      addTone(bass, t0, bar, hz(root), {
        type: "sine", amp: 0.17, attack: 0.1, release: 0.6, pan: 0
      });
    }

    if (config.style === "funny") {
      for (let s = 0; s < 8; s++) {
        const pattern = [0, 2, 4, 2, 1, 3, 5, 3];
        const note = arpNotes[pattern[s] % arpNotes.length] + 12;

        addTone(arp, t0 + s * (beat / 2), beat / 3, hz(note), {
          type: "triangle", amp: 0.1, attack: 0.003, decay: 20, release: 0.03,
          pan: s % 2 ? 0.5 : -0.5
        });
      }

      const plan = [[0, root], [1, root + 7], [2, root], [3, root + 7]];

      for (const [position, note] of plan) {
        addTone(bass, t0 + position * beat, beat * 0.35, hz(note), {
          type: "square", amp: 0.14, attack: 0.004, decay: 10, release: 0.04, pan: 0
        });
      }
    }

    /* --- DRUMS --- */
    if (style.drums && (config.style === "funny" || grooveOn(b))) {
      if (config.style === "energetic") {
        for (let i = 0; i < 4; i++) {
          addKick(drums, t0 + i * beat, 0.9);
          if (i % 2 === 1) addSnare(drums, t0 + i * beat, 0.45, random, false);
          addHat(drums, t0 + i * beat + beat / 2, 0.2, i % 2 === 1, random, i % 2 ? 0.5 : -0.5);
          addHat(drums, t0 + i * beat + beat / 4, 0.07, false, random, 0.3);
          addHat(drums, t0 + i * beat + (beat * 3) / 4, 0.07, false, random, -0.3);
        }
      }

      if (config.style === "upbeat") {
        for (const position of [0, 2, 2.5]) {
          addKick(drums, t0 + position * beat, 0.8);
        }

        for (const position of [1, 3]) {
          addSnare(drums, t0 + position * beat, 0.4, random, false);
        }

        for (let s = 0; s < 8; s++) {
          addHat(drums, t0 + s * (beat / 2), s % 2 ? 0.16 : 0.1, false, random, s % 2 ? 0.4 : -0.4);
        }
      }

      if (config.style === "funny") {
        for (const position of [0, 2]) addKick(drums, t0 + position * beat, 0.7);
        for (const position of [1, 3]) addSnare(drums, t0 + position * beat, 0.4, random, true);

        for (let s = 0; s < 4; s++) {
          addWood(drums, t0 + s * beat + beat / 2, 0.25, s % 2 ? 1250 : 900);
        }
      }
    }
  }

  /* --- SMOOTH THE SOUND --- */
  lowpass(pad, style.pad.cutoff);
  lowpass(bass, 650);

  if (style.pumpDepth > 0) {
    pump(pad, beat, bar, style.pumpDepth, 0.13, grooveOn);
    pump(bass, beat, bar, style.pumpDepth * 0.8, 0.13, grooveOn);
  }

  /* --- MIX THE LAYERS --- */
  const left = new Float32Array(SR * LENGTH);
  const right = new Float32Array(SR * LENGTH);

  const mix = [
    [pad, style.padGain],
    [arp, style.arpGain],
    [bass, style.bassGain],
    [drums, style.drumGain]
  ];

  for (const [layer, gain] of mix) {
    for (let i = 0; i < left.length; i++) {
      left[i] += layer.l[i] * gain;
      right[i] += layer.r[i] * gain;
    }
  }

  return finish(left, right);
}

// Set the final volume and fade the ends
function finish(left, right) {
  let sum = 0;
  let peak = 0;

  for (let i = 0; i < left.length; i++) {
    sum += left[i] * left[i] + right[i] * right[i];
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }

  const rms = Math.sqrt(sum / (left.length * 2));

  // Aim for a steady loudness, without ever clipping
  let scale = 0.1 / rms;
  if (peak * scale > 0.92) scale = 0.92 / peak;

  const fadeIn = Math.floor(0.05 * SR);
  const fadeOut = Math.floor(4 * SR);

  for (let i = 0; i < left.length; i++) {
    let g = scale;

    if (i < fadeIn) g *= i / fadeIn;
    if (i > left.length - fadeOut) g *= (left.length - i) / fadeOut;

    left[i] *= g;
    right[i] *= g;
  }

  return { left, right };
}

/*
-----------------------------------------
SAVING THE FILES
-----------------------------------------
*/

function writeWav(file, left, right) {
  const count = left.length;
  const buffer = Buffer.alloc(44 + count * 4);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + count * 4, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // plain PCM
  buffer.writeUInt16LE(2, 22); // stereo
  buffer.writeUInt32LE(SR, 24);
  buffer.writeUInt32LE(SR * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(count * 4, 40);

  let offset = 44;
  const toInt = (x) => Math.round(Math.max(-1, Math.min(1, x)) * 32767);

  for (let i = 0; i < count; i++) {
    buffer.writeInt16LE(toInt(left[i]), offset);
    buffer.writeInt16LE(toInt(right[i]), offset + 2);
    offset += 4;
  }

  fs.writeFileSync(file, buffer);
}

// Turn the big WAV file into a small MP3
function toMp3(wavPath, mp3Path) {
  return new Promise((resolve) => {
    execFile(
      "ffmpeg",
      ["-y", "-v", "error", "-i", wavPath, "-codec:a", "libmp3lame", "-b:a", "160k", mp3Path],
      (error) => resolve(!error)
    );
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const config of TRACKS) {
    const wavPath = path.join(OUT_DIR, config.file + ".wav");
    const mp3Path = path.join(OUT_DIR, config.file + ".mp3");

    if (!FORCE && (fs.existsSync(mp3Path) || fs.existsSync(wavPath))) {
      console.log(`Skipping ${config.file} (already exists)`);
      continue;
    }

    process.stdout.write(`Composing ${config.file} ... `);

    const { left, right } = composeTrack(config);
    writeWav(wavPath, left, right);

    if (await toMp3(wavPath, mp3Path)) {
      fs.unlinkSync(wavPath);
      console.log("done (mp3)");
    } else {
      // No MP3 encoder? The WAV file works just as well.
      console.log("done (wav)");
    }
  }

  console.log("\nAll tracks are in the music folder.");
}

main();