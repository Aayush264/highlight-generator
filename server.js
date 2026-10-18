const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { execFile, spawn } = require("child_process");
const { Ollama } = require("ollama");

const app = express();
const PORT = 3000;

// The local AI model (change if `ollama list` shows another name)
const VISION_MODEL = "gemma3:4b";

const ollama = new Ollama({ host: "http://127.0.0.1:11434" });

// The menus the AI director may choose from
const EFFECT_NAMES = ["none", "zoom", "vivid", "bw", "warm", "vignette"];

const TRANSITION_NAMES = [
  "fade",
  "dissolve",
  "fadeblack",
  "fadewhite",
  "slideleft",
  "wipeleft",
  "circleopen",
  "pixelize"
];

const MOOD_NAMES = ["energetic", "upbeat", "calm", "emotional", "funny"];

// How the sound of the reel can be built
const AUDIO_MODES = ["music_original", "music_only", "original_only"];

// Where the music lives
const MUSIC_DIR = path.join(__dirname, "music");
const CUSTOM_MUSIC_DIR = path.join(MUSIC_DIR, "custom");
const MUSIC_EXTENSIONS = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"];

// Make sure our folders exist
["uploads", "outputs", "music", "music/custom"].forEach((dir) => {
  fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
});

// Serve the frontend
app.use(express.static(path.join(__dirname, "public")));

// Let the browser play the uploaded videos (for the preview player)
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Let the browser play and download the finished reels
app.use("/outputs", express.static(path.join(__dirname, "outputs")));

// Let the browser play the music tracks (for the preview)
app.use("/music", express.static(MUSIC_DIR));

// Let the server read JSON sent from the browser
app.use(express.json());

// Where uploaded videos are saved
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, "uploads"));
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, Date.now() + "-" + safeName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 * 1024 } // 4 GB
});

// Turn a file name from the browser into a safe path inside uploads/
function getUploadPath(fileName) {
  if (!fileName) return null;

  // path.basename stops anyone from asking for files outside uploads/
  const filePath = path.join(__dirname, "uploads", path.basename(fileName));

  return fs.existsSync(filePath) ? filePath : null;
}

// Ask ffprobe for information about a video
function probeVideo(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      [
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        filePath
      ],
      (error, stdout) => {
        if (error) return reject(error);
        resolve(JSON.parse(stdout));
      }
    );
  });
}

// Upload endpoint
app.post("/api/upload", upload.single("video"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No video uploaded." });
  }

  try {
    const info = await probeVideo(req.file.path);

    const video = info.streams.find((s) => s.codec_type === "video");
    const audio = info.streams.find((s) => s.codec_type === "audio");

    if (!video) {
      return res
        .status(400)
        .json({ error: "This file doesn't contain a video." });
    }

    res.json({
      fileName: req.file.filename,
      duration: Number(info.format.duration),
      width: video.width,
      height: video.height,
      hasAudio: Boolean(audio)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Could not read this video. Is ffprobe installed?"
    });
  }
});

/*
-----------------------------------------
SIGNAL 1: AUDIO LOUDNESS (one number per second)
-----------------------------------------
*/

function analyzeAudio(filePath) {
  return new Promise((resolve, reject) => {
    const SAMPLE_RATE = 8000;
    const BYTES_PER_SECOND = SAMPLE_RATE * 2; // 16-bit audio = 2 bytes per sample

    // Ask FFmpeg to give us the audio as raw mono samples
    const ffmpeg = spawn("ffmpeg", [
      "-v", "error",
      "-i", filePath,
      "-vn",
      "-ac", "1",
      "-ar", String(SAMPLE_RATE),
      "-f", "s16le",
      "pipe:1"
    ]);

    const loudness = [];
    let leftover = Buffer.alloc(0);

    ffmpeg.stdout.on("data", (chunk) => {
      const data = Buffer.concat([leftover, chunk]);
      let offset = 0;

      // Every full second of audio becomes one loudness number
      while (data.length - offset >= BYTES_PER_SECOND) {
        let sumSquares = 0;

        for (let i = 0; i < BYTES_PER_SECOND; i += 2) {
          const sample = data.readInt16LE(offset + i) / 32768;
          sumSquares += sample * sample;
        }

        loudness.push(Math.sqrt(sumSquares / SAMPLE_RATE));
        offset += BYTES_PER_SECOND;
      }

      leftover = data.subarray(offset);
    });

    ffmpeg.stderr.on("data", (d) => console.error(d.toString()));

    ffmpeg.on("error", reject);

    ffmpeg.on("close", (code) => {
      if (code === 0) resolve(loudness);
      else reject(new Error("FFmpeg exited with code " + code));
    });
  });
}

/*
-----------------------------------------
SIGNAL 2: MOTION (one number per second)
-----------------------------------------
*/

