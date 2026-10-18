const $ = (id) => document.getElementById(id);

const videoInput = $("videoInput");
const uploadButton = $("uploadButton");
const resultCard = $("resultCard");
const result = $("result");

const reelLength = $("reelLength");
const balance = $("balance");
const balanceValue = $("balanceValue");
const highlightButton = $("highlightButton");
const smartButton = $("smartButton");

const playerCard = $("playerCard");
const player = $("player");

const emptyMoments = $("emptyMoments");
const highlightsCard = $("highlightsCard");
const highlightsList = $("highlightsList");
const reelSummary = $("reelSummary");
const playReelButton = $("playReelButton");
const reviewButton = $("reviewButton");
const directButton = $("directButton");
const reviewHint = $("reviewHint");
const directorHint = $("directorHint");

const audioSuggestion = $("audioSuggestion");
const musicRow = $("musicRow");
const musicSelect = $("musicSelect");
const musicPreview = $("musicPreview");
const levelRow = $("levelRow");
const originalLevel = $("originalLevel");
const originalLevelValue = $("originalLevelValue");
const trackInput = $("trackInput");
const uploadTrackButton = $("uploadTrackButton");
const exportButton = $("exportButton");

const reelCard = $("reelCard");
const reelPlayer = $("reelPlayer");
const downloadLink = $("downloadLink");

let currentFileName = null;
let currentSegments = [];

// The moments the player is currently playing, one after another
let queue = [];
let queueIndex = 0;

// The music tracks the server knows about
let tracks = [];

const MODE_LABELS = {
  music_original: "Music + original sound",
  music_only: "Music only",
  original_only: "Original sound only"
};

const MOOD_ORDER = ["energetic", "upbeat", "calm", "emotional", "funny", "other"];

