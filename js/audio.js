(function (MF) {
  const SFX = ['click', 'card-flip', 'correct', 'wrong', 'game-complete', 'level-up', 'unlock', 'xp-gain', 'countdown', 'game-start'];
  // false: sounds are generated in the browser with the Web Audio API (no files needed).
  // true: mp3 files from assets/audio/ are used instead (sfx/<name>.mp3 and music/background.mp3).
  const FILES_AVAILABLE = false;

  let userInteracted = false;
  const settings = () => MF.Storage.get('settings');

  // ---------------------------------------------------------------- file engine (used when FILES_AVAILABLE = true)
  const fileEngine = (() => {
    const SFX_DIR = 'assets/audio/sfx/', SFX_EXT = '.mp3', MUSIC_SRC = 'assets/audio/music/background.mp3';
    const MUSIC_VOLUME = 0.3, SFX_VOLUME = 0.7;
    let music = null;
    return {
      unlock() {},
      play(name) {
        const sound = new Audio(SFX_DIR + name + SFX_EXT);
        sound.volume = SFX_VOLUME;
        sound.play().catch(() => {});
      },
      startMusic() {
        if (!music) { music = new Audio(MUSIC_SRC); music.loop = true; music.volume = MUSIC_VOLUME; }
        music.play().catch(() => {});
      },
      // Stops playback and releases the Audio object so no stray playback can continue.
      stopMusic() {
        if (!music) return;
        music.pause(); music.removeAttribute('src'); music.load(); music = null;
      }
    };
  })();

  // ---------------------------------------------------------------- synth engine (Web Audio, no files)
  const synthEngine = (() => {
    const SFX_VOLUME = 0.25, MUSIC_VOLUME = 0.07, FADE_S = 0.15;
    const ATTACK_S = 0.01, SILENCE = 0.0001;
    // One note = { f: Hz, to: slide target Hz, t: start offset (s), d: duration (s), type: waveform, g: peak gain }.
    const SOUNDS = {
      'click': [{ f: 880, d: 0.04, type: 'square', g: 0.25 }],
      'card-flip': [{ f: 300, to: 560, d: 0.09, type: 'triangle', g: 0.7 }],
      'correct': [{ f: 660, d: 0.09, type: 'sine' }, { f: 880, t: 0.09, d: 0.16, type: 'sine' }],
      'wrong': [{ f: 220, to: 140, d: 0.28, type: 'sawtooth', g: 0.5 }],
      'game-complete': [523, 659, 784, 1047].map((f, i) => ({ f, t: i * 0.11, d: i === 3 ? 0.4 : 0.14, type: 'triangle' })),
      'level-up': [392, 494, 587, 784, 988].map((f, i) => ({ f, t: i * 0.09, d: i === 4 ? 0.4 : 0.12, type: 'square', g: 0.4 })),
      'unlock': [{ f: 523, d: 0.1, type: 'sine' }, { f: 784, t: 0.1, d: 0.1, type: 'sine' }, { f: 1047, t: 0.2, d: 0.28, type: 'sine' }],
      'xp-gain': [{ f: 1200, to: 1700, d: 0.1, type: 'sine', g: 0.6 }],
      'countdown': [{ f: 600, d: 0.12, type: 'square', g: 0.35 }],
      'game-start': [{ f: 440, to: 880, d: 0.18, type: 'triangle' }, { f: 880, t: 0.18, d: 0.22, type: 'triangle' }]
    };
    // Background loop: Am - F - C - G, one bar each (BAR_S), an 8-step arpeggio over a sustained bass note.
    const BAR_S = 2, STEP_S = BAR_S / 8, LOOKAHEAD_S = 1, PUMP_MS = 250;
    const PROGRESSION = [
      { bass: 110, arp: [220, 261.63, 329.63, 440] }, { bass: 87.31, arp: [174.61, 220, 261.63, 349.23] },
      { bass: 130.81, arp: [261.63, 329.63, 392, 523.25] }, { bass: 98, arp: [196, 246.94, 293.66, 392] }
    ];
    const ARP_PATTERN = [0, 1, 2, 3, 2, 1, 2, 3];

    let ctx = null, sfxGain = null, musicGain = null, loop = null;

    const makeGain = (value, ctxRef) => { const g = ctxRef.createGain(); g.gain.value = value; g.connect(ctxRef.destination); return g; };
    // Created lazily and only after a user gesture, so browsers never block or queue the audio.
    function unlock() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        try { ctx = new AC(); } catch (e) { ctx = null; return; }
        sfxGain = makeGain(SFX_VOLUME, ctx);
        musicGain = makeGain(MUSIC_VOLUME, ctx);
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    }
    function tone(dest, start, { f, to, d, type = 'sine', g = 1 }) {
      const osc = ctx.createOscillator(), amp = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(f, start);
      if (to) osc.frequency.exponentialRampToValueAtTime(to, start + d);
      amp.gain.setValueAtTime(SILENCE, start);
      amp.gain.exponentialRampToValueAtTime(g, start + ATTACK_S);
      amp.gain.exponentialRampToValueAtTime(SILENCE, start + d);
      osc.connect(amp); amp.connect(dest);
      osc.start(start); osc.stop(start + d + 0.02);
    }
    function scheduleBar(barIndex, start) {
      const chord = PROGRESSION[barIndex % PROGRESSION.length];
      tone(musicGain, start, { f: chord.bass, d: BAR_S * 0.95, type: 'sine', g: 0.9 });
      ARP_PATTERN.forEach((idx, step) => tone(musicGain, start + step * STEP_S, { f: chord.arp[idx], d: STEP_S * 0.9, type: 'triangle', g: 0.5 }));
    }
    function pump() {
      if (!loop || !ctx) return;
      while (loop.next < ctx.currentTime + LOOKAHEAD_S) { scheduleBar(loop.bar, loop.next); loop.next += BAR_S; loop.bar++; }
    }
    return {
      unlock,
      play(name) {
        if (!ctx) return;
        const start = ctx.currentTime;
        SOUNDS[name].forEach(n => tone(sfxGain, start + (n.t || 0), n));
      },
      startMusic() {
        if (!ctx || loop) return;
        loop = { bar: 0, next: ctx.currentTime + 0.1, timer: setInterval(pump, PUMP_MS) };
        pump();
      },
      // Stops the scheduler and fades out the already scheduled notes; a fresh gain node is used on the next start.
      stopMusic() {
        if (!loop) return;
        clearInterval(loop.timer); loop = null;
        const old = musicGain, now = ctx.currentTime;
        old.gain.cancelScheduledValues(now);
        old.gain.setValueAtTime(old.gain.value, now);
        old.gain.linearRampToValueAtTime(0, now + FADE_S);
        musicGain = makeGain(MUSIC_VOLUME, ctx);
        setTimeout(() => { try { old.disconnect(); } catch (e) { /* already disconnected */ } }, FADE_S * 1000 + 100);
      }
    };
  })();

  const engine = FILES_AVAILABLE ? fileEngine : synthEngine;

  function startMusic() {
    if (!userInteracted || !settings().music) return;
    engine.startMusic();
  }
  function playSfx(name) {
    if (!settings().soundEffects || !SFX.includes(name)) return;
    engine.play(name);
  }

  MF.Audio = {
    SFX,
    play: playSfx,
    startMusic,
    stopMusic: () => engine.stopMusic(),
    // Applies one setting ('soundEffects' | 'music'); the two are independent.
    setSetting(key, value) {
      MF.Storage.update('settings', s => ({ ...s, [key]: value }));
      if (key === 'music') value ? startMusic() : engine.stopMusic();
    },
    // Call after Storage.reset(): stops music and re-syncs with the default settings.
    reset() {
      engine.stopMusic();
      startMusic(); // no-op unless the (default) settings enable music
    }
  };

  // Browsers block autoplay: audio may only start after the first user gesture.
  ['pointerdown', 'keydown'].forEach(evt =>
    window.addEventListener(evt, () => { userInteracted = true; engine.unlock(); startMusic(); }, { once: true }));
})(window.MF);