function analyzeMotion(filePath) {
  return new Promise((resolve, reject) => {
    const FPS = 5; // look at 5 frames per second
    const WIDTH = 64; // shrink every frame to 64 x 36 pixels
    const HEIGHT = 36;
    const FRAME_SIZE = WIDTH * HEIGHT; // grayscale = 1 byte per pixel

    // Ask FFmpeg for tiny grayscale frames
    const ffmpeg = spawn("ffmpeg", [
      "-v", "error",
      "-i", filePath,
      "-an",
      "-vf", `fps=${FPS},scale=${WIDTH}:${HEIGHT},format=gray`,
      "-f", "rawvideo",
      "pipe:1"
    ]);

    const motion = [];
    let leftover = Buffer.alloc(0);
    let previousFrame = null;
    let frameCount = 0;
    let secondSum = 0;
    let secondComparisons = 0;

    ffmpeg.stdout.on("data", (chunk) => {
      const data = Buffer.concat([leftover, chunk]);
      let offset = 0;

      while (data.length - offset >= FRAME_SIZE) {
        const frame = data.subarray(offset, offset + FRAME_SIZE);
        offset += FRAME_SIZE;

        // How different is this frame from the one before it?
        if (previousFrame) {
          let difference = 0;

          for (let i = 0; i < FRAME_SIZE; i++) {
            difference += Math.abs(frame[i] - previousFrame[i]);
          }

          secondSum += difference / FRAME_SIZE;
          secondComparisons++;
        }

        previousFrame = Buffer.from(frame); // keep a copy
        frameCount++;

        // Every FPS frames = one second of video = one motion number
        if (frameCount % FPS === 0) {
          motion.push(secondComparisons ? secondSum / secondComparisons : 0);
          secondSum = 0;
          secondComparisons = 0;
        }
      }

      leftover = data.subarray(offset);
    });

    ffmpeg.stderr.on("data", (d) => console.error(d.toString()));

    ffmpeg.on("error", reject);

    ffmpeg.on("close", (code) => {
      if (code === 0) resolve(motion);
      else reject(new Error("FFmpeg exited with code " + code));
    });
  });
}

/*
-----------------------------------------
STEP 4: TURN THE SIGNALS INTO HIGHLIGHTS
-----------------------------------------
*/

// Remember the slow analysis so moving the slider is instant
const analysisCache = new Map();

async function getAnalysis(filePath, fileName) {
  if (analysisCache.has(fileName)) {
    return analysisCache.get(fileName);
  }

  const [loudness, motion] = await Promise.all([
    // A video with no audio shouldn't crash everything
    analyzeAudio(filePath).catch((error) => {
      console.error("Audio analysis failed:", error.message);
      return [];
    }),
    analyzeMotion(filePath)
  ]);

  const analysis = { loudness, motion };
  analysisCache.set(fileName, analysis);
  return analysis;
}

// Smooth a signal by averaging each second with its neighbours
function smooth(values, radius) {
  return values.map((_, i) => {
    const start = Math.max(0, i - radius);
    const end = Math.min(values.length - 1, i + radius);
    let sum = 0;

    for (let j = start; j <= end; j++) sum += values[j];

    return sum / (end - start + 1);
  });
}

// How much does each second stand out from the seconds around it?
function spikeScore(values, radius) {
  const prefix = [0];

  for (const v of values) {
    prefix.push(prefix[prefix.length - 1] + v);
  }

  return values.map((v, i) => {
    const start = Math.max(0, i - radius);
    const end = Math.min(values.length - 1, i + radius);
    const average = (prefix[end + 1] - prefix[start]) / (end - start + 1);
    return v - average;
  });
}

// Turn numbers into 0..1 ranks, so one extreme value can't dominate
function toPercentiles(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);

  // A signal that never changes (like missing audio) gets no say
  if (!values.length || max - min < 1e-9) {
    return values.map(() => 0);
  }

  const order = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);

  const result = new Array(values.length);

  order.forEach((item, rank) => {
    result[item.index] = rank / (values.length - 1);
  });

  return result;
}

// One score from 0 to 1 for every second of the video
function buildScores(loudness, motion, audioWeight) {
  const total = Math.max(loudness.length, motion.length);

  const decibels = Array.from({ length: total }, (_, i) =>
    20 * Math.log10((loudness[i] ?? 0) + 1e-6)
  );

  const activity = Array.from({ length: total }, (_, i) => motion[i] ?? 0);

  // Compare each second with the 30 seconds before and after it
  const audioPct = toPercentiles(spikeScore(smooth(decibels, 1), 30));
  const motionPct = toPercentiles(spikeScore(smooth(activity, 1), 30));

  const score = audioPct.map(
    (a, i) => audioWeight * a + (1 - audioWeight) * motionPct[i]
  );

  return { score, audioPct, motionPct };
}