// 125 seconds -> "2:05"
function formatTime(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : minutes;
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/*
-----------------------------------------
LOCKING: which sections can be used right now?
Every section is always visible. A section is grayed out (and cannot be
clicked) until the things it needs exist.
-----------------------------------------
*/

function updateLocks() {
  const hasVideo = Boolean(currentFileName);
  const hasMoments = currentSegments.length > 0;
  const reviewed = hasMoments && currentSegments.every((s) => s.caption);
  const directed = hasMoments && currentSegments.some((s) => s.effect);
  const exported = !reelCard.hidden;

  const steps = {
    1: { open: true, done: hasVideo, need: "" },
    2: { open: hasVideo, done: hasMoments, need: "Upload a video first." },
    3: { open: hasMoments, done: reviewed, need: "Find highlights first." },
    4: {
      open: reviewed,
      done: directed,
      need: hasMoments
        ? "Run the AI review first (Smart pick already does this)."
        : "Find highlights first."
    },
    5: { open: hasMoments, done: false, need: "Find highlights first." },
    6: { open: hasMoments, done: exported, need: "Find highlights first." }
  };

  Object.entries(steps).forEach(([number, step]) => {
    const section = $("step" + number);
    const navItem = document.querySelector(`.nav-step[data-step="${number}"]`);

    const status = step.open ? (step.done ? "✓ Done" : "Ready") : "🔒 Locked";
    const navText = step.open ? (step.done ? "Done" : "Ready") : "Locked";

    section.classList.toggle("locked", !step.open);
    section.classList.toggle("done", step.open && step.done);
    section.inert = !step.open; // no clicking or tabbing into a locked section

    section.querySelector(".step-status").textContent = status;

    const note = section.querySelector(".lock-note");
    note.hidden = step.open;
    note.textContent = step.open ? "" : "🔒 " + step.need;

    navItem.classList.toggle("locked", !step.open);
    navItem.classList.toggle("done", step.open && step.done);
    navItem.querySelector("small").textContent = navText;
  });

  playerCard.hidden = !hasVideo;
  emptyMoments.hidden = hasMoments;
  highlightsCard.hidden = !hasMoments;
}

/*
-----------------------------------------
PLAYING MOMENTS IN THE PREVIEW
-----------------------------------------
*/

function playSegments(segments) {
  if (!segments.length) return;

  queue = segments;
  queueIndex = 0;

  player.currentTime = queue[0].start;
  player.play().catch(() => {});

  playerCard.scrollIntoView({ behavior: "smooth", block: "center" });
}

// When a moment ends, jump to the next one (or stop)
player.addEventListener("timeupdate", () => {
  if (!queue.length) return;

  const segment = queue[queueIndex];

  if (player.currentTime >= segment.end) {
    queueIndex++;

    if (queueIndex >= queue.length) {
      player.pause();
      queue = [];
      return;
    }

    player.currentTime = queue[queueIndex].start;
  }
});

player.addEventListener("ended", () => {
  queue = [];
});

/*
-----------------------------------------
SHOWING THE HIGHLIGHT LIST
-----------------------------------------
*/

function renderSegments(segments) {
  highlightsList.innerHTML = "";

  segments.forEach((segment, index) => {
    const item = document.createElement("li");

    const left = document.createElement("div");

    const time = document.createElement("span");
    time.className = "segment-time";
    time.textContent =
      `${index + 1}. ${formatTime(segment.start)} – ${formatTime(segment.end)}`;

    const detail = document.createElement("div");
    detail.className = "segment-detail";
    detail.textContent =
      `loudness ${segment.audio} · action ${segment.motion}`;

    left.appendChild(time);
    left.appendChild(detail);

    // What the AI said about this moment (after review or Smart pick)
    if (segment.caption) {
      const ai = document.createElement("div");
      ai.className = "segment-ai";
      ai.textContent =
        `🤖 ${segment.caption}` +
        (segment.excitement ? ` · excitement ${segment.excitement}/10` : "");
      left.appendChild(ai);

      if (segment.reason) {
        const reason = document.createElement("div");
        reason.className = "segment-reason";
        reason.textContent = segment.reason;
        left.appendChild(reason);
      }
    }

    // What the AI director chose
    if (segment.effect) {
      const direction = document.createElement("div");
      direction.className = "segment-direction";

      const effectText =
        segment.effect === "none" ? "no effect" : `${segment.effect} effect`;

      const transitionText =
        index === segments.length - 1
          ? "fades out at the end"
          : `${segment.transition} into the next moment`;

      direction.textContent = `🎬 ${effectText} · ${transitionText}`;
      left.appendChild(direction);
    }

    const score = document.createElement("span");
    score.className = "segment-score";
    score.textContent = segment.score;

    item.appendChild(left);
    item.appendChild(score);

    item.addEventListener("click", () => playSegments([segment]));

    highlightsList.appendChild(item);
  });
}

// New moments arrived (from Find highlights or Smart pick)
function showNewMoments(segments, summary, directorMessage) {
  currentSegments = segments;

  renderSegments(currentSegments);

  reelSummary.textContent = summary;
  reviewHint.textContent = "";
  directorHint.textContent = directorMessage;
  audioSuggestion.hidden = true;

  // The old exported reel no longer matches these moments
  reelCard.hidden = true;

  updateLocks();
}

/*
-----------------------------------------
CONTROLS
-----------------------------------------
*/

balance.addEventListener("input", () => {
  const loud = Number(balance.value);
  balanceValue.textContent = `${loud}% loudness / ${100 - loud}% action`;
});

/*
-----------------------------------------
MUSIC AND SOUND
-----------------------------------------
*/

function getAudioMode() {
  return document.querySelector('input[name="audioMode"]:checked').value;
}

function setAudioMode(mode) {
  const input = document.querySelector(`input[name="audioMode"][value="${mode}"]`);

  if (input) input.checked = true;

  updateAudioControls();
}

// Show only the controls that matter for the chosen mode
function updateAudioControls() {
  const mode = getAudioMode();

  musicRow.hidden = mode === "original_only";
  levelRow.hidden = mode !== "music_original";
}

function levelText(value) {
  const description =
    value <= 20 ? "barely there"
    : value <= 45 ? "quiet background"
    : value <= 70 ? "balanced"
    : "as loud as the music";

  return `${value}% (${description})`;
}

function updateMusicPreview() {
  const track = tracks.find((t) => t.id === musicSelect.value);

  musicPreview.pause();

  if (track) {
    musicPreview.src = track.url;
  } else {
    musicPreview.removeAttribute("src");
  }
}

// Fill the track menu, grouped by mood. Keeps the current choice if it can.
function renderTrackOptions(preferredId) {
  const keep = preferredId || musicSelect.value;

  musicSelect.innerHTML = "";

  if (!tracks.length) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "No tracks yet: run  node make-music.js  or upload your own";
    musicSelect.appendChild(empty);
    updateMusicPreview();
    return;
  }

  [...MOOD_ORDER, "custom"].forEach((mood) => {
    const inGroup = tracks.filter((t) => t.mood === mood);

    if (!inGroup.length) return;

    const group = document.createElement("optgroup");
    group.label = mood === "custom" ? "Your tracks" : mood[0].toUpperCase() + mood.slice(1);

    inGroup.forEach((track) => {
      const option = document.createElement("option");
      option.value = track.id;
      option.textContent = track.name;
      group.appendChild(option);
    });

    musicSelect.appendChild(group);
  });

  // Keep what was chosen, otherwise start with an upbeat track
  const wanted =
    tracks.find((t) => t.id === keep) ||
    tracks.find((t) => t.mood === "upbeat") ||
    tracks[0];

  musicSelect.value = wanted.id;
  updateMusicPreview();
}

