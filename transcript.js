(function () {
  "use strict";

  // One-click transcript on /watch pages: mute, enable the original-language captions,
  // reuse the player's own caption request, download a timestamped .txt, restore the player.
  // Every step logs to the console with this prefix, so a YouTube change is easy to locate.
  const LOG = "[WLQA transcript]";
  const VERSION = "1.1.0";
  const BUTTON_CLASS = "wlqa-transcript-button";
  const GROUP_SECONDS = 15;
  // Player control containers, newest layout first. YouTube renames these from time to time.
  const CONTROL_SELECTORS = [".ytp-right-controls-left", ".ytp-right-controls"];
  const ICON =
    "M4 5h16a2 2 0 0 1 2 2v7h-2V7H4v10h7v2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm2 4h5v1.5H7.5v3H11V15H6V9Zm6 0h5v1.5h-3.5v3H17V15h-5V9Zm6 7h2v3h2l-3 3-3-3h2v-3Z";

  let running = false;
  let warnedNoControls = false;
  let refreshQueued = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const info = (step, data) => console.info(LOG, step, data === undefined ? "" : data);

  class StepError extends Error {
    constructor(step, message, hint) {
      super(message);
      this.step = step;
      this.hint = hint || "";
    }
  }

  function baseLang(code) {
    return String(code || "").split(/[.-]/)[0];
  }

  // Auto-dubbed videos list an "auto-generated" track per dub language, so the first ASR
  // track is not the spoken language. The original audio track tells which one is.
  function pickTrack(response, preferredLang) {
    const list = (response && response.captions && response.captions.playerCaptionsTracklistRenderer) || {};
    const tracks = list.captionTracks || [];
    const formats = (response && response.streamingData && response.streamingData.adaptiveFormats) || [];
    const originalAudio = formats.map((f) => f.audioTrack).find((a) => a && /original/i.test(a.displayName || ""));
    const defaultAudio = (list.audioTracks || [])[list.defaultAudioTrackIndex || 0];
    const asr = tracks.filter((t) => t.kind === "asr");
    const defaultCaption = defaultAudio && tracks[defaultAudio.defaultCaptionTrackIndex];
    const spoken = baseLang(originalAudio && originalAudio.id) ||
      baseLang(defaultAudio && defaultAudio.audioTrackId) ||
      (asr.length === 1 ? asr[0].languageCode : "") ||
      (defaultCaption ? defaultCaption.languageCode : "");
    const pick = (lang) => lang && (
      tracks.find((t) => t.languageCode === lang && t.kind !== "asr") ||
      tracks.find((t) => t.languageCode === lang) ||
      tracks.find((t) => baseLang(t.languageCode) === baseLang(lang) && t.kind !== "asr") ||
      tracks.find((t) => baseLang(t.languageCode) === baseLang(lang)));
    const track = pick(preferredLang) || pick(spoken) || pick("en") || tracks[0] || null;
    return {
      track,
      kind: track && track.kind === "asr" ? "asr" : null,
      spoken: spoken || null,
      available: tracks.map((t) => `${t.languageCode}${t.kind === "asr" ? "(auto)" : ""}`),
      originalAudio: originalAudio ? originalAudio.displayName : null,
    };
  }

  function cuesFrom(json) {
    return ((json && json.events) || [])
      .filter((e) => Number.isFinite(e.tStartMs))
      .map((e) => ({
        start: e.tStartMs / 1000,
        end: (e.tStartMs + (e.dDurationMs || 0)) / 1000,
        text: (e.segs || []).map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim(),
      }))
      .filter((c) => c.text);
  }

  function stamp(seconds) {
    const t = Math.floor(seconds);
    const h = Math.floor(t / 3600);
    const m = Math.floor(t / 60) % 60;
    const s = String(t % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }

  function buildTranscript(details, track, kind, cues) {
    const groups = [];
    let group = null;
    for (const cue of cues) {
      const bucket = Math.floor(cue.start / GROUP_SECONDS);
      if (!group || group.bucket !== bucket) groups.push(group = { bucket, start: cue.start, text: [] });
      group.text.push(cue.text);
    }
    const duration = Number(details.lengthSeconds) || null;
    const lastEnd = Math.max(...cues.map((c) => c.end));
    const tailGap = duration ? Math.max(0, duration - lastEnd) : null;
    const evidence = {
      id: details.videoId, title: details.title, channel: details.author, duration,
      url: `https://www.youtube.com/watch?v=${details.videoId}`,
      caption_language: track.languageCode, caption_kind: kind || "manual",
      cues: cues.length, first_start: cues[0].start, last_end: lastEnd,
      tail_gap_seconds: tailGap, needs_tail_review: tailGap === null || tailGap > 30,
    };
    const text = [
      "YOUTUBE-SOURCE TRANSCRIPT",
      JSON.stringify({ ...evidence, description: details.shortDescription || "" }),
      "---",
      ...groups.map((g) => `[${stamp(g.start)}] ${g.text.join(" ")}`),
    ].join("\n") + "\n";
    return { evidence, text };
  }

  function fileName(details) {
    const title = String(details.title || "video").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
    return `${title} [${details.videoId}].transcript.txt`;
  }

  function currentVideoId() {
    return location.pathname === "/watch" ? new URLSearchParams(location.search).get("v") : null;
  }

  async function waitForPlayer() {
    for (let i = 0; i < 20; i++) {
      const player = document.querySelector("#movie_player");
      const response = player && typeof player.getPlayerResponse === "function" && player.getPlayerResponse();
      if (response && response.videoDetails && response.videoDetails.videoId === currentVideoId()) return { player, response };
      await sleep(500);
    }
    throw new StepError("player", "Player for the current video not found",
      "#movie_player or getPlayerResponse() changed, or the page is not a /watch page.");
  }

  function findCaptionRequest(videoId, track, kind) {
    return performance.getEntriesByType("resource").filter((entry) => {
      let url;
      try { url = new URL(entry.name); } catch { return false; }
      return url.pathname === "/api/timedtext" && url.searchParams.get("v") === videoId &&
        !url.searchParams.has("tlang") && url.searchParams.get("fmt") === "json3" &&
        url.searchParams.get("lang") === track.languageCode &&
        (url.searchParams.get("kind") || null) === kind && entry.encodedBodySize > 0;
    }).at(-1);
  }

  function savePlayerState(player) {
    let captionTrack = null;
    try { captionTrack = player.getOption("captions", "track"); } catch { /* module not loaded */ }
    return {
      muted: typeof player.isMuted === "function" ? player.isMuted() : null,
      playing: typeof player.getPlayerState === "function" ? player.getPlayerState() === 1 : false,
      captionTrack: captionTrack && captionTrack.languageCode ? captionTrack : null,
    };
  }

  function restorePlayerState(player, state) {
    try {
      if (state.playing) player.playVideo(); else player.pauseVideo();
      if (state.muted === false) player.unMute();
      if (state.captionTrack) player.setOption("captions", "track", state.captionTrack);
      else player.unloadModule("captions");
      info("restored player", state);
    } catch (error) {
      console.warn(LOG, "could not fully restore player state", error);
    }
  }

  // Captions load only after the player requests them; that request carries per-session
  // parameters, so it is reused instead of building a URL from captionTracks[].baseUrl.
  async function loadCaptions(player, videoId, track, kind) {
    let request = findCaptionRequest(videoId, track, kind);
    if (request) {
      info("4/6 caption request already loaded");
      return request;
    }
    for (let attempt = 1; attempt <= 2 && !request; attempt++) {
      info(`3/6 mute + enable captions (attempt ${attempt})`, { lang: track.languageCode, kind: kind || "manual" });
      player.mute();
      player.playVideo();
      // On a fresh page loadModule() alone can select the track without fetching it;
      // an unload/load cycle makes the player request the captions right away.
      player.unloadModule("captions");
      player.loadModule("captions");
      // The caption module fills its track list asynchronously; ASR tracks are listed only on request.
      let tracklist = [];
      for (let i = 0; i < 20 && !tracklist.length; i++) {
        await sleep(250);
        try { tracklist = player.getOption("captions", "tracklist", { includeAsr: true }) || []; } catch { tracklist = []; }
      }
      const listed = tracklist.find((t) => t.languageCode === track.languageCode && (t.kind || null) === kind);
      if (!listed) console.warn(LOG, "track not in player tracklist; using languageCode only", tracklist.map((t) => `${t.languageCode}${t.kind ? `(${t.kind})` : ""}`));
      else info("track found in player tracklist", { tracks: tracklist.length });
      player.setOption("captions", "track", listed || { languageCode: track.languageCode });
      for (let i = 0; i < 16 && !(request = findCaptionRequest(videoId, track, kind)); i++) await sleep(500);
    }
    if (!request) {
      const seen = performance.getEntriesByType("resource").filter((e) => e.name.includes("/api/timedtext")).length;
      throw new StepError("caption request", `Player did not request ${track.languageCode} captions`,
        `timedtext requests seen: ${seen}. Player caption API (loadModule/setOption) or request parameters may have changed. Reload the page and retry once; manual fallback: youtube-source chrome_transcript.js.`);
    }
    info("4/6 caption request found");
    return request;
  }

  function renderPage(text) {
    // DOM APIs, not innerHTML: YouTube enforces Trusted Types.
    const body = document.body;
    while (body.firstChild) body.removeChild(body.firstChild);
    const main = document.createElement("main");
    const article = document.createElement("article");
    const pre = document.createElement("pre");
    pre.textContent = text;
    article.append(pre);
    main.append(article);
    body.append(main);
  }

  function download(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /**
   * mode: "download" (button default), "page" (replace the page with the transcript for
   * text readers such as an agent's get_page_text), "return" (only return the result).
   */
  async function run({ mode = "download", preferredLang = null } = {}) {
    if (running) throw new StepError("busy", "A transcript run is already in progress");
    running = true;
    let player = null;
    let saved = null;
    console.groupCollapsed(`${LOG} run v${VERSION} (${mode})`);
    try {
      info("start", { url: location.href, preferredLang });
      const found = await waitForPlayer();
      player = found.player;
      const details = found.response.videoDetails;
      const status = found.response.playabilityStatus || {};
      info("1/6 player ready", { id: details.videoId, title: details.title, status: status.status });
      if (status.status !== "OK") {
        throw new StepError("playability", `Player status ${status.status}: ${status.reason || "unknown"}`,
          "Sign in to YouTube in this browser or open the video normally first.");
      }

      const choice = pickTrack(found.response, preferredLang);
      info("2/6 caption tracks", choice);
      if (!choice.track) {
        throw new StepError("tracks", "This video has no caption tracks",
          "captions.playerCaptionsTracklistRenderer.captionTracks is empty or moved.");
      }

      saved = savePlayerState(player);
      info("saved player state", saved);
      const request = await loadCaptions(player, details.videoId, choice.track, choice.kind);

      const response = await fetch(request.name, { credentials: "same-origin" });
      if (!response.ok) {
        throw new StepError("fetch", `Caption request failed: HTTP ${response.status}`,
          "YouTube rejected the reused request; reload the page and retry.");
      }
      const cues = cuesFrom(await response.json());
      info("5/6 captions parsed", { cues: cues.length });
      if (!cues.length) {
        throw new StepError("parse", "Caption response had no text",
          "json3 format may have changed: expected events[].segs[].utf8.");
      }

      const result = buildTranscript(details, choice.track, choice.kind, cues);
      const name = fileName(details);
      if (mode === "download") download(result.text, name);
      info(`6/6 output: ${mode}`, { ...result.evidence, file: mode === "download" ? name : null, chars: result.text.length });
      if (result.evidence.needs_tail_review) console.warn(LOG, "captions end long before the video ends", result.evidence.tail_gap_seconds);

      // The page mode removes the player from the DOM, so restore first.
      restorePlayerState(player, saved);
      saved = null;
      if (mode === "page") renderPage(result.text);
      return { ...result.evidence, chars: result.text.length, file: mode === "download" ? name : null, text: mode === "return" ? result.text : undefined };
    } catch (error) {
      console.error(LOG, `failed at step "${error.step || "unexpected"}": ${error.message}`, error.hint ? `\nHint: ${error.hint}` : "", error);
      throw error;
    } finally {
      if (player && saved) restorePlayerState(player, saved);
      console.groupEnd();
      running = false;
    }
  }

  function setButtonState(button, text, state) {
    button.title = text;
    button.setAttribute("aria-label", text);
    if (state) button.dataset.wlqaState = state; else delete button.dataset.wlqaState;
  }

  function icon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    path.setAttribute("d", ICON);
    svg.append(path);
    return svg;
  }

  function addButton() {
    if (!currentVideoId()) return;
    const controls = CONTROL_SELECTORS.map((s) => document.querySelector(`#movie_player ${s}`)).find(Boolean);
    if (!controls) {
      if (!warnedNoControls && document.querySelector("#movie_player")) {
        warnedNoControls = true;
        console.warn(LOG, "player controls not found; button not added. Tried:", CONTROL_SELECTORS,
          "Use window.wlqaTranscript.run() from the console instead.");
      }
      return;
    }
    if (controls.querySelector(`.${BUTTON_CLASS}`)) return;

    const idle = "Скачать субтитры (выкл. звук → субтитры → .txt)";
    const button = document.createElement("button");
    button.type = "button";
    button.className = `ytp-button ${BUTTON_CLASS}`;
    button.append(icon());
    setButtonState(button, idle);
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (running) return;
      setButtonState(button, "Загружаю субтитры…", "busy");
      try {
        const result = await run({ mode: "download" });
        setButtonState(button, `Скачано: ${result.caption_language}${result.caption_kind === "asr" ? " (авто)" : ""}, ${result.cues} фрагментов`, "ok");
      } catch (error) {
        setButtonState(button, `Ошибка: ${error.message}. Подробности в консоли (${LOG})`, "error");
      }
      setTimeout(() => setButtonState(button, idle), 4000);
    });
    controls.prepend(button);
    info("button added", { container: CONTROL_SELECTORS.find((s) => controls.matches(s)) });
  }

  function scheduleRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    setTimeout(() => {
      refreshQueued = false;
      addButton();
    }, 200);
  }

  // Console / automation entry point: await wlqaTranscript.run({ mode: "page" })
  window.wlqaTranscript = Object.freeze({
    version: VERSION, run,
    _internals: { pickTrack, cuesFrom, buildTranscript, fileName, stamp },
  });

  addButton();
  new MutationObserver(scheduleRefresh).observe(document.documentElement, { childList: true, subtree: true });
})();