// Slide a window over the video and keep the best, non-overlapping ones
function pickSegments(score, segmentLength, count, minGap) {
  const windows = [];

  for (let start = 0; start + segmentLength <= score.length; start++) {
    let sum = 0;

    for (let i = start; i < start + segmentLength; i++) sum += score[i];

    windows.push({ start, value: sum / segmentLength });
  }

  windows.sort((a, b) => b.value - a.value);

  const picked = [];

  for (const window of windows) {
    const farEnough = picked.every(
      (p) => Math.abs(p.start - window.start) >= minGap
    );

    if (farEnough) {
      picked.push(window);
      if (picked.length === count) break;
    }
  }

  return picked.sort((a, b) => a.start - b.start);
}

function average(values, start, length) {
  let sum = 0;

  for (let i = start; i < start + length; i++) sum += values[i];

  return sum / length;
}

// Highlights endpoint
app.post("/api/highlights", async (req, res) => {
  const filePath = getUploadPath(req.body.fileName);

  if (!filePath) {
    return res.status(404).json({ error: "Video not found." });
  }

  // How long should the reel be, and how much should loudness count?
  const reelLength = Math.min(
    Math.max(Number(req.body.reelLength) || 60, 10),
    300
  );

  const audioWeight =
    Math.min(Math.max(Number(req.body.audioWeight ?? 50), 0), 100) / 100;

  try {
    const { loudness, motion } = await getAnalysis(filePath, req.body.fileName);

    const { score, audioPct, motionPct } = buildScores(
      loudness,
      motion,
      audioWeight
    );

    const SEGMENT_LENGTH = 6;
    const count = Math.max(1, Math.round(reelLength / SEGMENT_LENGTH));

    // Spread the moments out, but not so far apart that short videos run out
    const minGap = Math.max(
      SEGMENT_LENGTH,
      Math.min(20, Math.floor(score.length / (count * 2)))
    );

    const picked = pickSegments(score, SEGMENT_LENGTH, count, minGap);

    const segments = picked.map((p) => ({
      start: p.start,
      end: p.start + SEGMENT_LENGTH,
      score: Math.round(p.value * 100),
      audio: Math.round(average(audioPct, p.start, SEGMENT_LENGTH) * 100),
      motion: Math.round(average(motionPct, p.start, SEGMENT_LENGTH) * 100)
    }));

    res.json({
      totalSeconds: score.length,
      segmentLength: SEGMENT_LENGTH,
      segments
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not analyze the video." });
  }
});

/*
-----------------------------------------
SHARED HELPERS FOR MOMENTS AND OLLAMA
-----------------------------------------
*/

// Keep only sensible moments from the browser (max 60, each 1 to 30 seconds).
// Effects and transitions must come from our menus, otherwise defaults are used.
function cleanSegments(rawSegments) {
  return (Array.isArray(rawSegments) ? rawSegments : [])
    .slice(0, 60)
    .map((s) => ({
      start: Number(s.start),
      end: Number(s.end),
      effect: EFFECT_NAMES.includes(s.effect) ? s.effect : "none",
      transition: TRANSITION_NAMES.includes(s.transition) ? s.transition : "fade"
    }))
    .filter(
      (s) =>
        Number.isFinite(s.start) &&
        Number.isFinite(s.end) &&
        s.start >= 0 &&
        s.end - s.start >= 1 &&
        s.end - s.start <= 30
    );
}

// A friendly message for when the AI can't be reached
function ollamaErrorMessage(error) {
  const message = String(error.message || "");

  return message.includes("not found")
    ? `The model "${VISION_MODEL}" isn't installed. Run: ollama pull ${VISION_MODEL}`
    : "Could not get an answer from Ollama. Is the Ollama app running?";
}

/*
-----------------------------------------
STEP 8: THE MUSIC LIBRARY
-----------------------------------------
*/

// "energetic-1" -> "Energetic 1"
function prettyName(base) {
  return base
    .replace(/^\d+-/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

// Every track in the music folder (ours) and in music/custom (the creator's)
function listTracks() {
  const readFolder = (dir, prefix, custom) => {
    if (!fs.existsSync(dir)) return [];

    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          MUSIC_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())
      )
      .map((entry) => {
        const base = path.basename(entry.name, path.extname(entry.name));
        const moodGuess = base.split("-")[0];

        return {
          id: prefix + entry.name,
          name: prettyName(base),
          mood: custom
            ? "custom"
            : MOOD_NAMES.includes(moodGuess)
              ? moodGuess
              : "other",
          custom,
          url: "/music/" + prefix + encodeURIComponent(entry.name)
        };
      });
  };

  return [
    ...readFolder(MUSIC_DIR, "", false),
    ...readFolder(CUSTOM_MUSIC_DIR, "custom/", true)
  ];
}

// Turn a track id from the browser into a safe file path
function getTrackPath(id) {
  const track = listTracks().find((t) => t.id === id);

  if (!track) return null;

  return track.custom
    ? path.join(CUSTOM_MUSIC_DIR, path.basename(track.id))
    : path.join(MUSIC_DIR, track.id);
}

app.get("/api/music", (req, res) => {
  res.json({ tracks: listTracks() });
});

// Where creators' own tracks are saved
const musicStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, CUSTOM_MUSIC_DIR);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, Date.now() + "-" + safeName);
  }
});