async function loadTracks(preferredId) {
  try {
    const response = await fetch("/api/music");
    const data = await response.json();
    tracks = data.tracks || [];
  } catch (error) {
    console.error(error);
    tracks = [];
  }

  renderTrackOptions(preferredId);
}

document.querySelectorAll('input[name="audioMode"]').forEach((input) => {
  input.addEventListener("change", updateAudioControls);
});

musicSelect.addEventListener("change", updateMusicPreview);

originalLevel.addEventListener("input", () => {
  originalLevelValue.textContent = levelText(Number(originalLevel.value));
});

uploadTrackButton.addEventListener("click", async () => {
  const file = trackInput.files[0];

  if (!file) {
    alert("Please choose an audio file first.");
    return;
  }

  uploadTrackButton.disabled = true;
  uploadTrackButton.textContent = "Uploading...";

  const formData = new FormData();
  formData.append("track", file);

  try {
    const response = await fetch("/api/upload-music", {
      method: "POST",
      body: formData
    });

    const data = await response.json();

    if (data.error) {
      alert(data.error);
      return;
    }

    // Reload the list and select the new track
    await loadTracks(data.id);
    trackInput.value = "";

  } catch (error) {
    console.error(error);
    alert("Something went wrong while uploading the track.");
  } finally {
    uploadTrackButton.disabled = false;
    uploadTrackButton.textContent = "⬆ Upload track";
  }
});

/*
-----------------------------------------
UPLOAD
-----------------------------------------
*/

uploadButton.addEventListener("click", async () => {
  const video = videoInput.files[0];

  if (!video) {
    alert("Please choose a video first.");
    return;
  }

  uploadButton.disabled = true;
  uploadButton.textContent = "Uploading...";

  const formData = new FormData();
  formData.append("video", video);

  try {
    const response = await fetch("/api/upload", {
      method: "POST",
      body: formData
    });

    const data = await response.json();

    if (data.error) {
      alert(data.error);
      return;
    }

    currentFileName = data.fileName;

    // Reset anything from a previous video
    queue = [];
    currentSegments = [];
    highlightsList.innerHTML = "";
    reviewHint.textContent = "";
    directorHint.textContent = "";
    audioSuggestion.hidden = true;
    reelCard.hidden = true;

    result.textContent =
`File: ${data.fileName}
Duration: ${data.duration.toFixed(1)} seconds
Resolution: ${data.width} x ${data.height}
Has audio: ${data.hasAudio ? "Yes" : "No"}`;

    resultCard.hidden = false;

    // Load the video into the preview player
    player.src = "/uploads/" + encodeURIComponent(data.fileName);

    updateLocks();

  } catch (error) {
    console.error(error);
    alert("Something went wrong while uploading.");
  } finally {
    uploadButton.disabled = false;
    uploadButton.textContent = "Upload video";
  }
});