const uploadMusic = multer({
  storage: musicStorage,
  limits: { fileSize: 60 * 1024 * 1024 }, // 60 MB
  fileFilter: (req, file, cb) => {
    cb(null, MUSIC_EXTENSIONS.includes(path.extname(file.originalname).toLowerCase()));
  }
});

app.post("/api/upload-music", (req, res) => {
  uploadMusic.single("track")(req, res, async (uploadError) => {
    if (uploadError) {
      return res.status(400).json({
        error: "That file couldn't be uploaded. Music files must be under 60 MB."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "Please choose an audio file (MP3, WAV, M4A, AAC, OGG or FLAC)."
      });
    }

    try {
      // Make sure it really is audio, and long enough to be useful
      const info = await probeVideo(req.file.path);
      const hasAudio = info.streams.some((s) => s.codec_type === "audio");
      const duration = Number(info.format.duration);

      if (!hasAudio || !(duration >= 3)) {
        fs.unlinkSync(req.file.path);

        return res.status(400).json({
          error: "That doesn't look like a usable audio file (it must be at least 3 seconds long)."
        });
      }

      res.json({ id: "custom/" + req.file.filename });
    } catch (error) {
      console.error(error);

      fs.rmSync(req.file.path, { force: true });

      res.status(400).json({ error: "Could not read that audio file." });
    }
  });
});

/*
-----------------------------------------
STEP 5 + 7 + 8: CUT THE REAL REEL
(effects, transitions, and the sound mix)
-----------------------------------------
*/

// Run FFmpeg and wait until it finishes
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          console.error(stderr);
          return reject(error);
        }
        resolve();
      }
    );
  });
}

// How long is a video file, in seconds?
function getDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "csv=p=0",
        filePath
      ],
      (error, stdout) => {
        if (error) return reject(error);
        resolve(Number(stdout.trim()));
      }
    );
  });
}

// How loud is this stretch of audio on average? (in dB, closer to 0 = louder)
function measureMeanVolume(filePath, start, duration) {
  return new Promise((resolve) => {
    const args = ["-hide_banner", "-nostats"];

    if (start !== undefined) args.push("-ss", String(start));

    args.push("-i", filePath);

    if (duration !== undefined) args.push("-t", String(duration));

    args.push("-vn", "-af", "volumedetect", "-f", "null", "-");

    execFile(
      "ffmpeg",
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(String(stderr));
        resolve(match ? Number(match[1]) : null);
      }
    );
  });
}

// How many dB to add or remove to reach the target loudness (with safe limits)
function gainFor(meanDb, targetDb, minGain, maxGain) {
  // Silence, or nothing measurable: leave it alone
  if (meanDb === null || meanDb < -60) return 0;

  return Math.min(maxGain, Math.max(minGain, targetDb - meanDb));
}

// Work out the size every clip will have, and whether there is audio
async function getVideoSetup(filePath) {
  const info = await probeVideo(filePath);
  const video = info.streams.find((s) => s.codec_type === "video");

  let width = video.width;
  let height = video.height;

  // Phone videos can be stored sideways with a "rotate" note
  const rotation = Math.abs(
    Number(
      (video.side_data_list || [])
        .map((d) => d.rotation)
        .find((r) => r !== undefined) ??
        (video.tags && video.tags.rotate) ??
        0
    )
  );

  if (rotation === 90 || rotation === 270) {
    [width, height] = [height, width];
  }

  // Keep the long side at 1280 pixels or less so rendering stays quick
  const shrink = Math.min(1, 1280 / Math.max(width, height));
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);

  return {
    width: even(width * shrink),
    height: even(height * shrink),
    hasAudio: info.streams.some((s) => s.codec_type === "audio")
  };
}

// The FFmpeg filter for each effect on the menu
function effectFilter(effect, width, height) {
  switch (effect) {
    case "zoom":
      return `crop=iw/1.15:ih/1.15,scale=${width}:${height}`;
    case "vivid":
      return "eq=saturation=1.35:contrast=1.08";
    case "bw":
      return "hue=s=0,eq=contrast=1.1";
    case "warm":
      return "colorbalance=rs=0.10:rm=0.08:bs=-0.10:bm=-0.08";
    case "vignette":
      return "vignette=PI/4";
    default:
      return "";
  }
}