/*
-----------------------------------------
FIND HIGHLIGHTS
-----------------------------------------
*/

highlightButton.addEventListener("click", async () => {
  if (!currentFileName) return;

  highlightButton.disabled = true;
  smartButton.disabled = true;
  highlightButton.textContent =
    "✨ Analyzing the video... (the first run takes a while)";

  try {
    const response = await fetch("/api/highlights", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: currentFileName,
        reelLength: Number(reelLength.value),
        audioWeight: Number(balance.value)
      })
    });

    const data = await response.json();

    if (data.error) {
      alert(data.error);
      return;
    }

    showNewMoments(
      data.segments,
      `${data.segments.length} moments, about ` +
        `${data.segments.length * data.segmentLength} seconds in total.`,
      ""
    );

  } catch (error) {
    console.error(error);
    alert("Something went wrong while finding highlights.");
  } finally {
    highlightButton.disabled = false;
    smartButton.disabled = false;
    highlightButton.textContent = "✨ Find highlights";
  }
});

playReelButton.addEventListener("click", () => {
  playSegments(currentSegments);
});

/*
-----------------------------------------
SMART PICK: THE AI HELPS CHOOSE THE MOMENTS
-----------------------------------------
*/

// Check on a long job every second or so, until it is finished
async function waitForJob(jobId, onProgress) {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const response = await fetch("/api/job/" + jobId);
    const job = await response.json();

    // Unknown job, or the job failed
    if (!job.status || job.status === "error") {
      throw new Error(job.error || "Something went wrong.");
    }

    if (job.status === "done") return job.result;

    onProgress(job);
  }
}

smartButton.addEventListener("click", async () => {
  if (!currentFileName) return;

  smartButton.disabled = true;
  highlightButton.disabled = true;
  smartButton.textContent = "🧠 Starting...";

  try {
    const response = await fetch("/api/smart-highlights", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: currentFileName,
        reelLength: Number(reelLength.value),
        audioWeight: Number(balance.value)
      })
    });

    const data = await response.json();

    if (data.error) {
      alert(data.error);
      return;
    }

    const picked = await waitForJob(data.jobId, (job) => {
      smartButton.textContent = job.total
        ? `🧠 The AI is looking at moments ${job.done}/${job.total}...`
        : "🧠 Analyzing the video... (the first run takes a while)";
    });

    // These moments already have the AI's captions, so the director can start right away
    showNewMoments(
      picked.segments,
      `${picked.segments.length} moments chosen by the AI from ` +
        `${picked.candidates} candidates, about ` +
        `${picked.segments.length * picked.segmentLength} seconds in total.`,
      "The AI has already reviewed these moments, so you can go straight to the director."
    );

  } catch (error) {
    console.error(error);
    alert(error.message || "Something went wrong during the smart pick.");
  } finally {
    smartButton.disabled = false;
    highlightButton.disabled = false;
    smartButton.textContent = "🧠 Smart pick: let the AI choose the best moments";
  }
});

/*
-----------------------------------------
AI REVIEW
-----------------------------------------
*/

reviewButton.addEventListener("click", async () => {
  if (!currentFileName || !currentSegments.length) return;

  reviewButton.disabled = true;
  reviewButton.textContent = "🤖 The AI is looking at each moment...";
  reviewHint.textContent =
    "On a laptop without a strong GPU this can take a few minutes. " +
    "Watch the terminal to see its progress.";

  try {
    const response = await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: currentFileName,
        segments: currentSegments.map((s) => ({
          start: s.start,
          end: s.end
        }))
      })
    });

    const data = await response.json();

    if (data.error) {
      alert(data.error);
      reviewHint.textContent = "";
      return;
    }

    // Attach each review to its moment
    data.reviews.forEach((review, index) => {
      if (!currentSegments[index]) return;

      currentSegments[index].caption = review.caption;
      currentSegments[index].excitement = review.excitement;
      currentSegments[index].reason = review.reason;
    });

    renderSegments(currentSegments);
    reviewHint.textContent = "Done. The captions are in the highlight list above.";
    updateLocks();

  } catch (error) {
    console.error(error);
    alert("Something went wrong while asking the AI.");
    reviewHint.textContent = "";
  } finally {
    reviewButton.disabled = false;
    reviewButton.textContent = "🤖 Ask AI to review these moments";
  }
});