app.post("/api/render", async (req, res) => {
  const filePath = getUploadPath(req.body.fileName);

  if (!filePath) {
    return res.status(404).json({ error: "Video not found." });
  }

  const segments = cleanSegments(req.body.segments);

  if (segments.length === 0) {
    return res.status(400).json({ error: "No moments to cut." });
  }

  // How should the reel sound?
  const audioMode = AUDIO_MODES.includes(req.body.audioMode)
    ? req.body.audioMode
    : "original_only";

  const needMusic = audioMode !== "original_only";
  const needOriginal = audioMode !== "music_only";

  let musicPath = null;

  if (needMusic) {
    musicPath = getTrackPath(req.body.musicTrack);

    if (!musicPath) {
      return res.status(400).json({
        error: "Please choose a music track first."
      });
    }
  }

  // 0 = original sound as loud as the music, 100 = same, lower = quieter
  const originalLevel = Math.min(
    Math.max(Number(req.body.originalLevel ?? 50), 0),
    100
  );

  const id = Date.now();
  const reelName = `reel-${id}.mp4`;
  const reelPath = path.join(__dirname, "outputs", reelName);
  const tempDir = path.join(__dirname, "outputs", `tmp-${id}`);

  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const { width, height, hasAudio } = await getVideoSetup(filePath);

    // 1. Cut every moment into its own clip, with its effect applied
    //    and its sound brought to the same loudness as the other clips
    const clipPaths = [];

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const clipPath = path.join(tempDir, `clip${i}.mp4`);
      const length = segment.end - segment.start;

      const effect = effectFilter(segment.effect, width, height);

      const videoFilter = [
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
        "setsar=1",
        "fps=30",
        "format=yuv420p",
        effect,
        "setsar=1",
        "format=yuv420p"
      ]
        .filter(Boolean)
        .join(",");

      // Quiet clips get lifted and loud clips get lowered, so none stands out
      let audioFilter = "anull";

      if (hasAudio && needOriginal) {
        const mean = await measureMeanVolume(filePath, segment.start, length);
        const gain = gainFor(mean, -20, -12, 15);

        audioFilter = `volume=${gain.toFixed(1)}dB,alimiter=limit=0.95`;
      }

      const args = [
        "-y",
        "-v", "error",
        "-ss", String(segment.start),
        "-i", filePath
      ];

      // A video without sound gets a silent track so every clip matches
      if (!hasAudio) {
        args.push(
          "-f", "lavfi",
          "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"
        );
      }

      args.push(
        "-t", String(length),
        "-map", "0:v:0",
        "-map", hasAudio ? "0:a:0" : "1:a:0",
        "-vf", videoFilter,
        "-af", audioFilter,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "160k",
        "-ar", "44100",
        "-ac", "2",
        clipPath
      );

      await runFFmpeg(args);
      clipPaths.push(clipPath);
    }

    // 2. Measure the real length of every clip
    const durations = [];

    for (const clipPath of clipPaths) {
      durations.push(await getDuration(clipPath));
    }

    // 3. Join the clips with transitions
    const fade = Math.min(0.5, Math.max(0.1, Math.min(...durations) / 3));

    const filters = [];

    // Make sure every clip has the same timing format
    clipPaths.forEach((_, i) => {
      filters.push(`[${i}:v]settb=AVTB,fps=30,format=yuv420p[p${i}v]`);
    });

    let videoLabel = "[p0v]";
    let audioLabel = "[0:a]";
    let timeline = durations[0];

    for (let k = 1; k < clipPaths.length; k++) {
      const offset = (timeline - fade).toFixed(3);

      filters.push(
        `${videoLabel}[p${k}v]xfade=transition=${segments[k - 1].transition}` +
          `:duration=${fade}:offset=${offset}[v${k}]`
      );

      videoLabel = `[v${k}]`;

      if (needOriginal) {
        filters.push(`${audioLabel}[${k}:a]acrossfade=d=${fade}[a${k}]`);
        audioLabel = `[a${k}]`;
      }

      timeline = timeline + durations[k] - fade;
    }

    // Fade the whole reel in at the start and out at the end
    const videoFadeOut = Math.max(0, timeline - 0.8).toFixed(3);
    const audioFadeOut = Math.max(0, timeline - 1.5).toFixed(3);

    filters.push(
      `${videoLabel}fade=t=in:st=0:d=0.5,fade=t=out:st=${videoFadeOut}:d=0.8[vout]`
    );

    // 4. Build the sound
    const audioFades = `afade=t=in:st=0:d=0.5,afade=t=out:st=${audioFadeOut}:d=1.5`;

    if (needMusic) {
      // Bring the music to a steady loudness, and make it exactly as long as the reel
      const musicMean = await measureMeanVolume(musicPath, 0, 60);
      const musicTarget = audioMode === "music_only" ? -19 : -20;
      const musicGain = gainFor(musicMean, musicTarget, -20, 20);

      filters.push(
        `[${clipPaths.length}:a]aresample=44100,` +
          `aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `volume=${musicGain.toFixed(1)}dB,` +
          `atrim=0:${timeline.toFixed(3)},asetpts=PTS-STARTPTS[music]`
      );
    }

    if (audioMode === "original_only") {
      filters.push(`${audioLabel}${audioFades}[aout]`);
    } else if (audioMode === "music_only") {
      filters.push(`[music]alimiter=limit=0.89,${audioFades}[aout]`);
    } else {
      // Original sound sits underneath the music. At 100 it is as loud as the
      // music, and every 10 steps lower makes it about 1.6 dB quieter.
      const originalDrop = -((100 - originalLevel) / 100) * 16;

      filters.push(
        `${audioLabel}volume=${originalDrop.toFixed(1)}dB,asplit=2[o1][o2]`
      );

      // The music dips a little whenever the original sound gets loud
      filters.push(
        `[music][o2]sidechaincompress=threshold=0.05:ratio=3:attack=30:release=600[ducked]`
      );

      filters.push(
        `[ducked][o1]amix=inputs=2:duration=longest:normalize=0,` +
          `alimiter=limit=0.89,${audioFades}[aout]`
      );
    }

    const inputs = clipPaths.flatMap((clipPath) => ["-i", clipPath]);

    // The music track repeats if it is shorter than the reel
    if (needMusic) {
      inputs.push("-stream_loop", "-1", "-i", musicPath);
    }

    await runFFmpeg([
      "-y",
      "-v", "error",
      ...inputs,
      "-filter_complex", filters.join(";"),
      "-map", "[vout]",
      "-map", "[aout]",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-r", "30",
      "-c:a", "aac",
      "-b:a", "160k",
      "-movflags", "+faststart",
      reelPath
    ]);

    res.json({
      reelUrl: "/outputs/" + reelName,
      fileName: reelName,
      clips: segments.length,
      seconds: Math.round(timeline)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not cut the reel. Check the terminal." });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

/*
-----------------------------------------
STEP 6: LET THE AI LOOK AT EACH MOMENT
-----------------------------------------
*/

// Grab one small JPEG frame from the video at a given second
function extractFrame(filePath, second) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-v", "error",
        "-ss", String(second),
        "-i", filePath,
        "-frames:v", "1",
        "-vf", "scale=640:-2",
        "-q:v", "4",
        "-f", "image2pipe",
        "-vcodec", "mjpeg",
        "pipe:1"
      ],
      { encoding: "buffer", maxBuffer: 20 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return reject(error);
        resolve(stdout);
      }
    );
  });
}

const REVIEW_PROMPT = `You are helping edit a highlight reel from a video of an event
(a party, trip, fest, gathering, game, or similar). Look at this single frame.

Reply with JSON only, in exactly this shape:
{"caption": "...", "excitement": 5, "reason": "..."}

- caption: at most 8 words describing what is happening. No hashtags.
- excitement: a whole number from 1 to 10.
  1 = boring (empty room, blank or black screen, credits, text only, someone looking away).
  10 = a great moment (celebration, dancing, action, big reaction, a performance).
- reason: one short sentence explaining the score.

Describe only what you can actually see.`;

// Turn the model's answer into clean data, even if it answered badly
function parseReview(text) {
  try {
    const data = JSON.parse(text);
    const excitement = Math.round(Number(data.excitement));

    return {
      caption: String(data.caption || "").trim().slice(0, 80) || "Unclear moment",
      excitement: Number.isFinite(excitement)
        ? Math.min(10, Math.max(1, excitement))
        : null,
      reason: String(data.reason || "").trim().slice(0, 160)
    };
  } catch (error) {
    return { caption: "Unclear moment", excitement: null, reason: "" };
  }
}

// Remember what the AI said about each moment, so nothing is reviewed twice
const reviewCache = new Map();

async function reviewMoment(filePath, fileName, segment) {
  const key = `${fileName}:${segment.start}-${segment.end}`;

  if (reviewCache.has(key)) return reviewCache.get(key);

  const middle = Math.floor((segment.start + segment.end) / 2);
  const frame = await extractFrame(filePath, middle);

  const response = await ollama.chat({
    model: VISION_MODEL,
    format: "json",
    options: { temperature: 0.2 },
    messages: [
      {
        role: "user",
        content: REVIEW_PROMPT,
        images: [frame.toString("base64")]
      }
    ]
  });

  const review = parseReview(response.message.content);

  reviewCache.set(key, review);

  return review;
}

app.post("/api/review", async (req, res) => {
  const filePath = getUploadPath(req.body.fileName);

  if (!filePath) {
    return res.status(404).json({ error: "Video not found." });
  }

  // Up to 30 moments (a 90 second reel has 15)
  const segments = cleanSegments(req.body.segments).slice(0, 30);

  if (segments.length === 0) {
    return res.status(400).json({ error: "No moments to review." });
  }

  try {
    const reviews = [];

    for (const segment of segments) {
      reviews.push(await reviewMoment(filePath, req.body.fileName, segment));

      console.log(
        `Reviewed ${reviews.length}/${segments.length}:`,
        reviews[reviews.length - 1].caption
      );
    }

    res.json({ reviews });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: ollamaErrorMessage(error) });
  }
});

/*
-----------------------------------------
STEP 9: SMART PICK
The maths finds twice as many candidates as the reel needs,
the AI looks at every one, and the best are kept.
-----------------------------------------
*/

// Long jobs report their progress here, and the browser checks on them
const jobs = new Map();

function createJob() {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const job = {
    id,
    status: "running",
    message: "Starting...",
    done: 0,
    total: 0,
    result: null,
    error: null
  };

  jobs.set(id, job);

  // Keep only the 20 most recent jobs
  while (jobs.size > 20) {
    jobs.delete(jobs.keys().next().value);
  }

  return job;
}

app.get("/api/job/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({ error: "That job no longer exists. Please try again." });
  }

  res.json(job);
});

// Blend the maths score with the AI's excitement rating and keep the best
function chooseBest(candidates, count) {
  const rated = candidates.map((c) => ({
    ...c,
    combined: 0.5 * c.algo + 0.5 * (((c.review.excitement ?? 5) - 1) / 9)
  }));

  // Moments the AI found boring are left out, as long as enough others remain
  const keepers = rated.filter((c) => (c.review.excitement ?? 5) > 3);
  const pool = keepers.length >= count ? keepers : rated;

  return pool
    .sort((a, b) => b.combined - a.combined)
    .slice(0, count)
    .sort((a, b) => a.start - b.start);
}

app.post("/api/smart-highlights", (req, res) => {
  const fileName = req.body.fileName;
  const filePath = getUploadPath(fileName);

  if (!filePath) {
    return res.status(404).json({ error: "Video not found." });
  }

  const reelLength = Math.min(
    Math.max(Number(req.body.reelLength) || 60, 10),
    300
  );

  const audioWeight =
    Math.min(Math.max(Number(req.body.audioWeight ?? 50), 0), 100) / 100;

  const job = createJob();

  // Answer straight away; the work continues in the background
  res.json({ jobId: job.id });

  (async () => {
    let phase = "analysis";

    try {
      job.message = "Listening to the video and watching for motion...";

      const { loudness, motion } = await getAnalysis(filePath, fileName);

      const { score, audioPct, motionPct } = buildScores(
        loudness,
        motion,
        audioWeight
      );

      const SEGMENT_LENGTH = 6;
      const count = Math.max(1, Math.round(reelLength / SEGMENT_LENGTH));

      // Twice as many candidates as the reel needs (at most 24)
      const wanted = Math.min(count * 2, 24);

      const minGap = Math.max(
        SEGMENT_LENGTH,
        Math.min(20, Math.floor(score.length / (wanted * 2)))
      );

      const picked = pickSegments(score, SEGMENT_LENGTH, wanted, minGap);

      job.total = picked.length;
      job.message = "The AI is looking at the candidate moments...";
      phase = "review";

      const candidates = [];

      for (const p of picked) {
        const segment = { start: p.start, end: p.start + SEGMENT_LENGTH };
        const review = await reviewMoment(filePath, fileName, segment);

        candidates.push({
          start: segment.start,
          end: segment.end,
          algo: p.value,
          audio: Math.round(average(audioPct, p.start, SEGMENT_LENGTH) * 100),
          motion: Math.round(average(motionPct, p.start, SEGMENT_LENGTH) * 100),
          review
        });

        job.done++;

        console.log(
          `Smart pick ${job.done}/${job.total}: ${review.caption} (${review.excitement}/10)`
        );
      }

      const best = chooseBest(candidates, count);

      job.result = {
        totalSeconds: score.length,
        segmentLength: SEGMENT_LENGTH,
        candidates: candidates.length,
        segments: best.map((c) => ({
          start: c.start,
          end: c.end,
          score: Math.round(c.combined * 100),
          audio: c.audio,
          motion: c.motion,
          caption: c.review.caption,
          excitement: c.review.excitement,
          reason: c.review.reason
        }))
      };

      job.status = "done";
      job.message = "Done";
    } catch (error) {
      console.error(error);

      job.status = "error";
      job.error =
        phase === "review"
          ? ollamaErrorMessage(error)
          : "Could not analyze the video.";
    }
  })();
});

/*
-----------------------------------------
STEP 7 + 8: THE AI DIRECTOR
(effects, transitions, mood, and a sound suggestion)
-----------------------------------------
*/

// Check the director's answer against our menus and fill any gaps
function parseDirection(text, moments) {
  let data = {};

  try {
    data = JSON.parse(text);
  } catch (error) {
    data = {};
  }

  const mood = MOOD_NAMES.includes(data.mood) ? data.mood : "upbeat";

  // When in doubt, keep the real sound of the event quietly under the music
  const audioMode = AUDIO_MODES.includes(data.audioMode)
    ? data.audioMode
    : "music_original";

  const audioReason = String(data.audioReason || "").trim().slice(0, 140);

  const raw = Array.isArray(data.moments) ? data.moments : [];

  const directed = moments.map((_, i) => ({
    effect: EFFECT_NAMES.includes(raw[i] && raw[i].effect)
      ? raw[i].effect
      : "none",
    transition: TRANSITION_NAMES.includes(raw[i] && raw[i].transition)
      ? raw[i].transition
      : "fade"
  }));

  // Too many effects look messy: keep them on the most exciting moments only
  const maxEffects = Math.ceil(moments.length / 3);

  directed
    .map((d, i) => ({ i, excitement: moments[i].excitement || 0 }))
    .filter((x) => directed[x.i].effect !== "none")
    .sort((a, b) => b.excitement - a.excitement)
    .slice(maxEffects)
    .forEach((x) => {
      directed[x.i].effect = "none";
    });

  // The reel always ends with a fade
  directed[directed.length - 1].transition = "fade";

  return { mood, audioMode, audioReason, moments: directed };
}

app.post("/api/direct", async (req, res) => {
  const moments = (Array.isArray(req.body.segments) ? req.body.segments : [])
    .slice(0, 30)
    .map((s) => ({
      caption: String(s.caption || "").trim().slice(0, 80),
      excitement: Number(s.excitement) || null
    }));

  if (moments.length === 0 || moments.some((m) => !m.caption)) {
    return res.status(400).json({
      error:
        "Run the AI review first, so the director knows what happens in each moment."
    });
  }

  const list = moments
    .map(
      (m, i) =>
        `${i + 1}. ${m.caption}` +
        (m.excitement ? ` (excitement ${m.excitement}/10)` : "")
    )
    .join("\n");

  const prompt = `You are the film editor for a highlight reel made from a video of an event.
These are the moments, in order. The descriptions come from single frames,
so you cannot hear the video:

${list}

Choose how to style the reel. Reply with JSON only, in exactly this shape:
{"mood": "upbeat", "audioMode": "music_original", "audioReason": "...", "moments": [{"effect": "none", "transition": "fade"}]}

Rules:
- mood: one of ${MOOD_NAMES.join(", ")}. This picks the background music.
- audioMode: one of ${AUDIO_MODES.join(", ")}.
  music_original = music with the real sound of the event quietly underneath (cheers, laughter, voices). This is the safe default.
  music_only = choose this if the moments look like people talking, speeches, interviews, presentations or screens, because cut-up speech sounds messy.
  original_only = choose this only if the real sound clearly matters most, such as a live performance.
- audioReason: one short sentence explaining the audioMode choice.
- moments: exactly ${moments.length} entries, one per moment, in the same order.
- effect: one of ${EFFECT_NAMES.join(", ")}.
  Use "none" for most moments (at most one moment in three gets an effect).
  zoom suits a punchy or surprising moment.
  vivid suits colourful, joyful or party scenes.
  warm suits friendly, cosy or emotional scenes.
  vignette suits calm moments.
  bw only for a dramatic or nostalgic moment.
- transition: how this moment connects to the NEXT one. One of ${TRANSITION_NAMES.join(", ")}.
  Prefer fade or dissolve for calm moments, and slideleft, circleopen or fadewhite for energetic ones.
  Do not use the same transition every time. For the last moment use fade.`;

  try {
    const response = await ollama.chat({
      model: VISION_MODEL,
      format: "json",
      options: { temperature: 0.4 },
      messages: [{ role: "user", content: prompt }]
    });

    const direction = parseDirection(response.message.content, moments);

    console.log(
      "Director chose mood:",
      direction.mood,
      "| sound:",
      direction.audioMode
    );

    res.json(direction);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: ollamaErrorMessage(error) });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});