/*
-----------------------------------------
AI DIRECTOR: EFFECTS, TRANSITIONS AND MUSIC
-----------------------------------------
*/

directButton.addEventListener("click", async () => {
  if (!currentSegments.length) return;

  // The director decides based on what the AI saw in each moment
  if (currentSegments.some((s) => !s.caption)) {
    alert("Please run the AI review first, so the director knows what happens in each moment.");
    return;
  }

  directButton.disabled = true;
  directButton.textContent = "🎬 The AI is directing...";

  try {
    const response = await fetch("/api/direct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        segments: currentSegments.map((s) => ({
          caption: s.caption,
          excitement: s.excitement
        }))
      })
    });

    const data = await response.json();

    if (data.error) {
      alert(data.error);
      return;
    }

    data.moments.forEach((moment, index) => {
      if (!currentSegments[index]) return;

      currentSegments[index].effect = moment.effect;
      currentSegments[index].transition = moment.transition;
    });

    renderSegments(currentSegments);

    // Fill in the music section with the AI's suggestion
    setAudioMode(data.audioMode);

    const match = tracks.find((t) => t.mood === data.mood);

    if (match) {
      musicSelect.value = match.id;
      updateMusicPreview();
    }

    audioSuggestion.textContent =
      `🤖 AI suggestion: ${MODE_LABELS[data.audioMode]}. ` +
      (data.audioReason ? `${data.audioReason} ` : "") +
      `Mood: ${data.mood}` +
      (match ? `, track: ${match.name}. ` : ". ") +
      "The AI judges from what it sees, not what it hears, so change anything you like.";

    audioSuggestion.hidden = false;

    directorHint.textContent =
      "Effects, transitions and music are ready. " +
      "Check Music & sound (step 5), then export.";

    updateLocks();

  } catch (error) {
    console.error(error);
    alert("Something went wrong while directing.");
  } finally {
    directButton.disabled = false;
    directButton.textContent = "🎬 Let the AI direct effects, transitions & music";
  }
});

/*
-----------------------------------------
EXPORT THE REAL REEL
-----------------------------------------
*/

exportButton.addEventListener("click", async () => {
  if (!currentFileName || !currentSegments.length) return;

  const audioMode = getAudioMode();

  if (audioMode !== "original_only" && !musicSelect.value) {
    alert("Please choose a music track first, or upload your own.");
    return;
  }

  exportButton.disabled = true;
  exportButton.textContent = "💾 Cutting your reel... (this takes a bit longer)";

  try {
    const response = await fetch("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: currentFileName,
        segments: currentSegments.map((s) => ({
          start: s.start,
          end: s.end,
          effect: s.effect,
          transition: s.transition
        })),
        audioMode,
        musicTrack: musicSelect.value,
        originalLevel: Number(originalLevel.value)
      })
    });

    const data = await response.json();

    if (data.error) {
      alert(data.error);
      return;
    }

    reelPlayer.src = data.reelUrl;
    downloadLink.href = data.reelUrl;
    downloadLink.download = data.fileName;

    reelCard.hidden = false;
    updateLocks();
    reelCard.scrollIntoView({ behavior: "smooth", block: "center" });

  } catch (error) {
    console.error(error);
    alert("Something went wrong while cutting the reel.");
  } finally {
    exportButton.disabled = false;
    exportButton.textContent = "💾 Export reel as MP4";
  }
});

/*
-----------------------------------------
START
-----------------------------------------
*/

originalLevelValue.textContent = levelText(Number(originalLevel.value));
updateAudioControls();
loadTracks();
updateLocks();