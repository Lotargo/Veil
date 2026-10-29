const $ = id => document.getElementById(id);
// The Session panel (create-sessions.js), loaded on start; tests run this file as a script.
let sessions = null;
const MAX_PHOTO = 20 * 1024 * 1024;
const TXT2IMG_SECONDS = 50;
const RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9'];

// Three modes in the switch. "prompt" runs text-to-image, or image-to-image once a starting
// photo is added; the AI checkbox lets the agent write its prompt. The server knows the
// job modes text / variation / reference / edit (see jobMode()).
const MODE_COPY = {
    prompt: {
        label: 'Prompt',
        button: 'Create',
    },
    reference: {
        label: 'Recreate',
        placeholder: 'Optional: what to change, for example "the same scene at night in the rain"',
        button: 'Recreate',
    },
    edit: {
        label: 'Edit',
        placeholder: 'For example: change her sweater to a black satin camisole',
        button: 'Edit photo',
    },
};
// Prompt mode's text depends on the starting photo and the AI checkbox.
const PROMPT_COPY = {
    own: {
        placeholder: 'Your full prompt, for example: photo of a night café by the sea, warm window light, light fog, wet pavement',
    },
    ai: {
        placeholder: 'For example: a night café by the sea, warm window light, light fog and wet pavement',
    },
    ownPhoto: {
        placeholder: 'Your full prompt for the new image',
        button: 'Create from photo',
    },
    aiPhoto: {
        placeholder: 'Optional: what to change, for example "warmer evening light"',
        button: 'Create from photo',
    },
};
// "Edit photo" once the optional second photo (a person, a garment or a tattoo) is added.
const EDIT_REFERENCE_COPY = {
    label: 'Edit with reference',
    placeholder: 'For example: dress her in the red silk dress from the reference',
    button: 'Edit with reference',
};
// How the session and the prompt window name a run, by job mode.
const RUN_LABELS = { text: 'Prompt', variation: 'Prompt + photo', reference: 'Recreate', edit: 'Edit' };

// Titles of the reference blocks per mode; a mode without an entry hides that block.
const REF_COPY = {
    prompt: {
        eyebrow: 'PHOTO',
        main: ['Starting photo', 'The new image starts from it; remove it to create from the prompt alone'],
    },
    reference: {
        eyebrow: 'PHOTO',
        main: ['Photo to recreate', 'The agent describes it and applies your text'],
    },
    edit: {
        eyebrow: 'PHOTOS',
        main: ['Photo to edit', 'The source for the edit; say what to change'],
        subject: ['Reference', 'Optional: a person, a garment or a tattoo to bring in'],
    },
};

/** The server mode of what the controls would run now. */
function jobMode() {
    if (state.mode !== 'prompt') return state.mode;
    return state.photo ? 'variation' : 'text';
}

/** The switch position of a job mode (older sessions also stored "prompt"). */
function uiMode(mode) {
    return ['text', 'variation', 'prompt'].includes(mode) ? 'prompt' : mode;
}

/** A stored run's job mode; "prompt" runs from an earlier build were text runs. */
function runMode(run) {
    return run.mode === 'prompt' ? 'text' : run.mode;
}

/** Whether a run needs the agent to see the photo. */
function needsVision(mode = jobMode(), agent = state.mode !== 'prompt' || state.enhance) {
    return mode === 'reference' || (mode === 'variation' && agent);
}
const LAYOUT_EASING = 'cubic-bezier(.16,1,.3,1)';

// The greeting above the cards: one at random per visit; it leaves when a generation starts.
// Now and then its letters come loose and fall, and the ones left standing gather into what
// was hidden under the veil. Each reveal reads left to right through the phrase's letters.
const HERO_PHRASES = [
    { text: 'What are we creating?', reveals: ['wet', 'heat'] },
    { text: 'Show me what you see', reveals: ['so wet', 'sweaty', 'show me you'] },
    { text: 'Something daring tonight?', reveals: ['so tight', 'sit on it', 'sin tonight', 'thong'] },
    { text: 'Paint the scene you imagine', reveals: ['pin me', 'paint me', 'pin you'] },
    { text: 'Where does the story begin?', reveals: ['wet story', 'hot sin', 'whore', 'wet sin'] },
    { text: 'Start with a single word', reveals: ['tits lewd', 'satin', 'hard'] },
    { text: 'What shall we dream up today?', reveals: ['sweaty', 'slut', 'hard'] },
    { text: 'Describe it, and it appears', reveals: ['deeper', 'ride', 'drip', 'bite'] },
    { text: 'Turn words into pictures', reveals: ['undo it', 'on top', 'turn on', 'oops'] },
    { text: 'Your idea, rendered', reveals: ['yandere', 'i dare', 'ride'] },
    { text: 'Touch the light, make it move', reveals: ['touch me', 'touch it', 'take me', 'eat me'] },
    { text: 'Under the veil, anything is possible', reveals: ['undress', 'tease', 'heels'] },
    { text: 'Soft light, deep shadows, your rules', reveals: ['so tight', 'oh yes', 'so deep', 'tease'] },
    { text: 'Let the story take its time', reveals: ['take it', 'eat me', 'the tits', 'tease'] },
    { text: 'Your next favourite picture starts here', reveals: ['on top', 'your tits', 'tease', 'oops'] },
    { text: 'Find the shot nobody has taken', reveals: ['in heat', 'hot body', 'tease'] },
    { text: 'Shape the light, then the story', reveals: ['thighs', 'sheer', 'heels', 'satin'] },
    { text: 'Take your time, the light is soft', reveals: ['take it', 'your thighs', 'take your tits', 'take it soft'] },
    { text: 'Pick a mood and let it unfold', reveals: ['pick me', 'moan', 'pound'] },
    { text: 'Tell me what you want to see', reveals: ['tell me you want', 'tease', 'moan'] },
    { text: 'Tonight, anything goes', reveals: ['oh yes', 'tight'] },
    { text: 'Make it moody, make it yours', reveals: ['make me yours', 'take it'] },
    { text: 'One prompt away', reveals: [] },
];
// How often a greeting comes apart, and how long a reveal stays before the next greeting.
const HERO_BREAK_CHANCE = 0.45;
const HERO_REST_MS = [3000, 8000];
const HERO_REVEAL_MS = [7000, 23000];

// Variation noise: how much of the photo is repainted (0 keeps it, 1 ignores it).
const DENOISE_DEFAULT = 0.65;
// The bar's colour along the scale; values in between blend smoothly.
const DENOISE_COLORS = [
    [0, '#3b82f6'], [0.3, '#4f8ff0'], [0.45, '#e2a33b'], [0.55, '#e2a33b'],
    [0.65, '#34c38f'], [0.75, '#34c38f'], [0.88, '#9b7be0'], [1, '#8a93a6'],
];
const DENOISE_ZONES = [
    { id: 'close', below: 0.35, label: 'Close to the photo', text: 'Leans toward the photo: its artifacts carry over to the result.' },
    { id: 'mixed', below: 0.6, label: 'Partly repainted', text: 'Artifacts of the photo can still carry over, but most of it is repainted.' },
    { id: 'optimal', below: 0.8, label: 'Optimal', text: 'A new image close to the photo that drops its small artifacts.' },
    { id: 'far', below: 1, label: 'Far from the photo', text: 'Little of the photo remains.' },
    { id: 'none', below: Infinity, label: 'Photo not used', text: 'The photo no longer takes part; only its proportions are kept.' },
];
const AGENT_HOSTS = { opencode: 'OpenCode', codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity' };
const AGENT_HOST_RE = /^(?:opencode|claude|codex|antigravity|api:[a-z0-9][a-z0-9_-]{0,47})$/;
// The models Integrations › Models shows; Integrations stamps every change here.
const AGENT_CATALOG_KEY = 'mediastudio_create_agent_catalog_v2';
const MODELS_CHANGED_KEY = 'mediastudio_ai_models_changed_at';
const AGENT_CATALOG_TTL = 10 * 60 * 1000;

const state = {
    models: [],
    modelId: '',
    health: null,
    // Where Create runs: this computer's ComfyUI or a Colab GPU (Integrations › Remote GPU).
    backend: 'local',
    colab: null,
    colabPoll: null,
    mode: 'prompt',
    // Prompt mode: let the agent write the prompt from the user's words (and the photo).
    enhance: false,
    ratio: '1:1',
    photoRatio: 'source',
    denoise: DENOISE_DEFAULT,
    batch: 1,
    photo: null,
    subject: null,
    slotFocus: 'main',
    refineFrom: null,
    agentStatus: null,
    // The model picked in Create's agent menu, or null for the default model.
    agentChoice: null,
    agents: null,
    canvasWidth: null,
    ambient: [],
    ambientDeck: [],
    ambientHistory: [],
    ambientCurrent: null,
    ambientLoadingMore: false,
    ambientRequest: 0,
    ambientPoolRequest: 0,
    ambientPicking: false,
    ambientPickRequest: 0,
    fit: 'cover',
    layer: 0,
    timer: null,
    timerInterval: 0,
    interval: 300000,
    opacity: 44,
    blur: 10,
    sound: false,
    job: null,
    poll: null,
    agentTimer: null,
    agentTick: null,
    agentPhase: 'started',
    agentName: '',
    last: null,
    lastOutputs: [],
    resultRefs: [],
    selectedResultIndex: 0,
    resultRequest: 0,
    lastRun: null,
    dialogRun: null,
    downloads: [],
    downloadPoll: null,
    runtimeConfig: null,
    runtimeStatus: null,
    runtimeBusy: null,
    runtimeStartedAt: 0,
    runtimePoll: null,
    // Settings changed while a ComfyUI started by Create runs: offer a restart.
    runtimeStale: false,
    desktop: null,
    runtimeDraft: null,
};

function catalog() {
    try { return JSON.parse($('simple-model-catalog')?.textContent || '[]'); }
    catch { return []; }
}

function restore() {
    try {
        const mode = uiMode(localStorage.getItem('mediastudio_create_mode'));
        if (MODE_COPY[mode]) state.mode = mode;
        state.enhance = localStorage.getItem('mediastudio_create_enhance') === 'true';
        const choice = JSON.parse(localStorage.getItem('mediastudio_create_agent') || 'null');
        if (AGENT_HOST_RE.test(choice?.agentKind || '') && choice.model) state.agentChoice = choice;
        const ratio = localStorage.getItem('mediastudio_simple_ratio');
        if (RATIOS.includes(ratio)) state.ratio = ratio;
        const photoRatio = localStorage.getItem('mediastudio_create_photo_ratio');
        if (photoRatio === 'source' || RATIOS.includes(photoRatio)) state.photoRatio = photoRatio;
        state.batch = Math.max(1, Math.min(4, Number(localStorage.getItem('mediastudio_simple_batch')) || 1));
        const denoise = localStorage.getItem('mediastudio_create_denoise');
        if (denoise !== null && Number(denoise) >= 0 && Number(denoise) <= 1) state.denoise = roundDenoise(Number(denoise));
        const savedCanvasWidth = Number(localStorage.getItem('mediastudio_simple_canvas_width'));
        if (Number.isFinite(savedCanvasWidth) && savedCanvasWidth > 0) state.canvasWidth = savedCanvasWidth;

        const rawInterval = localStorage.getItem('mediastudio_simple_ambient_interval');
        state.interval = rawInterval !== null && !isNaN(Number(rawInterval)) ? Number(rawInterval) : 300000;
        const rawOpacity = localStorage.getItem('mediastudio_simple_glass_opacity');
        const numOpacity = Number(rawOpacity);
        if (rawOpacity !== null && !isNaN(numOpacity) && numOpacity >= 5 && numOpacity <= 98) state.opacity = numOpacity;
        else if (rawOpacity === 'ultra') state.opacity = 18;
        else if (rawOpacity === 'high') state.opacity = 30;
        else if (rawOpacity === 'solid') state.opacity = 82;
        const rawBlur = localStorage.getItem('mediastudio_simple_ambient_blur');
        state.blur = rawBlur !== null && !isNaN(Number(rawBlur)) ? Number(rawBlur) : 10;
        state.fit = localStorage.getItem('mediastudio_simple_ambient_fit') || 'cover';
        state.sound = localStorage.getItem('mediastudio_simple_sound_alert') === 'true';

        const savedPrompt = localStorage.getItem('mediastudio_simple_prompt');
        if (savedPrompt !== null) $('prompt').value = savedPrompt;
        const lastRun = JSON.parse(localStorage.getItem('mediastudio_create_last_run') || 'null');
        if (lastRun && typeof lastRun.prompt === 'string') state.lastRun = lastRun;
    } catch {}
}

const hero = { run: 0, timers: [], text: '' };

function between([low, high]) {
    return low + Math.random() * (high - low);
}

/** A timer that does nothing once the greeting has moved on. */
function heroLater(run, ms, fn) {
    hero.timers.push(setTimeout(() => { if (run === hero.run) fn(); }, ms));
}

function stopHero() {
    hero.run += 1;
    hero.timers.forEach(clearTimeout);
    hero.timers = [];
}

/** Indices of the phrase's letters that spell ``reveal`` in order, or null. */
function revealIndices(text, reveal) {
    const lower = text.toLowerCase();
    const indices = [];
    let from = 0;
    for (const char of reveal.toLowerCase()) {
        if (char === ' ') continue;
        const at = lower.indexOf(char, from);
        if (at < 0) return null;
        indices.push(at);
        from = at + 1;
    }
    return indices;
}

function heroLetter(char, index) {
    const letter = document.createElement('span');
    letter.className = 'hero-letter';
    letter.textContent = char;
    letter.style.setProperty('--i', String(index));
    letter.setAttribute('aria-hidden', 'true');
    return letter;
}

/** A random greeting, typed in letter by letter; it may come apart a few seconds later. */
function paintHero() {
    const title = $('hero-phrase');
    if (!title) return;
    stopHero();
    const run = hero.run;
    const choices = HERO_PHRASES.filter(item => item.text !== hero.text);
    const phrase = choices[Math.floor(Math.random() * choices.length)];
    hero.text = phrase.text;
    title.classList.remove('is-revealed');
    title.setAttribute('aria-label', phrase.text);
    title.replaceChildren(...[...phrase.text].map(heroLetter));
    if (!phrase.reveals.length || Math.random() >= HERO_BREAK_CHANCE) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const reveal = phrase.reveals[Math.floor(Math.random() * phrase.reveals.length)];
    const typed = phrase.text.length * 32 + 1100;
    heroLater(run, typed + between(HERO_REST_MS), () => breakHero(run, reveal));
}

/** Loose letters wobble and fall one by one or a few at once, out of step. */
function breakHero(run, reveal) {
    const title = $('hero-phrase');
    const letters = [...title.children];
    const keep = new Set(revealIndices(hero.text, reveal) || []);
    if (!keep.size) return;
    letters.forEach(letter => { letter.style.animation = 'none'; });
    const loose = letters.filter((letter, index) => !keep.has(index) && letter.textContent.trim());
    for (let i = loose.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [loose[i], loose[j]] = [loose[j], loose[i]];
    }
    let at = 0;
    let end = 0;
    while (loose.length) {
        // Mostly one letter at a time, sometimes two or three together.
        const burst = loose.splice(0, Math.random() < 0.35 ? 2 + Math.floor(Math.random() * 2) : 1);
        for (const letter of burst) {
            const start = at + between([0, 700]);
            const wobble = between([1100, 2600]);
            const fall = between([800, 1300]);
            heroLater(run, start, () => dropLetter(run, letter, wobble, fall));
            end = Math.max(end, start + wobble + fall);
        }
        at += between([350, 1600]);
    }
    heroLater(run, end + 450, () => gatherHero(run, reveal, keep));
}

function dropLetter(run, letter, wobble, fall) {
    const side = Math.random() < 0.5 ? -1 : 1;
    const tilt = between([5, 10]) * side;
    // It hangs on one bottom corner, as if a single nail still held it.
    letter.style.transformOrigin = side < 0 ? '0% 100%' : '100% 100%';
    const swing = letter.animate([
        { transform: 'rotate(0deg)' },
        { transform: `rotate(${tilt * 0.35}deg)` },
        { transform: `rotate(${-tilt * 0.2}deg)` },
        { transform: `rotate(${tilt * 0.7}deg)` },
        { transform: `rotate(${-tilt * 0.25}deg)` },
        { transform: `rotate(${tilt}deg)` },
    ], { duration: wobble, easing: 'ease-in-out', fill: 'forwards' });
    swing.finished.then(() => {
        if (run !== hero.run) return;
        letter.animate([
            { transform: `rotate(${tilt}deg)`, opacity: 1 },
            { transform: `translate(${side * between([8, 40])}px, ${between([150, 260])}px) rotate(${side * between([40, 120])}deg)`, opacity: 0 },
        ], { duration: fall, easing: 'cubic-bezier(.55,0,1,.45)', fill: 'forwards' });
    }).catch(() => {});
}

/** The letters left standing slide together into the reveal, then give way to a new greeting. */
function gatherHero(run, reveal, keep) {
    const title = $('hero-phrase');
    const kept = [...title.children].filter((letter, index) => keep.has(index));
    const before = new Map(kept.map(letter => [letter, letter.getBoundingClientRect()]));
    const queue = [...kept];
    title.replaceChildren(...[...reveal].map(char => {
        if (char !== ' ') return queue.shift();
        const space = heroLetter(' ', 0);
        space.style.animation = 'none';
        return space;
    }));
    title.setAttribute('aria-label', reveal);
    kept.forEach((letter, index) => {
        const old = before.get(letter);
        const now = letter.getBoundingClientRect();
        letter.animate([
            { transform: `translate(${old.left - now.left}px, ${old.top - now.top}px)` },
            { transform: 'none' },
        ], { duration: 900, delay: index * 22, easing: LAYOUT_EASING, fill: 'backwards' });
    });
    heroLater(run, 900 + kept.length * 22, () => title.classList.add('is-revealed'));
    heroLater(run, between(HERO_REVEAL_MS), () => leaveHero(run));
}

function leaveHero(run) {
    const letters = [...$('hero-phrase').children];
    letters.forEach((letter, index) => letter.animate([
        { opacity: 1, filter: 'blur(0)', transform: 'none' },
        { opacity: 0, filter: 'blur(8px)', transform: 'translateY(-.3em)' },
    ], { duration: 600, delay: index * 30, easing: 'ease-in', fill: 'forwards' }));
    heroLater(run, 600 + letters.length * 30, paintHero);
}

function init() {
    paintHero();
    state.models = catalog();
    state.modelId = document.body.dataset.defaultModelId || state.models[0]?.id || '';
    restore();
    restoreAgentCatalog();
    applyVisualSettings();
    hydrateAmbient();
    wire();
    wireCanvasResize();
    setMode(state.mode, { keepRefine: false, quiet: true });
    syncBatch();
    resizePrompt();
    $('prompt-clear').hidden = !$('prompt').value.trim();
    const restored = savedCreateTask() ? restoreCreateTask() : restoreLastResult();
    import('./create-sessions.js').then(module => {
        sessions = module;
        return module.initSessions({ onOpenPrompt: openSessionPrompt });
    }).catch(err => console.error('Session panel failed to load', err));
    paintHealth({ status: 'checking' });
    loadHealth();
    loadDownloads();
    loadAgentStatus();
    loadAmbient();
    watchAmbientSources();
    loadRuntimeSummary();
    loadBackend();
    Promise.resolve(restored).then(openPhotoFromLink);
}

/** Remix from the Viewer: /create?photo=<asset id>&mode=variation attaches that image. */
async function openPhotoFromLink() {
    const params = new URLSearchParams(window.location.search);
    const assetId = Number(params.get('photo'));
    if (!Number.isInteger(assetId) || assetId <= 0) return;
    const mode = params.get('mode');
    params.delete('photo');
    params.delete('mode');
    const query = params.toString();
    history.replaceState(history.state, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash);
    setMode(['reference', 'edit'].includes(mode) ? mode : 'prompt');
    try {
        const response = await fetch(`/api/original/${assetId}`);
        if (!response.ok) throw new Error(`The image is unavailable (HTTP ${response.status}).`);
        const blob = await response.blob();
        await setPhoto('main', new File([blob], `asset-${assetId}`, { type: blob.type || 'image/png' }));
    } catch (err) {
        error('Could not open the photo', err.message);
    }
}

// --- modes ---------------------------------------------------------------------------

function setMode(mode, { keepRefine = false, quiet = false } = {}) {
    if (!MODE_COPY[mode]) return;
    const changed = state.mode !== mode;
    state.mode = mode;
    save('mediastudio_create_mode', mode);
    document.querySelectorAll('[data-mode]').forEach(button => {
        const active = button.dataset.mode === mode;
        button.classList.toggle('active', active);
        button.setAttribute('aria-checked', String(active));
    });
    paintModeCopy();
    if (!keepRefine && state.refineFrom && state.refineFrom.mode !== mode) clearRefine();
    animateLayout(paintRefs);
    paintJobControls();
    if (changed && !quiet) hideError();
    resizePrompt();
}

/** Everything that follows the job mode: frame or noise, the AI checkbox, the agent line. */
function paintJobControls() {
    const mode = jobMode();
    // A variation keeps the photo's proportions; the noise level takes the ratio's place.
    $('ratio-section').hidden = mode === 'variation';
    $('denoise-section').hidden = mode !== 'variation';
    $('enhance-toggle').hidden = state.mode !== 'prompt';
    $('enhance').checked = state.enhance;
    $('attach-photo').hidden = state.mode !== 'prompt' || Boolean(state.photo);
    paintModeCopy();
    syncRatio();
    paintAgentLine();
    if (state.health) paintHealth(state.health);
}

/** Edit photo takes an optional second photo: a person, a garment or a tattoo to bring in. */
function takesSubject(mode = state.mode) {
    return mode === 'edit';
}

function modeCopy(mode = state.mode) {
    if (mode === 'prompt') {
        const key = `${state.enhance ? 'ai' : 'own'}${state.photo ? 'Photo' : ''}`;
        return { ...MODE_COPY.prompt, ...PROMPT_COPY[key] };
    }
    return takesSubject(mode) && state.subject ? EDIT_REFERENCE_COPY : MODE_COPY[mode];
}

/** The placeholder and button of the mode; an edit with a second photo has its own. */
function paintModeCopy() {
    const copy = modeCopy();
    // The box takes a dropped or pasted photo too, which is easy to miss.
    $('prompt').placeholder = copy.placeholder + (state.photo ? '' : '\n\nYou can drop a photo here or paste it with Ctrl+V');
    $('create-label').textContent = copy.button;
}

function currentRatio(mode = jobMode()) {
    if (mode === 'variation') return 'source';
    return mode === 'text' ? state.ratio : state.photoRatio;
}

// --- variation noise -----------------------------------------------------------------

function roundDenoise(value) {
    return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

function denoiseZone(value) {
    return DENOISE_ZONES.find(zone => roundDenoise(value) < zone.below);
}

/** The bar's colour for a value: a blend of the two nearest colours of the scale. */
function denoiseColor(value) {
    const upper = DENOISE_COLORS.findIndex(([at]) => at >= value);
    if (upper <= 0) return DENOISE_COLORS[Math.max(0, upper)][1];
    const [from, low] = DENOISE_COLORS[upper - 1];
    const [to, high] = DENOISE_COLORS[upper];
    const share = Math.round(((value - from) / (to - from)) * 100);
    // OKLab fades through a soft neutral between distant hues instead of sweeping round the colour wheel.
    return `color-mix(in oklab, ${high} ${share}%, ${low})`;
}

function paintDenoise() {
    const value = state.denoise;
    const zone = denoiseZone(value);
    const input = $('denoise');
    input.value = String(value);
    $('denoise-value').textContent = value.toFixed(2);
    $('denoise-zone').textContent = zone.label;
    const section = $('denoise-section');
    section.dataset.zone = zone.id;
    section.style.setProperty('--denoise-color', denoiseColor(value));
    section.style.setProperty('--denoise-fill', `${Math.round(value * 100)}%`);
    const tip = $('denoise-tip');
    tip.textContent = `${zone.label}: ${zone.text}`;
    // The tip follows the thumb; CSS keeps it inside the control.
    tip.style.setProperty('--tip-at', String(value));
    input.title = zone.text;
}

function wireDenoise() {
    const input = $('denoise');
    const control = input.closest('.denoise-control');
    input.oninput = () => {
        state.denoise = roundDenoise(Number(input.value));
        save('mediastudio_create_denoise', state.denoise);
        paintDenoise();
    };
    const show = on => control.classList.toggle('show-tip', on);
    input.addEventListener('focus', () => show(true));
    input.addEventListener('blur', () => show(false));
    control.addEventListener('pointerenter', () => show(true));
    control.addEventListener('pointerleave', () => { if (document.activeElement !== input) show(false); });
    paintDenoise();
}

function ratioValue() {
    const ratio = currentRatio();
    if (ratio === 'source') {
        const photo = state.photo;
        return photo?.width && photo?.height ? photo.width / photo.height : 3 / 4;
    }
    const [width, height] = ratio.split(':').map(Number);
    return width / height;
}

function syncRatio() {
    const ratio = currentRatio();
    document.querySelectorAll('[data-ratio]').forEach(button => {
        if (button.dataset.ratio === 'source') button.hidden = jobMode() === 'text';
        button.classList.toggle('active', button.dataset.ratio === ratio);
    });
    syncCanvasAspect();
}

function syncBatch() {
    document.querySelectorAll('[data-batch]').forEach(button => {
        button.classList.toggle('active', Number(button.dataset.batch) === state.batch);
    });
}

// --- photos --------------------------------------------------------------------------

function readPhoto(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = String(reader.result);
            const image = new Image();
            image.onload = () => resolve({
                dataUrl,
                objectUrl: URL.createObjectURL(file),
                name: file.name || 'photo',
                width: image.naturalWidth,
                height: image.naturalHeight,
                size: file.size,
            });
            image.onerror = () => reject(new Error('The file is not a readable image.'));
            image.src = dataUrl;
        };
        reader.onerror = () => reject(new Error('Could not read the file.'));
        reader.readAsDataURL(file);
    });
}

async function setPhoto(slot, file) {
    if (!file || !String(file.type || '').startsWith('image/')) {
        error('Could not add the photo', 'Choose an image file.');
        return false;
    }
    if (file.size > MAX_PHOTO) {
        error('The photo is too large', 'Choose a file smaller than 20 MB.');
        return false;
    }
    try {
        const photo = await readPhoto(file);
        const key = slot === 'subject' ? 'subject' : 'photo';
        if (state[key]?.objectUrl?.startsWith('blob:')) URL.revokeObjectURL(state[key].objectUrl);
        state[key] = photo;
    } catch (err) {
        error('Could not add the photo', err.message);
        return false;
    }
    hideError();
    animateLayout(paintRefs);
    paintJobControls();
    return true;
}

function clearPhoto(slot) {
    const key = slot === 'subject' ? 'subject' : 'photo';
    if (state[key]?.objectUrl?.startsWith('blob:')) URL.revokeObjectURL(state[key].objectUrl);
    state[key] = null;
    const input = slot === 'subject' ? $('subject-input') : $('photo-input');
    if (input) input.value = '';
    animateLayout(paintRefs);
    paintJobControls();
}

function paintRefBlock(slot, photo, copy) {
    const block = $(`ref-${slot}`);
    if (!block) return;
    block.hidden = !copy;
    if (!copy) return;
    block.querySelector('.ref-title').textContent = copy[0];
    block.querySelector('.ref-hint').textContent = photo ? `${photo.name} · ${photo.width}×${photo.height}` : copy[1];
    block.classList.toggle('is-filled', Boolean(photo));
    block.title = photo ? 'Paste (Ctrl+V) or drop another picture to replace this one' : '';
    block.querySelector('.ref-empty').hidden = Boolean(photo);
    block.querySelector('.ref-tools').hidden = !photo;
    const preview = block.querySelector('.ref-preview');
    preview.hidden = !photo;
    if (photo) preview.querySelector('img').src = photo.objectUrl || photo.dataUrl;
}

/** The left panel: one block for the photo modes, two for edits (the photo and an optional reference). */
function paintRefs() {
    const layout = $('studio-layout');
    // Prompt mode shows the panel only once a starting photo is added.
    const copy = state.mode === 'prompt' && !state.photo ? null : REF_COPY[state.mode];
    layout.dataset.refs = String(Boolean(copy));
    $('refs-card').hidden = !copy;
    if (copy) {
        $('refs-eyebrow').textContent = copy.eyebrow;
        paintRefBlock('main', state.photo, copy.main);
        paintRefBlock('subject', state.subject, copy.subject);
        $('refs-card').dataset.blocks = copy.subject ? '2' : '1';
    }
    syncCanvasRowHeight();
}

/** Layout changes slide the cards from their old place to the new one (FLIP). */
function animateLayout(mutate) {
    const layout = $('studio-layout');
    const signature = () => `${layout.dataset.view}|${layout.dataset.refs}|${layout.dataset.blocks || ''}`;
    const cards = () => [...layout.children].filter(card => !card.hidden && card.getClientRects().length);
    const before = signature();
    const rects = new Map(cards().map(card => [card, card.getBoundingClientRect()]));
    mutate();
    if (signature() === before || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const card of cards()) {
        const now = card.getBoundingClientRect();
        const old = rects.get(card);
        if (!old) {
            card.animate(
                [{ opacity: 0, transform: 'translateX(28px) scale(.985)' }, { opacity: 1, transform: 'none' }],
                { duration: 420, easing: LAYOUT_EASING },
            );
            continue;
        }
        const dx = old.left - now.left;
        const dy = old.top - now.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        card.animate(
            [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
            { duration: 460, easing: LAYOUT_EASING },
        );
    }
}

function wirePhotoSlots() {
    $('photo-input').onchange = event => {
        if (event.target.files?.[0]) setPhoto('main', event.target.files[0]);
    };
    $('subject-input').onchange = event => {
        if (event.target.files?.[0]) setPhoto('subject', event.target.files[0]);
    };
    // An empty block opens the file picker; a filled one stays inert so a click only
    // focuses it for Ctrl+V (full screen lives in the block's header).
    document.querySelectorAll('.ref-block .ref-drop').forEach(drop => {
        const block = drop.closest('.ref-block');
        drop.addEventListener('click', event => {
            if (block.classList.contains('is-filled') || event.target.closest('.ref-url')) return;
            (block.dataset.slot === 'subject' ? $('subject-input') : $('photo-input')).click();
        });
    });
    document.querySelectorAll('[data-remove]').forEach(button => {
        button.onclick = event => {
            event.stopPropagation();
            clearPhoto(button.dataset.remove);
        };
    });
    document.querySelectorAll('[data-view-ref]').forEach(button => {
        button.onclick = () => openViewer({ kind: 'ref', slot: button.dataset.viewRef });
    });
    document.querySelectorAll('[data-url]').forEach(form => {
        const input = form.querySelector('input');
        form.onsubmit = event => {
            event.preventDefault();
            importImageUrl(input.value, form.dataset.url);
        };
        // A pasted link is imported right away.
        input.addEventListener('paste', () => setTimeout(() => {
            if (/^https?:\/\/\S+$/i.test(input.value.trim())) importImageUrl(input.value, form.dataset.url);
        }));
    });
    for (const [element, slot] of [[$('ref-main'), 'main'], [$('ref-subject'), 'subject'], [$('prompt-box'), 'main']]) {
        element.addEventListener('focusin', () => { state.slotFocus = slot; });
        element.addEventListener('pointerdown', () => { state.slotFocus = slot; });
        ['dragenter', 'dragover'].forEach(name => element.addEventListener(name, event => {
            const types = [...(event.dataTransfer?.types || [])];
            if (!types.includes('Files') && !types.includes('text/uri-list')) return;
            event.preventDefault();
            element.classList.add('is-dragging-reference');
        }));
        ['dragleave', 'drop'].forEach(name => element.addEventListener(name, () => {
            element.classList.remove('is-dragging-reference');
        }));
        element.addEventListener('drop', event => {
            const file = [...(event.dataTransfer?.files || [])].find(item => item.type.startsWith('image/'));
            // An image dragged from another browser tab often arrives as a link only.
            const link = (event.dataTransfer?.getData('text/uri-list') || '').split('\n').find(line => /^https?:/i.test(line.trim()));
            if (!file && !link) return;
            event.preventDefault();
            if (file) acceptImage(file, slot);
            else importImageUrl(link.trim(), slot);
        });
    }
    // An image on the clipboard goes to the focused slot and replaces the photo already
    // there, so pictures copied one after another from a browser simply swap in. Text pastes
    // are left alone, except an image link (or a link pasted outside the text fields).
    document.addEventListener('paste', event => {
        const data = event.clipboardData;
        const item = [...(data?.items || [])].find(entry => entry.kind === 'file' && entry.type.startsWith('image/'));
        const file = item?.getAsFile() || [...(data?.files || [])].find(entry => entry.type.startsWith('image/'));
        if (file) {
            event.preventDefault();
            acceptImage(file, state.slotFocus);
            return;
        }
        const text = data?.getData('text/plain')?.trim() || '';
        // "Copy image" in some browsers puts only the <img> markup on the clipboard.
        const htmlImage = !text && /<img[^>]+src=["'](https?:\/\/[^"']+)["']/i.exec(data?.getData('text/html') || '')?.[1];
        const link = htmlImage || (/^https?:\/\/\S+$/i.test(text) ? text : '');
        if (!link) return;
        const typing = event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]');
        const imageLink = htmlImage || /\.(?:png|jpe?g|webp|gif|avif|bmp)(?:[?#]\S*)?$/i.test(link);
        // A link field of a photo block handles its own paste.
        if (typing && (!imageLink || event.target.closest('[data-url]'))) return;
        event.preventDefault();
        importImageUrl(link.replace(/&amp;/g, '&'), state.slotFocus);
    });
}

/** Download an image from a link on the server (browsers block most foreign images). */
async function importImageUrl(url, slot) {
    const link = String(url || '').trim();
    if (!/^https?:\/\//i.test(link)) {
        error('Not an image link', 'Paste a link that starts with http:// or https://.');
        return;
    }
    const target = slot === 'subject' && takesSubject() ? 'subject' : 'main';
    const block = $(`ref-${target}`);
    const loading = block?.querySelector('.ref-loading');
    if (loading) loading.hidden = false;
    try {
        const data = await json('/api/simple/fetch-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: link }),
        });
        const blob = await (await fetch(data.data_url)).blob();
        const added = await acceptImage(new File([blob], data.name || 'image', { type: blob.type }), target);
        if (added !== false && block) block.querySelector('.ref-url input').value = '';
    } catch (err) {
        error('Could not add the image from the link', err.message);
    } finally {
        if (loading) loading.hidden = true;
    }
}

function acceptImage(file, slot) {
    const target = slot === 'subject' && takesSubject() ? 'subject' : 'main';
    return setPhoto(target, file);
}

// --- agent ---------------------------------------------------------------------------

/** The agent Create runs with: the model picked in the agent menu, else the default model. */
function currentAgent() {
    const choice = state.agentChoice;
    if (choice) return { label: agentLabel(choice), sees_images: choice.vision !== false, choice };
    if (!state.agentStatus) return null;
    const agent = jobMode() === 'text' ? state.agentStatus.text : state.agentStatus.photo;
    return agent ? { ...agent, label: agent.name || shortModel(agent.model) } : null;
}

function shortModel(model) {
    const value = String(model || '');
    return value.includes('/') ? value.slice(value.indexOf('/') + 1) : value;
}

/** "OpenCode · Exo Free", "Codex · GPT-6"; the reasoning chip beside it shows the level. */
function agentLabel(choice) {
    const host = AGENT_HOSTS[choice.agentKind] || choice.groupLabel || 'API';
    return [host, choice.name || shortModel(choice.model)].filter(Boolean).join(' · ');
}

/** What the agent call needs to run the picked model. */
function agentRequestFields() {
    const choice = state.agentChoice;
    if (!choice) return {};
    return {
        agent_host: choice.agentKind,
        agent_model: choice.model,
        agent_variant: choice.agentKind === 'antigravity' ? null : choice.variant || null,
    };
}

async function loadAgentStatus() {
    try {
        state.agentStatus = await json('/api/simple/agent-status');
    } catch {
        state.agentStatus = { available: false, text: null, photo: null, instruction_files: [] };
    }
    paintAgentLine();
}

/** The "Models" button in the prompt box; the active model shows in the card header. */
function paintAgentLine() {
    const line = $('agent-line');
    const current = $('agent-current');
    if (!line || !current) return;
    line.classList.remove('is-missing');
    current.classList.remove('is-missing');
    // Own prompt runs without an agent: the button and the model name step aside.
    const manual = state.mode === 'prompt' && !state.enhance;
    $('prompt-box').classList.toggle('is-manual', manual);
    current.hidden = manual;
    paintAgentReasoning();
    // An open menu follows the mode: models that cannot see photos dim in photo modes.
    if (!$('agent-menu').hidden) paintAgentMenu();
    const show = (text, title, missing = false) => {
        current.textContent = text;
        current.title = title;
        line.title = missing ? title : 'Choose the model';
        line.classList.toggle('is-missing', missing);
        current.classList.toggle('is-missing', missing);
    };
    if (!state.agentStatus && !state.agentChoice) {
        show('Checking the model…', '');
        return;
    }
    const agent = currentAgent();
    if (!agent) {
        show(needsVision() ? 'Choose a model that sees photos' : 'No model', 'Choose a model in Models', true);
        return;
    }
    if (needsVision() && !agent.sees_images) {
        show(`${agent.label} · cannot see photos`, 'This mode needs a model that sees photos: choose one in Models', true);
        return;
    }
    show(agent.label, jobMode() !== 'text' && agent.sees_images ? `${agent.label} · sees the photo` : agent.label);
}

// --- agent menu --------------------------------------------------------------------------

function saveAgentChoice() {
    try {
        if (state.agentChoice) localStorage.setItem('mediastudio_create_agent', JSON.stringify(state.agentChoice));
        else localStorage.removeItem('mediastudio_create_agent');
    } catch {}
    paintAgentLine();
}

function restoreAgentCatalog() {
    try {
        const saved = JSON.parse(localStorage.getItem(AGENT_CATALOG_KEY) || 'null');
        if (saved?.version !== 2 || !Array.isArray(saved.payload?.groups)) return;
        state.agents = withoutHostErrors(saved.payload);
        state.agentsSavedAt = Number(saved.savedAt) || 0;
    } catch {}
}

/**
 * The saved catalog keeps only models: a host error (OpenCode still starting, a CLI offline) belongs to
 * that answer, and showing it again on the next visit would look like a fresh failure until the new list arrives.
 */
function withoutHostErrors(payload) {
    const groups = payload.groups
        .filter(group => group.models?.length)
        .map(group => ({ ...group, error: null }));
    return { ...payload, groups };
}

function saveAgentCatalog(payload) {
    const savedAt = Date.now();
    try { localStorage.setItem(AGENT_CATALOG_KEY, JSON.stringify({ version: 2, savedAt, payload: withoutHostErrors(payload) })); } catch {}
    state.agentsSavedAt = savedAt;
}

/** Integrations › Models changed which models are shown after this list was saved. */
function agentCatalogStale() {
    let changedAt = 0;
    try { changedAt = Number(localStorage.getItem(MODELS_CHANGED_KEY)) || 0; } catch {}
    const savedAt = state.agentsSavedAt || 0;
    return Date.now() - savedAt >= AGENT_CATALOG_TTL || changedAt > savedAt;
}

function mergeAgentCatalog(previous, next) {
    const before = new Map((previous?.groups || []).map(group => [group.id, group]));
    // A host error keeps the last good models of that host, with their original cards.
    const groups = next.groups.map(group => (group.error && before.get(group.id)?.models?.length
        ? { ...group, models: before.get(group.id).models }
        : group));
    return { ...next, groups };
}

function findAgentModel(choice) {
    for (const group of state.agents?.groups || []) {
        if (group.host !== choice.agentKind) continue;
        const id = choice.agentKind === 'antigravity' ? choice.base : choice.model;
        const model = group.models.find(item => item.id === id);
        if (model) return { group, model };
    }
    return null;
}

async function loadAgents(refresh = false) {
    if (state.agentsLoading) return;
    state.agentsLoading = true;
    state.agentsError = '';
    $('agent-refresh').disabled = true;
    if (state.agents) paintAgentMenu();
    else $('agent-menu-body').innerHTML = '<p class="agent-menu-note" role="status">Asking the connected providers for their models…</p>';
    try {
        const next = await json(`/api/ai/models?visible=1${refresh ? '&refresh=1' : ''}`);
        state.agents = mergeAgentCatalog(state.agents, next);
        saveAgentCatalog(state.agents);
    } catch (err) {
        state.agentsError = err.message;
        if (state.agents) paintAgentMenu();
        else $('agent-menu-body').innerHTML = `<p class="agent-menu-note is-error">${esc(err.message)}</p>`;
        return;
    } finally {
        state.agentsLoading = false;
        $('agent-refresh').disabled = false;
    }
    // A picked model keeps its card up to date (vision, name, reasoning levels).
    const found = state.agentChoice ? findAgentModel(state.agentChoice) : null;
    if (found) {
        state.agentChoice = agentChoiceFor(found.group, found.model, state.agentChoice);
        saveAgentChoice();
    }
    paintAgentMenu();
}

/** The choice for one model of a group, keeping the reasoning level picked before when it exists. */
function agentChoiceFor(group, model, previous = null) {
    const base = {
        agentKind: group.host, groupLabel: group.label, model: model.id, name: model.name, vision: model.vision,
    };
    if (group.host === 'antigravity') {
        const levels = model.levels || [];
        const level = levels.find(item => item.level === previous?.level)
            || levels.find(item => item.level === 'medium')
            || levels[0];
        return { ...base, base: model.id, levels, model: level ? level.id : model.model || model.id, level: level ? level.level : null };
    }
    const variants = model.variants || [];
    return { ...base, variants, variant: previous?.variant && variants.includes(previous.variant) ? previous.variant : null };
}

// Seeing photos is the norm; only the exceptions and free models get a mark.
function agentTags(model) {
    return [
        model.vision === false ? '<span class="agent-tag">Text only</span>' : '',
        model.free ? '<span class="agent-tag">Free</span>' : '',
    ].join('');
}

const REASONING_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** Reasoning levels from the lightest to the deepest; unknown names keep their place at the end. */
function sortedLevels(items, name = item => item) {
    const rank = item => {
        const index = REASONING_ORDER.indexOf(name(item));
        return index < 0 ? REASONING_ORDER.length : index;
    };
    return [...items].sort((a, b) => rank(a) - rank(b));
}

/** The levels the picked model offers: [value, label]; Antigravity has no "Default". */
function agentReasoningChoices(choice) {
    if (!choice) return [];
    if (choice.agentKind === 'antigravity') return sortedLevels(choice.levels || [], item => item.level).map(item => [item.id, item.level]);
    const variants = sortedLevels(choice.variants || []);
    return variants.length ? [['', 'Default'], ...variants.map(variant => [variant, variant])] : [];
}

/** The reasoning chip beside the agent line, for a model picked in Create that offers levels. */
function paintAgentReasoning() {
    const wrap = $('agent-reasoning-wrap');
    const select = $('agent-reasoning');
    if (!wrap || !select) return;
    const choices = agentReasoningChoices(state.agentChoice);
    wrap.hidden = !choices.length;
    if (!choices.length) return;
    select.innerHTML = choices.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
    select.value = state.agentChoice.agentKind === 'antigravity' ? state.agentChoice.model : state.agentChoice.variant || '';
}

function agentReasoning(group, model, choice) {
    if (group.host === 'antigravity') {
        if (!model.levels?.length) return '';
        return `<div class="agent-reasoning"><span>Reasoning</span><div class="agent-variants">${sortedLevels(model.levels, item => item.level).map(item => `<button type="button" aria-pressed="${choice.model === item.id}" class="agent-variant${choice.model === item.id ? ' active' : ''}" data-agent-level="${esc(item.id)}">${esc(item.level)}</button>`).join('')}</div></div>`;
    }
    if (!model.variants?.length) return '';
    return `<div class="agent-reasoning"><span>Reasoning</span><div class="agent-variants">${['', ...sortedLevels(model.variants)].map(variant => `<button type="button" aria-pressed="${(choice.variant || '') === variant}" class="agent-variant${(choice.variant || '') === variant ? ' active' : ''}" data-agent-variant="${esc(variant)}">${esc(variant || 'Default')}</button>`).join('')}</div></div>`;
}

function paintAgentMenu() {
    const body = $('agent-menu-body');
    if ($('agent-menu').hidden || !state.agents) return;
    const focused = document.activeElement;
    const focusData = focused && body.contains(focused) ? { ...focused.dataset } : null;
    const choice = state.agentChoice;
    const picked = choice ? findAgentModel(choice) : null;
    const vision = needsVision();
    const parts = [];
    if (state.agentsError) parts.push(`<p class="agent-menu-note is-error">${esc(state.agentsError)} · Showing the saved model list.</p>`);
    for (const group of state.agents.groups || []) {
        const rows = group.models
            .slice()
            .sort((a, b) => Number(b.vision === true) - Number(a.vision === true) || a.name.localeCompare(b.name))
            .map(model => {
                const active = picked?.group.id === group.id && picked.model.id === model.id;
                const blocked = vision && model.vision === false;
                return `<button type="button" aria-pressed="${active}" class="agent-option${active ? ' active' : ''}${blocked ? ' is-blocked' : ''}" data-agent-group="${esc(group.id)}" data-agent-model="${esc(model.id)}" title="${esc(model.id)}"><span class="agent-option-name">${esc(model.name)}</span>${agentTags(model)}</button>`;
            }).join('');
        const reasoning = picked?.group.id === group.id ? agentReasoning(group, picked.model, choice) : '';
        parts.push(`<section class="agent-group"><header><strong>${esc(group.label)}</strong>${group.source ? `<small>${esc(group.source)}</small>` : ''}</header>`
            + (group.error ? `<p class="agent-menu-note is-error">${esc(group.error)}</p>` : '')
            + (rows ? `<div class="agent-options">${rows}</div>` : '')
            + reasoning + '</section>');
    }
    if (choice) parts.push('<button type="button" class="agent-menu-link agent-reset" data-agent-reset>Use the default model</button>');
    if (!parts.length) parts.push('<p class="agent-menu-note">No model is shown. Connect a provider or show its models in Integrations.</p>');
    body.innerHTML = parts.join('');
    if (focusData) {
        const replacement = [...body.querySelectorAll('button')].find(button =>
            Object.entries(focusData).every(([key, value]) => button.dataset[key] === value));
        replacement?.focus({ preventScroll: true });
    }
}

function placeAgentMenu() {
    const menu = $('agent-menu');
    const anchor = $('prompt-box').getBoundingClientRect();
    const line = $('agent-line').getBoundingClientRect();
    const viewTop = Math.max(12, (document.querySelector('.simple-header')?.getBoundingClientRect().bottom || 0) + 8);
    const lineTop = Math.min(window.innerHeight - 16, Math.max(viewTop, line.top));
    const lineBottom = Math.min(window.innerHeight - 16, Math.max(viewTop, line.bottom));
    const width = Math.min(Math.max(anchor.width, 320), window.innerWidth - 24);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12))}px`;
    const below = window.innerHeight - lineBottom - 16;
    const above = lineTop - viewTop - 8;
    if (below >= 300 || below >= above) {
        menu.style.top = `${lineBottom + 8}px`;
        menu.style.bottom = '';
        menu.style.maxHeight = `${Math.max(120, below)}px`;
    } else {
        menu.style.top = '';
        menu.style.bottom = `${window.innerHeight - lineTop + 8}px`;
        menu.style.maxHeight = `${Math.max(120, above)}px`;
    }
}

function openAgentMenu() {
    const menu = $('agent-menu');
    menu.hidden = false;
    $('agent-line').setAttribute('aria-expanded', 'true');
    placeAgentMenu();
    $('agent-refresh').focus({ preventScroll: true });
    if (state.agents) {
        paintAgentMenu();
        if (agentCatalogStale()) loadAgents();
    } else loadAgents();
}

function closeAgentMenu() {
    $('agent-menu').hidden = true;
    $('agent-line').setAttribute('aria-expanded', 'false');
}

function wireAgentMenu() {
    $('agent-line').onclick = () => ($('agent-menu').hidden ? openAgentMenu() : closeAgentMenu());
    $('agent-refresh').onclick = () => loadAgents(true);
    $('agent-reasoning').addEventListener('change', event => {
        const choice = state.agentChoice;
        if (!choice) return;
        if (choice.agentKind === 'antigravity') {
            const level = (choice.levels || []).find(item => item.id === event.target.value);
            if (level) Object.assign(choice, { model: level.id, level: level.level });
        } else choice.variant = event.target.value || null;
        saveAgentChoice();
    });
    $('agent-menu-body').addEventListener('click', event => {
        const target = event.target.closest('button');
        if (!target) return;
        const choice = state.agentChoice;
        if (target.dataset.agentModel) {
            const group = (state.agents?.groups || []).find(item => item.id === target.dataset.agentGroup);
            const model = group?.models.find(item => item.id === target.dataset.agentModel);
            if (!model) return;
            state.agentChoice = agentChoiceFor(group, model, choice?.agentKind === group.host ? choice : null);
            saveAgentChoice();
        } else if ('agentVariant' in target.dataset && choice && choice.agentKind !== 'antigravity') {
            choice.variant = target.dataset.agentVariant || null;
            saveAgentChoice();
        } else if (target.dataset.agentLevel && choice?.agentKind === 'antigravity') {
            const level = (choice.levels || []).find(item => item.id === target.dataset.agentLevel);
            if (!level) return;
            Object.assign(choice, { model: level.id, level: level.level });
            saveAgentChoice();
        } else if ('agentReset' in target.dataset) {
            state.agentChoice = null;
            saveAgentChoice();
        }
    });
    document.addEventListener('pointerdown', event => {
        if ($('agent-menu').hidden || event.target.closest('#agent-menu, #agent-line')) return;
        closeAgentMenu();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !$('agent-menu').hidden) {
            closeAgentMenu();
            $('agent-line').focus();
        }
    });
    window.addEventListener('resize', () => { if (!$('agent-menu').hidden) placeAgentMenu(); });
}

const AGENT_PHASES = {
    started: 'The agent is reading the task…',
    thinking: 'The agent is thinking…',
    working: 'The agent is working…',
    writing: 'The agent is writing the prompt…',
};
const AGENT_LOG_LINES = 6;

function startAgentTimer(started = Date.now()) {
    clearInterval(state.agentTimer);
    state.agentPhase = 'started';
    state.agentName = currentAgent()?.label || 'Agent';
    const tick = () => {
        const seconds = Math.round((Date.now() - started) / 1000);
        setGenerating(AGENT_PHASES[state.agentPhase] || AGENT_PHASES.started, `${state.agentName} · ${seconds} s`);
        createButton(true, Math.min(7, 2 + seconds / 20), `Agent · ${seconds} s`);
    };
    state.agentTick = tick;
    tick();
    state.agentTimer = setInterval(tick, 1000);
}

function resetAgentStream() {
    $('agent-stream').hidden = true;
    $('agent-stream-log').replaceChildren();
    $('agent-stream-text').hidden = true;
    $('agent-stream-text').textContent = '';
}

/** One server-sent progress event of the agent: phase, a journal line or the prompt text. */
function paintAgentProgress(event) {
    if (event.phase === 'started' && event.agent) state.agentName = event.agent;
    if (AGENT_PHASES[event.phase]) state.agentPhase = event.phase;
    if (event.log) {
        const log = $('agent-stream-log');
        const item = document.createElement('li');
        item.textContent = event.log;
        item.title = event.log;
        log.append(item);
        while (log.children.length > AGENT_LOG_LINES) log.firstElementChild.remove();
        $('agent-stream').hidden = false;
    }
    if (event.text) {
        const text = $('agent-stream-text');
        text.textContent = event.text;
        text.hidden = false;
        $('agent-stream').hidden = false;
    }
    state.agentTick?.();
}

function stopAgentTimer() {
    clearInterval(state.agentTimer);
    state.agentTimer = null;
    state.agentTick = null;
}

// --- health --------------------------------------------------------------------------

function paintHealth(health) {
    state.health = health || {};
    const badge = $('model-health');
    const statusText = $('model-status-text');
    const panel = $('model-health-panel');
    const install = $('model-install');
    const resources = health?.missing_resources || [];
    const nodes = health?.missing_nodes || [];
    const modeBlocked = health?.status === 'ready' && health?.modes_ready?.[jobMode()] === false;
    // Offline is a runtime state, not a setup problem: installed files are checked on disk.
    const offline = health?.comfyui_online === false;
    let className = 'is-checking';
    let label = 'Checking';
    let text = 'Checking local components';
    if (state.backend === 'colab') {
        [className, label, text] = colabStatusLine();
    } else if (state.runtimeBusy) {
        [className, label, text] = ['is-starting', 'Starting', 'Starting ComfyUI'];
    } else if (health?.status === 'ready' && !modeBlocked) {
        [className, label, text] = offline
            ? ['is-idle', 'Not running', 'Components installed · ComfyUI starts with the first run']
            : ['is-ready', 'Ready', 'Everything is installed'];
    } else if (modeBlocked) {
        className = 'is-missing';
        label = health.restart_required ? 'Restart ComfyUI' : 'Setup needed';
        text = health.restart_required
            ? 'Restart ComfyUI to load the photo-edit nodes'
            : 'Photo editing needs extra ComfyUI nodes';
    } else if (health?.status === 'not_installed') {
        [className, label] = ['is-missing', 'Setup needed'];
        text = `${resources.length} component${resources.length === 1 ? '' : 's'} missing`;
    } else if (health?.status === 'workflow_pending') {
        [className, label, text] = ['is-pending', 'Not ready', 'The recipe is not prepared yet'];
    } else if (health?.status === 'unknown') {
        [className, label, text] = state.runtimeConfig && !state.runtimeConfig.install_path
            ? ['is-checking', 'Not connected', 'ComfyUI Desktop was not found on this computer']
            : ['is-checking', 'Not checked', 'ComfyUI is offline; components will be checked when it starts'];
    }
    badge.className = `model-health-badge ${className}`;
    badge.textContent = label;
    statusText.textContent = text;
    statusText.title = text;
    // Only what needs the user's action stays in the line; a start shows in the launch toast.
    const problem = ['is-missing', 'is-pending'].includes(className) || label === 'Not connected';
    $('model-status').classList.toggle('is-quiet', !problem);
    paintRuntimeAction();
    paintLaunch();
    $('model-health-message').textContent = resources.length || nodes.length
        ? (offline ? 'Missing on disk:' : 'Missing:')
        : '';
    $('model-missing').innerHTML = [
        ...resources.map(item => `<div class="model-missing-row"><span>${esc(item.display_name || item.filename)}</span><small>${esc(item.folder || '')}</small></div>`),
        ...nodes.map(item => `<div class="model-missing-row"><span>${esc(item.display_name || item.id)}</span><small>${item.installed_on_disk ? 'installed, restart ComfyUI' : 'ComfyUI nodes'}</small></div>`),
    ].join('');
    const activeDownloads = state.downloads.some(item => ['queued', 'downloading'].includes(item.status));
    const failedDownloads = state.downloads.some(item => ['failed', 'error'].includes(item.status));
    const canInstall = health?.installable !== false && (health?.status === 'not_installed' || nodes.some(item => !item.installed_on_disk));
    install.hidden = !canInstall;
    install.disabled = activeDownloads;
    install.querySelector('span').textContent = activeDownloads ? 'Downloading…' : 'Download missing';
    panel.hidden = !(resources.length || nodes.length || activeDownloads || failedDownloads);
}

async function loadHealth(force = false) {
    const id = state.modelId;
    if (!id) return;
    try {
        const data = await json(`/api/simple/models/${encodeURIComponent(id)}/status${force ? '?refresh=1' : ''}`);
        paintHealth(data.health || {});
    } catch {
        if (!state.health || state.health.status === 'checking') paintHealth({ status: 'unknown' });
    }
}

function blocking() {
    const health = state.health || {};
    if (state.backend === 'colab' && health.backend?.signed_in === false) {
        return 'Sign in to Google in Integrations › Remote GPU, or switch Create to This PC.';
    }
    if (state.backend === 'colab' && health.backend?.civitai_ready === false) {
        return 'Colab downloads Moody Krea2 from Civitai: add your Civitai API key in the ComfyUI settings (gear icon) or in Integrations › Model sources. It stays on this computer.';
    }
    if (health.status === 'not_installed') return 'Download the missing components first.';
    if (health.status === 'workflow_pending') return 'The recipe is not prepared yet.';
    if (health.status === 'ready' && health.modes_ready?.[jobMode()] === false) {
        return health.restart_required
            ? 'Restart ComfyUI so it loads the photo-edit nodes.'
            : 'Photo editing needs extra ComfyUI nodes: press "Download missing".';
    }
    return '';
}

// --- create flow ---------------------------------------------------------------------

async function create() {
    if (state.job) return;
    const mode = jobMode();
    const request = $('prompt').value.trim();
    if (state.mode !== 'prompt' && !state.photo) {
        return error('Add a photo', 'This mode needs a photo: drop it here, choose a file or paste it with Ctrl+V.');
    }
    if (mode === 'edit' && !request) return error('Nothing to change', 'Describe what to change in the photo.');
    const enhance = state.mode !== 'prompt' || state.enhance;
    if (!enhance && !request) return error('Nothing to create', 'Write the prompt for the model.');
    if (mode === 'text' && !request) return error('Nothing to create', 'Describe the picture you want.');
    const why = blocking();
    if (why) return error('Not ready yet', why);
    const agent = enhance ? currentAgent() : null;
    const vision = needsVision(mode, enhance);
    const useAgent = Boolean(agent) && !(vision && !agent.sees_images);
    if (vision && !useAgent) {
        return error('This needs an agent that sees photos', state.mode === 'prompt'
            ? 'Pick a model marked "Photos" in the agent menu under the prompt, or turn off "Improve with AI" and write the prompt yourself.'
            : 'Pick a model marked "Photos" in the agent menu under the prompt, or use "Edit".');
    }
    if (state.mode === 'prompt' && enhance && !useAgent) {
        return error('No agent to improve the prompt', 'Pick a model in the agent menu under the prompt, or turn off "Improve with AI".');
    }
    hideError();
    hideNote();
    const job = { phase: 'agent', cancelled: false };
    state.job = job;
    paintRuntimeAction();
    state.resultRequest += 1; // a late restored result must not cover this run
    canvas('generating');
    $('generation-stop').hidden = false;
    const photo = mode === 'text' ? null : state.photo;
    const subject = takesSubject(mode) ? state.subject : null;
    const copy = REF_COPY[state.mode];
    state.resultRefs = [
        photo && { label: copy.main[0], src: photo.dataUrl },
        subject && { label: copy.subject[0], src: subject.dataUrl },
    ].filter(Boolean);
    const ratio = currentRatio(mode);
    await submitCreateTask({
        use_agent: useAgent, profile_id: state.modelId, mode, request,
        prompt: useAgent ? null : request,
        previous_prompt: state.refineFrom?.mode === mode ? state.refineFrom.prompt : null,
        ...(useAgent ? agentRequestFields() : {}), aspect_ratio: ratio, batch_size: state.batch,
        reference_image: photo?.dataUrl || null, subject_image: subject?.dataUrl || null,
        photo_name: photo?.name || null, subject_name: subject?.name || null,
        denoise: mode === 'variation' ? state.denoise : null,
    }, { mode, photo, subject, ratio, userRequest: request, denoise: state.denoise,
        prompt: useAgent ? undefined : request }, job);
}

/** Reruns use the same background pipeline, with the prompt already prepared. */
async function runGeneration(plan, job = { phase: 'queue', cancelled: false }) {
    await submitCreateTask({
        use_agent: false, profile_id: state.modelId, mode: runMode(plan),
        request: plan.userRequest || '', prompt: plan.prompt,
        negative_prompt: runMode(plan) === 'edit' ? plan.negative || '' : null,
        edit_profile: runMode(plan) === 'edit' ? plan.editProfile || null : null,
        denoise: runMode(plan) === 'variation' ? (plan.denoise ?? DENOISE_DEFAULT) : null,
        reference_image: plan.photo?.dataUrl || null, subject_image: plan.subject?.dataUrl || null,
        photo_name: plan.photo?.name || null, subject_name: plan.subject?.name || null,
        aspect_ratio: plan.ratio, batch_size: state.batch, agent_name: plan.agentName,
    }, plan, job);
}

const CREATE_TASK_KEY = 'mediastudio_create_task';

function savedCreateTask() {
    try { return localStorage.getItem(CREATE_TASK_KEY); } catch { return null; }
}

async function submitCreateTask(payload, plan, job) {
    state.job = job;
    job.taskId = crypto.randomUUID();
    job.plan = plan;
    job.startedAt = Date.now();
    job.phase = payload.use_agent ? 'agent' : 'queue';
    save(CREATE_TASK_KEY, job.taskId);
    canvas('generating');
    $('generation-stop').hidden = false;
    resetAgentStream();
    if (payload.use_agent) startAgentTimer(job.startedAt);
    else paintTaskQueue(job);
    try {
        const data = await json('/api/simple/tasks', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payload, task_id: job.taskId, session_id: sessions?.currentSessionId() || null }),
        });
        sessions?.sessionRunStarted();
        if (state.job !== job) return;
        await applyTaskSnapshot(job, data);
        if (state.job === job) pollRuns(job);
    } catch (err) {
        if (state.job !== job) return;
        if (err.status) {
            try { localStorage.removeItem(CREATE_TASK_KEY); } catch {}
            abortJob();
            handleGenerateError(err);
        } else {
            showNote('Reconnecting to the task…');
            pollRuns(job);
        }
    }
}

function paintTaskQueue(job) {
    stopAgentTimer();
    const kind = job.backend || state.backend;
    job.launch = kind === 'colab' ? 'colab' : state.health?.comfyui_online === false ? 'local' : null;
    job.launchStartedAt ||= job.startedAt;
    canvas('generating');
    setGenerating('Queued', launchWaitText(job.launch || kind));
    createButton(true, 8, 'Queueing…');
    paintLaunch();
    paintRuntimeAction();
}

async function taskPhoto(dataUrl, name) {
    if (!dataUrl) return null;
    const image = new Image();
    await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = dataUrl;
    });
    return { dataUrl, objectUrl: dataUrl, name: name || 'photo', width: image.naturalWidth, height: image.naturalHeight };
}

async function restoreCreateTask() {
    const taskId = savedCreateTask();
    if (!taskId || state.job) return;
    const job = { taskId, phase: 'restoring', cancelled: false, plan: {}, startedAt: Date.now() };
    state.job = job;
    state.resultRequest += 1;
    canvas('generating');
    setGenerating('Restoring the task…');
    createButton(true, 2, 'Reconnecting…');
    $('generation-stop').hidden = false;
    try {
        const data = await json('/api/simple/tasks/' + encodeURIComponent(taskId) + '?include_request=1');
        if (state.job !== job) return;
        const req = data.request;
        const [photo, subject] = await Promise.all([
            taskPhoto(req.reference_image, req.photo_name), taskPhoto(req.subject_image, req.subject_name),
        ]);
        if (state.job !== job) return;
        state.photo = photo;
        state.subject = subject;
        state.batch = req.batch_size;
        state.denoise = req.denoise ?? state.denoise;
        const mode = req.mode;
        if (mode === 'text') state.ratio = req.aspect_ratio;
        else if (mode !== 'variation') state.photoRatio = req.aspect_ratio;
        if (uiMode(mode) === 'prompt') state.enhance = Boolean(req.use_agent);
        $('prompt').value = req.request || '';
        $('prompt').dispatchEvent(new Event('input'));
        setMode(uiMode(mode));
        syncBatch();
        paintDenoise();
        job.plan = { mode, photo, subject, ratio: req.aspect_ratio,
            userRequest: req.request, denoise: req.denoise };
        const copy = REF_COPY[uiMode(mode)];
        state.resultRefs = [
            photo && { label: copy.main[0], src: photo.dataUrl },
            subject && { label: copy.subject[0], src: subject.dataUrl },
        ].filter(Boolean);
        job.startedAt = Date.parse(data.created_at.replace(' ', 'T') + 'Z') || Date.now();
        await applyTaskSnapshot(job, data);
        if (state.job === job) pollRuns(job);
    } catch (err) {
        if (state.job !== job) return;
        if (err.status === 404) {
            try { localStorage.removeItem(CREATE_TASK_KEY); } catch {}
            abortJob();
            error('Task not found', 'The saved task is no longer available in this app.');
        } else {
            state.poll = setTimeout(() => {
                if (state.job !== job) return;
                state.job = null;
                restoreCreateTask();
            }, 1500);
            showNote('Reconnecting to the task…');
        }
    }
}

async function applyTaskSnapshot(job, data) {
    if (state.job !== job) return;
    job.backend = data.backend;
    job.runtimeProgress = data.runtime_progress || null;
    const previousPhase = job.phase;
    job.phase = data.phase;
    if (data.plan) {
        const prepared = data.plan;
        const queued = data.queue_result || {};
        Object.assign(job.plan, {
            prompt: prepared.positive_prompt, negative: prepared.negative_prompt || '',
            editProfile: queued.edit_profile || prepared.edit_profile || null,
            editProfileLabel: prepared.edit_profile_label || '',
            agentName: prepared.agent?.name || null, note: prepared.note || '',
            seconds: queued.seconds_per_image || prepared.seconds_per_image || TXT2IMG_SECONDS,
            width: queued.width || prepared.width, height: queued.height || prepared.height,
        });
        stopAgentTimer();
        paintAgentProgress({ text: job.plan.prompt });
        recordTaskPlan(job, data);
        if (job.plan.note && job.shownNote !== job.plan.note) {
            job.shownNote = job.plan.note;
            showNote(job.plan.note);
        }
    }
    if (job.phase === 'agent' && !data.is_complete) {
        if (!state.agentTimer) startAgentTimer(job.startedAt);
        const progress = data.agent_progress;
        const signature = JSON.stringify(progress);
        if (progress && signature !== job.agentSignature) {
            job.agentSignature = signature;
            resetAgentStream();
            for (const log of progress.logs || []) paintAgentProgress({ log });
            paintAgentProgress({ ...progress, log: null });
        }
    } else if (job.phase === 'queue' && !data.is_complete) {
        paintTaskQueue(job);
    }
    if (job.phase === 'running' || data.run_ids?.length) {
        stopAgentTimer();
        job.runIds = data.run_ids;
        job.total = job.runIds.length;
        job.done = new Set();
        job.outputs = new Map();
        job.failed = [];
        job.live = new Map();
        job.remote = new Map();
        for (const snapshot of data.runs || []) {
            const id = snapshot.run.id;
            if (snapshot.live) job.live.set(id, snapshot.live);
            if (snapshot.remote) job.remote.set(id, snapshot.remote);
            if (snapshot.outputs?.length) job.outputs.set(id, snapshot.outputs);
            if (snapshot.is_complete) {
                job.done.add(id);
                if (snapshot.status !== 'completed') job.failed.push(snapshot);
            }
        }
        if (data.queue_result || job.phase === 'running') {
            state.lastRun = { ...job.plan, runIds: job.runIds, time: job.startedAt, taskId: job.taskId };
            persistLastRun();
            clearRefine();
        }
        const outputs = data.outputs || [];
        const signature = outputs.map(output => output.id).join(',');
        if (outputs.length && signature !== job.outputSignature) {
            job.outputSignature = signature;
            await renderResult(outputs, false);
            if (state.job !== job) return;
        } else if (!outputs.length && previousPhase !== 'running') canvas('generating');
        if (data.is_complete) {
            if (data.status === 'cancelled') job.cancelled = true;
            finishRuns(job, outputs);
            return;
        }
        const finished = job.done.size;
        const total = job.total;
        const current = Math.min(total, finished + 1);
        const progress = runProgress(job);
        createButton(true, progress.percent, total > 1 ? finished + ' of ' + total + ' ready' : progress.percent + '%');
        const detail = [job.plan.editProfileLabel, progress.stage, progress.elapsed, progress.eta].filter(Boolean).join(' · ');
        if (!outputs.length && progress.waiting) setGenerating('Queued', launchWaitText('colab'));
        else if (!outputs.length) setGenerating(total > 1 ? 'Creating image ' + current + ' of ' + total + '…' : 'Creating the image…', detail);
        paintLaunch();
        paintResultProgress(['Image ' + current + ' of ' + total, progress.stage, progress.eta].filter(Boolean).join(' · '));
    } else if (data.is_complete) {
        abortJob();
        sessions?.refreshSessions();
        if (data.status === 'cancelled') showNote('Generation was stopped.');
        else handleGenerateError({ data: data.error, status: data.error?.status, message: data.error?.error || 'The task failed.' });
    }
    paintLaunch();
}

const LIVE_STAGES = {
    queued: 'Waiting in the ComfyUI queue',
    loading: 'Loading the model',
    encoding: 'Reading the prompt',
    decoding: 'Decoding the image',
    saving: 'Saving',
    working: 'Working',
};

/** Seconds per image: measured on finished images of this job, else the profile estimate. */
function secondsPerImage(job) {
    const measured = job.runIds.map(id => job.live.get(id)?.duration_seconds).filter(value => value > 0);
    if (measured.length) return measured.reduce((sum, value) => sum + value, 0) / measured.length;
    return job.plan.seconds || TXT2IMG_SECONDS;
}

/** Progress, stage line and time left from ComfyUI's live events, with the estimate as fallback. */
function runProgress(job) {
    const total = job.total;
    const finished = job.done.size;
    const per = secondsPerImage(job);
    const currentId = job.runIds.find(id => !job.done.has(id));
    const live = currentId ? job.live.get(currentId) : null;
    const queuedAfter = Math.max(0, total - finished - 1);
    let fraction;
    let stage;
    let remaining;
    if (live && live.state !== 'queued' && live.steps) {
        fraction = Math.min(0.98, live.step / live.steps);
        // ComfyUI reports a step once it is done; show the one in progress.
        stage = live.stage === 'sampling' || (live.step > 0 && live.stage === 'working')
            ? `Step ${Math.min(live.step + 1, live.steps)} of ${live.steps}`
            : LIVE_STAGES[live.stage] || '';
        const current = live.eta_seconds ?? Math.max(1, per - (live.elapsed_seconds || 0));
        remaining = current + queuedAfter * per;
    } else {
        const elapsed = (Date.now() - job.startedAt) / 1000;
        const remote = currentId ? job.remote?.get(currentId) : null;
        if (remoteLaunching(remote) && (!live || live.state === 'queued')) {
            // The Colab GPU is still starting or fetching models: the launch toast shows that.
            return {
                percent: Math.round(8 + 90 * Math.min(0.97, finished / total)),
                stage: '',
                eta: '',
                elapsed: '',
                waiting: true,
            };
        }
        const remoteStage = remoteStageText(remote);
        if (remoteStage && (!live || live.state === 'queued')) {
            return {
                percent: Math.round(8 + 90 * Math.min(0.97, finished / total)),
                stage: remoteStage,
                eta: '',
                elapsed: `${formatDuration(elapsed)} in`,
            };
        }
        fraction = Math.min(0.9, Math.max(0, elapsed - finished * per) / per);
        stage = live ? LIVE_STAGES[live.stage] || '' : '';
        remaining = Math.max(0, per * (total - finished) - Math.max(0, elapsed - finished * per));
    }
    const elapsedNow = live?.elapsed_seconds;
    return {
        percent: Math.round(8 + 90 * Math.min(0.97, (finished + fraction) / total)),
        stage,
        eta: remaining > 0 ? `about ${formatDuration(remaining)} left` : 'almost done',
        elapsed: elapsedNow ? `${formatDuration(elapsedNow)} in` : '',
    };
}

function pollRuns(job) {
    clearInterval(state.poll);
    let polling = false;
    const tick = async () => {
        if (state.job !== job || polling) return;
        polling = true;
        try {
            const data = await json('/api/simple/tasks/' + encodeURIComponent(job.taskId));
            await applyTaskSnapshot(job, data);
        } catch (err) {
            if (state.job === job && err.status === 404) {
                abortJob();
                error('Task not found', 'The saved task is no longer available in this app.');
            }
        } finally {
            polling = false;
        }
    };
    state.poll = setInterval(tick, 1000);
    tick();
}

function finishRuns(job, outputs) {
    clearInterval(state.poll);
    state.poll = null;
    state.job = null;
    paintLaunch();
    paintRuntimeAction();
    createButton(false);
    $('generation-stop').hidden = true;
    paintResultProgress('');
    if (outputs.length) {
        renderResult(outputs, true);
        sessions?.refreshSessions();
        if (job.failed.length) showNote(`${job.failed.length} of ${job.total} images failed. ${runErrorText(job.failed[0])}`);
        return;
    }
    sessions?.refreshSessions();
    canvas(state.lastOutputs.length ? 'result' : 'idle');
    const failed = job.failed[0];
    if (job.cancelled || failed?.status === 'cancelled') {
        showNote('Generation was stopped.');
        return;
    }
    error('Generation failed', runErrorText(failed)
        || 'The run finished without a picture. ComfyUI may not have processed the task; check its log.');
}

function runErrorText(data) {
    const raw = data?.run?.error || data?.run?.last_error || '';
    if (typeof raw === 'string') return raw;
    if (raw && typeof raw === 'object') {
        const message = raw.message || raw.error || '';
        const technical = raw.technical_message || '';
        const node = raw.class_type ? ` (node: ${raw.class_type})` : '';
        return technical && technical !== message ? `${message}${node}\n${technical}` : `${message}${node}` || JSON.stringify(raw);
    }
    return '';
}

async function stopGeneration() {
    const job = state.job;
    if (!job?.taskId) return;
    $('generation-stop').disabled = true;
    try {
        const data = await json('/api/simple/tasks/' + encodeURIComponent(job.taskId) + '/cancel', { method: 'POST' });
        job.cancelled = data.status === 'cancelled';
        await applyTaskSnapshot(job, data);
    } catch (err) {
        error('Could not stop the task', err.message);
    } finally {
        $('generation-stop').disabled = false;
    }
}

function abortJob() {
    clearInterval(state.poll);
    state.poll = null;
    state.job = null;
    paintLaunch();
    paintRuntimeAction();
    stopAgentTimer();
    createButton(false);
    $('generation-stop').hidden = true;
    canvas(state.lastOutputs.length ? 'result' : 'idle');
}

function handleGenerateError(err) {
    const code = err.data?.code;
    const technical = err.data?.technical_error;
    if (err.data?.stage === 'agent' || code === 'contract_violation' || code === 'incompatible_format' || code === 'provider_error'
        || code === 'cli_error' || code === 'edit_profile_invalid' || code === 'agent_failed') {
        return error('The agent could not prepare the prompt', err.message, technical);
    }
    if (err.data?.missing_resources) {
        paintHealth({ ...(state.health || {}), status: 'not_installed', missing_resources: err.data.missing_resources, installable: true });
    }
    if (code === 'restart_required' || code === 'nodes_missing') {
        loadHealth(true);
        return error('Photo editing is not ready', code === 'restart_required'
            ? 'Restart ComfyUI so it loads the new nodes, then try again.'
            : 'Press "Download missing" to install the photo-edit nodes.');
    }
    if (err.status === 502 || err.status === 503 || code === 'comfyui_rejected' || code === 'comfyui_connection_failed') {
        return error('ComfyUI is unavailable or rejected the task',
            err.data?.suggestion || err.message || 'Make sure ComfyUI is running. Configure the address with the gear icon in the header.', technical);
    }
    return error('Could not start generation', err.message, technical);
}

function formatDuration(seconds) {
    const value = Math.round(seconds);
    if (value < 60) return `${value} s`;
    const minutes = Math.floor(value / 60);
    const rest = value % 60;
    return rest >= 10 ? `${minutes} min ${rest} s` : `${minutes} min`;
}

function setGenerating(text, sub = '') {
    $('generating-text').textContent = text;
    $('generating-sub').textContent = sub;
}

function paintResultProgress(text) {
    const node = $('result-progress');
    node.hidden = !text;
    node.textContent = text;
}

// --- results -------------------------------------------------------------------------

async function restoreLastResult() {
    const cached = getCachedJson('mediastudio_simple_last_result');
    const outputs = Array.isArray(cached?.outputs) ? cached.outputs : (cached ? [cached] : []);
    // Image URLs are cached as immutable, so a picture deleted in the Viewer or Library would
    // still load from the browser cache: ask the library which results still exist.
    const request = state.resultRequest;
    const alive = await Promise.all(outputs.map(assetExists));
    if (request !== state.resultRequest) return; // A new generation or result owns the canvas.
    return renderResult(outputs.filter((_, i) => alive[i]), false);
}

async function assetExists(output) {
    const id = Number(output?.id);
    if (!Number.isInteger(id)) return true;
    try {
        const response = await fetch(`/api/assets/${id}`, { cache: 'no-store' });
        return response.status !== 404;
    } catch {
        return true;
    }
}

/** A result deleted elsewhere on this page (the session lightbox) leaves the canvas too. */
function dropDeletedResult(assetId) {
    const outputs = state.lastOutputs || [];
    if (!outputs.some(output => Number(output.id) === Number(assetId))) return;
    const rest = outputs.filter(output => Number(output.id) !== Number(assetId));
    if (rest.length) {
        state.selectedResultIndex = Math.min(state.selectedResultIndex, rest.length - 1);
        renderResult(rest, false);
    } else {
        clearLastResult();
        if (!state.job) canvas('idle');
    }
}

function clearLastResult() {
    state.resultRequest += 1;
    state.last = null;
    state.lastOutputs = [];
    state.selectedResultIndex = 0;
    try { localStorage.removeItem('mediastudio_simple_last_result'); } catch {}
    try { sessionStorage.removeItem('mediastudio_simple_last_result'); } catch {}
}

async function renderResult(outputs, persist = false) {
    const request = ++state.resultRequest;
    const loaded = await Promise.all((Array.isArray(outputs) ? outputs : []).map(async output => {
        if (!output || typeof output !== 'object') return null;
        const url = await loadImageUrl(output);
        return url ? { ...output, preview_url: url, thumbnail_url: output.thumbnail_url || url } : null;
    }));
    if (request !== state.resultRequest) return;
    const valid = loaded.filter(Boolean);
    if (!valid.length) {
        clearLastResult();
        if (!state.job) canvas('idle');
        if (persist) error('Result not found', 'Generation finished without an available image.');
        return;
    }
    const keepIndex = state.lastOutputs.length && state.selectedResultIndex < valid.length ? state.selectedResultIndex : 0;
    state.lastOutputs = valid;
    state.selectedResultIndex = keepIndex;
    state.last = valid[keepIndex];
    updateResultView();
    try { sessionStorage.removeItem('mediastudio_simple_last_result'); } catch {}
    setCachedJson('mediastudio_simple_last_result', { outputs: valid }, true);
    canvas('result');
    if (persist && state.sound) playSuccessChime();
}

function updateResultView() {
    const outputs = state.lastOutputs || [];
    const index = Math.max(0, Math.min(outputs.length - 1, state.selectedResultIndex || 0));
    state.selectedResultIndex = index;
    const current = outputs[index] || state.last;
    if (!current) return;
    state.last = current;
    const artwork = document.querySelector('.canvas-artwork-wrap');
    if (artwork) {
        // Only the picture changes: the next-step toolbar over it stays.
        let img = $('result-img');
        if (!img) {
            img = document.createElement('img');
            img.id = 'result-img';
            img.className = 'canvas-result-img';
            img.decoding = 'async';
            artwork.prepend(img);
        }
        img.src = current.preview_url || current.thumbnail_url;
        img.alt = `Result ${index + 1}`;
        artwork.onclick = event => {
            if (!event.target.closest('#result-next')) openResultFullscreen(state.selectedResultIndex);
        };
    }
    const strip = $('result-thumbnails');
    if (outputs.length > 1) {
        strip.hidden = false;
        strip.innerHTML = outputs.map((output, i) => `<button type="button" class="canvas-thumb-btn${i === index ? ' active' : ''}" data-index="${i}" aria-label="Result ${i + 1}"><img src="${esc(output.thumbnail_url || output.preview_url)}" alt="" class="canvas-thumb-img" decoding="async"></button>`).join('');
        strip.querySelectorAll('.canvas-thumb-btn').forEach(button => {
            button.onclick = event => {
                event.stopPropagation();
                selectResultIndex(Number(button.dataset.index));
            };
        });
    } else {
        strip.hidden = true;
        strip.innerHTML = '';
    }
    for (const id of ['result-refine', 'result-prompt', 'result-regenerate']) {
        const button = $(id);
        if (button) button.disabled = !state.lastRun;
    }
}

function canvas(view) {
    const layout = $('studio-layout');
    const heroBox = $('studio-hero');
    if (heroBox) {
        const gone = view !== 'idle';
        if (!gone && heroBox.classList.contains('is-gone')) paintHero();
        else if (gone && !heroBox.classList.contains('is-gone')) stopHero();
        heroBox.classList.toggle('is-gone', gone);
    }
    animateLayout(() => {
        layout.dataset.view = view;
        $('generating').hidden = view !== 'generating';
        $('result').hidden = view !== 'result';
        $('canvas')?.classList.toggle('has-result', view === 'result');
        paintRefs();
    });
    resizePrompt();
    $('result-compare').hidden = !(view === 'result' && state.resultRefs.length);
    if (view === 'generating' || view === 'result') {
        syncCanvasAspect();
        requestAnimationFrame(() => {
            syncCanvasRowHeight();
            requestAnimationFrame(syncCanvasRowHeight);
        });
    } else {
        layout.style.removeProperty('--studio-split-height');
    }
}

function syncCanvasAspect() {
    const ratio = ratioValue();
    const defaultWidth = Math.round(Math.min(760, Math.max(360, 520 * ratio / (3 / 4))));
    const limits = canvasWidthLimits();
    const width = state.canvasWidth
        ? Math.round(Math.max(limits.min, Math.min(limits.max, state.canvasWidth)))
        : defaultWidth;
    if (state.canvasWidth) state.canvasWidth = width;
    const aspect = `${ratio.toFixed(4)} / 1`;
    $('studio-layout').style.setProperty('--canvas-column-width', `${width}px`);
    document.querySelector('.studio-canvas-card')?.style.setProperty('--canvas-aspect', aspect);
    $('canvas')?.style.setProperty('--canvas-aspect', aspect);
    syncCanvasRowHeight();
}

function syncCanvasRowHeight() {
    const layout = $('studio-layout');
    if (!layout || !['generating', 'result'].includes(layout.dataset.view)) return;
    const controls = document.querySelector('.studio-controls-card');
    const canvasCard = document.querySelector('.studio-canvas-card');
    const height = Math.max(
        Math.ceil(controls?.getBoundingClientRect().height || 0),
        Math.ceil(canvasCard?.getBoundingClientRect().height || 0),
    );
    if (height > 0) layout.style.setProperty('--studio-split-height', `${height}px`);
}

function createButton(running, percent = 0, text = 'Creating…') {
    const button = $('create');
    button.classList.toggle('running', running);
    button.disabled = running;
    $('progress-fill').style.width = `${running ? percent : 0}%`;
    $('progress-text').textContent = running ? text : 'Starting…';
}

function error(title, text, technical) {
    $('error-title').textContent = title;
    $('error-text').textContent = text || '';
    const details = $('error-details');
    details.hidden = !technical;
    $('error-technical').textContent = technical || '';
    $('error').hidden = false;
}

function hideError() { $('error').hidden = true; }

function showNote(text) {
    if (!text) return;
    $('note-text').textContent = text;
    $('note').hidden = false;
}

function hideNote() { $('note').hidden = true; }

// --- result actions ------------------------------------------------------------------

/** Run the last prompt again with a new seed: same mode, photos, edit type and noise. */
async function regenerate() {
    const run = state.lastRun;
    if (!run || state.job) return;
    const mode = runMode(run);
    const photo = mode === 'text' ? null : (run.photo || state.photo);
    if (mode !== 'text' && !photo) {
        return error('Add the photo again', 'The photo of this run is no longer loaded. Add it, then press Regenerate.');
    }
    if (state.mode !== uiMode(mode)) setMode(uiMode(mode));
    const why = blocking();
    if (why) return error('Not ready yet', why);
    hideError();
    hideNote();
    await runGeneration({
        ...run,
        mode,
        note: '',
        photo,
        subject: mode === 'edit' ? (run.subject || state.subject) : null,
        ...currentKnobs(run),
    });
}

/** A rerun takes the noise and the frame now set in the controls, not the ones of the old run. */
function currentKnobs(run) {
    const mode = runMode(run);
    return {
        // An edit keeps its frame: the agent wrote the command for it.
        ratio: mode === 'edit' ? (run.ratio || currentRatio(mode)) : currentRatio(mode),
        denoise: mode === 'variation' ? state.denoise : run.denoise,
    };
}

async function editThis({ bringReference = false } = {}) {
    const current = state.last;
    if (!current || state.job) return;
    const url = current.id ? `/api/original/${current.id}` : current.preview_url;
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const blob = await response.blob();
        const file = new File([blob], current.filename || 'result.png', { type: blob.type || 'image/png' });
        setMode('edit');
        clearPhoto('subject');
        if (!(await setPhoto('main', file))) return;
        clearRefine();
        $('prompt').value = '';
        $('prompt').dispatchEvent(new Event('input'));
        if (bringReference) {
            // The second block takes the reference; a paste or drop goes there too.
            state.slotFocus = 'subject';
            const block = $('ref-subject');
            block?.classList.add('is-wanted');
            setTimeout(() => block?.classList.remove('is-wanted'), 2400);
            showNote('This result is now the photo to edit. Add the reference (a person, a garment or a tattoo) to the second block, then describe the change.');
        } else {
            showNote('This result is now the photo to edit. Describe the next change.');
        }
        $('prompt').focus();
    } catch (err) {
        error('Could not take this image', err.message);
    }
}

function refine() {
    const run = state.lastRun;
    if (!run || state.job) return;
    const mode = runMode(run);
    if (state.mode !== uiMode(mode)) setMode(uiMode(mode));
    if (!run.agentName && uiMode(mode) === 'prompt') {
        // A prompt typed by hand: the prompt itself comes back for editing.
        $('prompt').value = run.prompt || '';
        $('prompt').dispatchEvent(new Event('input'));
        $('prompt').focus();
        return;
    }
    if (uiMode(mode) === 'prompt' && !state.enhance) {
        state.enhance = true;
        save('mediastudio_create_enhance', 'true');
        paintJobControls();
    }
    state.refineFrom = { prompt: run.prompt, mode };
    $('refine-chip').hidden = false;
    $('prompt').value = '';
    $('prompt').dispatchEvent(new Event('input'));
    $('prompt').focus();
}

function clearRefine() {
    state.refineFrom = null;
    $('refine-chip').hidden = true;
}

function downloadResult() {
    const url = state.last?.id ? `/api/original/${state.last.id}` : state.last?.preview_url;
    if (!url) return;
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = state.last.filename || `creation-${Date.now()}.png`;
    anchor.click();
}

// --- prompt dialog -------------------------------------------------------------------

function openPromptDialog(run = state.lastRun) {
    if (!run) return;
    state.dialogRun = run;
    const parts = [
        runLabel(run),
        run.agentName ? `written by ${run.agentName}` : 'typed by hand',
        run.editProfileLabel ? `edit type: ${run.editProfileLabel}` : '',
        run.mode === 'variation' ? `noise ${Number(run.denoise ?? DENOISE_DEFAULT).toFixed(2)}` : '',
    ].filter(Boolean);
    $('prompt-dialog-meta').textContent = parts.join(' · ') + (run.userRequest ? `\nRequest: ${run.userRequest}` : '');
    $('prompt-dialog-label').textContent = run.mode === 'edit' ? 'Edit command' : 'Prompt';
    $('prompt-dialog-text').value = run.prompt || '';
    $('prompt-dialog-negative-wrap').hidden = run.mode !== 'edit';
    $('prompt-dialog-negative').value = run.negative || '';
    $('prompt-backdrop').hidden = false;
    $('prompt-dialog').hidden = false;
    document.body.classList.add('simple-modal-open');
    $('prompt-dialog-text').focus();
}

function closePromptDialog() {
    if ($('prompt-dialog').hidden) return;
    $('prompt-backdrop').hidden = true;
    $('prompt-dialog').hidden = true;
    document.body.classList.remove('simple-modal-open');
}

async function rerunFromDialog() {
    const run = state.dialogRun;
    const prompt = $('prompt-dialog-text').value.trim();
    if (!run || !prompt || state.job) return;
    const mode = runMode(run);
    const photo = mode === 'text' ? null : (run.photo || state.photo);
    if (mode !== 'text' && !photo) {
        closePromptDialog();
        return error('Add the photo again', 'The photo of this run is no longer loaded. Add it, then open Prompt again.');
    }
    const why = blocking();
    if (why) return error('Not ready yet', why);
    closePromptDialog();
    hideError();
    hideNote();
    if (state.mode !== uiMode(mode)) setMode(uiMode(mode));
    await runGeneration({
        ...run,
        mode,
        prompt,
        negative: $('prompt-dialog-negative').value.trim(),
        agentName: null,
        note: '',
        photo,
        subject: run.mode === 'edit' ? (run.subject || state.subject) : null,
        ...currentKnobs(run),
    });
}

// --- session log ---------------------------------------------------------------------

function runLabel(run) {
    const mode = runMode(run);
    return mode === 'edit' && (run.subject || run.withReference) ? EDIT_REFERENCE_COPY.label : RUN_LABELS[mode];
}

function sessionRecord(run) {
    return {
        key: run.runIds?.length ? run.runIds.join(',') : `task:${run.taskId}`,
        taskId: run.taskId || null,
        status: run.status || null,
        time: run.time || Date.now(),
        mode: run.mode,
        userRequest: run.userRequest || '',
        prompt: run.prompt,
        negative: run.negative || '',
        editProfile: run.editProfile || null,
        editProfileLabel: run.editProfileLabel || '',
        denoise: run.mode === 'variation' ? (run.denoise ?? DENOISE_DEFAULT) : null,
        withReference: Boolean(run.subject || run.withReference),
        agentName: run.agentName || null,
        note: run.note || '',
        ratio: run.ratio,
        outputs: [],
    };
}

/** The agent's prompt is on the server; show it in the session log right away. */
function recordTaskPlan(job, data) {
    const signature = JSON.stringify([data.plan, data.run_ids, data.status]);
    if (job.sessionSignature === signature) return;
    job.sessionSignature = signature;
    sessions?.refreshSessions();
}

function persistLastRun() {
    try { localStorage.setItem('mediastudio_create_last_run', JSON.stringify(sessionRecord(state.lastRun))); } catch {}
}

/** A run from the session log, in the prompt window. */
function openSessionPrompt(run) {
    openPromptDialog({
        mode: run.mode,
        prompt: run.prompt,
        negative: run.negative_prompt || '',
        userRequest: run.request || '',
        agentName: run.use_agent ? run.agent_name : null,
        editProfileLabel: run.edit_profile_label || '',
        withReference: run.with_reference,
        denoise: run.denoise,
        ratio: run.aspect_ratio,
        runIds: [],
    });
}

// --- wiring --------------------------------------------------------------------------

function wire() {
    document.querySelectorAll('[data-mode]').forEach(button => {
        button.onclick = () => setMode(button.dataset.mode);
    });
    document.querySelectorAll('[data-ratio]').forEach(button => {
        button.onclick = () => {
            const ratio = button.dataset.ratio;
            if (jobMode() === 'text') {
                state.ratio = ratio;
                save('mediastudio_simple_ratio', ratio);
            } else {
                state.photoRatio = ratio;
                save('mediastudio_create_photo_ratio', ratio);
            }
            syncRatio();
        };
    });
    document.querySelectorAll('[data-batch]').forEach(button => {
        button.onclick = () => {
            state.batch = Number(button.dataset.batch);
            save('mediastudio_simple_batch', state.batch);
            syncBatch();
        };
    });
    $('enhance').onchange = () => {
        state.enhance = $('enhance').checked;
        save('mediastudio_create_enhance', String(state.enhance));
        paintJobControls();
        resizePrompt();
    };
    $('attach-photo').onclick = () => $('photo-input').click();
    wirePhotoSlots();
    wireDenoise();
    wireAgentMenu();

    $('prompt').oninput = () => {
        resizePrompt();
        $('prompt-clear').hidden = !$('prompt').value.trim();
        save('mediastudio_simple_prompt', $('prompt').value);
    };
    $('prompt-clear').onclick = () => {
        $('prompt').value = '';
        $('prompt').dispatchEvent(new Event('input'));
        $('prompt').focus();
    };
    $('refine-cancel').onclick = clearRefine;
    $('create').onclick = create;
    $('generation-stop').onclick = stopGeneration;
    $('error-close').onclick = hideError;
    $('note-close').onclick = hideNote;

    $('result-download').onclick = downloadResult;
    $('result-regenerate').onclick = regenerate;
    $('result-edit-text').onclick = () => editThis();
    $('result-edit-ref').onclick = () => editThis({ bringReference: true });
    $('result-compare').onclick = () => openViewer({ kind: 'result', index: state.selectedResultIndex }, { compare: true });
    $('result-refine').onclick = refine;
    $('result-prompt').onclick = () => openPromptDialog();

    $('prompt-dialog-close').onclick = closePromptDialog;
    $('prompt-dialog-cancel').onclick = closePromptDialog;
    $('prompt-backdrop').onclick = closePromptDialog;
    $('prompt-dialog-run').onclick = rerunFromDialog;
    $('prompt-dialog-copy').onclick = async () => {
        try { await navigator.clipboard.writeText($('prompt-dialog-text').value); } catch {}
    };


    $('model-install').onclick = installModel;
    $('model-recheck').onclick = async () => {
        const button = $('model-recheck');
        button.disabled = true;
        button.textContent = 'Checking…';
        try {
            await loadHealth(true);
            await loadDownloads();
        } finally {
            button.disabled = false;
            button.textContent = 'Check again';
        }
    };
    $('model-downloads').addEventListener('click', event => {
        const button = event.target.closest('[data-download-action]');
        if (button) downloadAction(Number(button.dataset.downloadId), button.dataset.downloadAction);
    });

    $('runtime-settings-open').onclick = openRuntimeSettings;
    $('runtime-settings-close').onclick = closeRuntimeSettings;
    $('runtime-settings-cancel').onclick = closeRuntimeSettings;
    $('runtime-settings-backdrop').onclick = closeRuntimeSettings;
    $('runtime-power').onclick = runtimePowerClick;
    $('runtime-installs').addEventListener('click', runtimeInstallClick);
    $('runtime-folders').addEventListener('click', runtimeFolderClick);
    $('runtime-rescan').onclick = rescanDesktop;
    $('runtime-action').onclick = runtimeActionClick;
    document.querySelectorAll('#backend-switch [data-backend]').forEach(button => {
        button.onclick = () => setBackend(button.dataset.backend);
    });
    $('runtime-settings-form').onsubmit = saveRuntimeSettings;

    addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            if (!$('prompt-dialog').hidden) rerunFromDialog();
            else create();
        }
        if (event.key === 'Escape') {
            closePromptDialog();
            sessions?.closeSessions();
            closeRuntimeSettings();
            closeContextMenu();
        }
    });
    addEventListener('resize', () => {
        resizePrompt();
        syncCanvasRowHeight();
    });
    document.addEventListener('lightbox:asset-deleted', event => dropDeletedResult(event.detail?.assetId));
    watchControlsHeight();
    document.addEventListener('contextmenu', openStudioContextMenu);
    document.addEventListener('click', event => {
        if (!event.target.closest('.image-context-menu')) closeContextMenu();
    });
    window.addEventListener('scroll', closeContextMenu, { passive: true });
}

function getCachedJson(key, maxAgeMs = 0) {
    try {
        const raw = sessionStorage.getItem(key) || localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (maxAgeMs > 0 && parsed?._t && (Date.now() - parsed._t > maxAgeMs)) {
            return null;
        }
        return parsed.data !== undefined ? parsed.data : parsed;
    } catch {
        return null;
    }
}

function setCachedJson(key, data, isLocal = false) {
    try {
        const payload = JSON.stringify({ data, _t: Date.now() });
        if (isLocal) {
            localStorage.setItem(key, payload);
        } else {
            sessionStorage.setItem(key, payload);
        }
    } catch {}
}

function initialAmbient() {
    try {
        const node = $('simple-ambient-initial');
        const embedded = node ? JSON.parse(node.textContent) : null;
        if (Array.isArray(embedded)) return embedded;
    } catch {}
    const cached = getCachedJson('mediastudio_simple_ambient_items', 30 * 60 * 1000);
    return Array.isArray(cached) ? cached : [];
}

async function hydrateAmbient() {
    state.ambient = initialAmbient();
    refillAmbientDeck();
    if (!state.ambient.length) { resetAmbient(); return; }
    let last = null;
    try { last = localStorage.getItem('mediastudio_simple_ambient_last'); } catch {}
    const previous = state.ambient.find(item => typeof item === 'string' ? item === last
        : [item.original_url, item.preview_url, item.thumbnail_url].includes(last));
    if (last && previous) {
        const loaded = await setAmbient(previous);
        if (loaded === null) return; // A newer selection owns the background now.
        if (!loaded) {
            try { localStorage.removeItem('mediastudio_simple_ambient_last'); } catch {}
        }
    } else if (last) {
        try { localStorage.removeItem('mediastudio_simple_ambient_last'); } catch {}
    }
    if (!document.querySelector('.ambient-container.has-ambient') && state.ambient.length) {
        await ambientPick();
    }
    preloadAmbientPool();
}

function save(key, value) {
    try { localStorage.setItem(key, String(value)); } catch {}
}

function applyVisualSettings() {
    document.documentElement.style.setProperty('--studio-card-opacity', `${state.opacity ?? 44}%`);
    document.documentElement.style.setProperty('--studio-ambient-blur', `${state.blur ?? 10}px`);
    document.documentElement.style.setProperty(
        '--studio-ambient-size',
        state.fit === 'contain' ? 'contain' : (state.fit === 'original' ? 'auto' : 'cover')
    );
    document.body.setAttribute('data-ambient-fit', state.fit || 'cover');
}

function restartAmbientTimer(force = false) {
    const interval = state.interval > 0 && state.ambient.length > 1 ? state.interval : 0;
    if (!force && state.timer && state.timerInterval === interval) return;
    if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
    }
    state.timerInterval = interval;
    if (interval) {
        state.timer = setInterval(() => ambientPick(false), interval);
    }
}

function setAmbientInterval(seconds) {
    const interval = Math.max(0, Number(seconds) || 0) * 1000;
    save('mediastudio_simple_ambient_interval', interval);
    if (interval === state.interval) return;
    state.interval = interval;
    // A load started under the old interval must not switch the image early.
    state.ambientRequest += 1;
    state.ambientPickRequest += 1;
    state.ambientPicking = false;
    restartAmbientTimer(true);
}

function ambientPoolUrl() {
    const current = Number(state.ambientCurrent);
    return '/api/simple/ambient?limit=72'
        + (Number.isSafeInteger(current) && current > 0 ? `&current_id=${current}` : '');
}

// Resolve an actual decodable image before exposing it in the result or background.
function loadImageUrl(item, preferOriginal = false) {
    const candidates = typeof item === 'string' ? [item]
        : (preferOriginal
            ? [item?.original_url, item?.preview_url, item?.thumbnail_url]
            : [item?.preview_url, item?.thumbnail_url, item?.original_url]);
    const urls = [...new Set(candidates.filter(url => typeof url === 'string' && url))];
    return new Promise(resolve => {
        function next() {
            const url = urls.shift();
            if (!url) { resolve(null); return; }
            const image = new Image();
            image.onload = () => image.naturalWidth > 0 ? resolve(url) : next();
            image.onerror = next;
            image.src = url;
        }
        next();
    });
}

function ambientKey(item) {
    return typeof item === 'string' ? item : item?.id || item?.preview_url || item?.original_url || item?.thumbnail_url;
}

function resetAmbient() {
    state.ambientRequest += 1;
    state.ambientPickRequest += 1;
    state.ambientPicking = false;
    state.ambient = [];
    state.ambientDeck = [];
    state.ambientHistory = [];
    state.ambientCurrent = null;
    state.layer = 0;
    document.querySelector('.ambient-container')?.classList.remove('has-ambient');
    for (const id of ['ambient-a', 'ambient-b', 'ambient-backdrop-a', 'ambient-backdrop-b']) {
        const layer = $(id);
        if (layer) {
            layer.style.backgroundImage = '';
            layer.classList.remove('active');
        }
    }
    try {
        localStorage.removeItem('mediastudio_simple_ambient_last');
        localStorage.removeItem('mediastudio_simple_ambient_items');
    } catch {}
    try { sessionStorage.removeItem('mediastudio_simple_ambient_items'); } catch {}
    restartAmbientTimer();
}

function openResultFullscreen(startIndex = 0) {
    openViewer({ kind: 'result', index: startIndex });
}

/** Items of the viewer: the photos of the shown result (or the panel) and every result. */
function viewerItems() {
    const results = (state.lastOutputs || [])
        .filter(item => item?.preview_url || item?.thumbnail_url)
        .map((item, index, all) => ({
            kind: 'result',
            index,
            label: all.length > 1 ? `Result ${index + 1}` : 'Result',
            src: item.preview_url || item.thumbnail_url,
        }));
    const copy = REF_COPY[state.mode];
    const panel = copy ? [
        state.photo && { kind: 'ref', slot: 'main', label: copy.main[0], src: state.photo.objectUrl },
        copy.subject && state.subject && { kind: 'ref', slot: 'subject', label: copy.subject[0], src: state.subject.objectUrl },
    ].filter(Boolean) : [];
    return { panel, results, compareRefs: state.resultRefs.length ? state.resultRefs : panel };
}

/**
 * Full-screen viewer. ``start`` is ``{kind: 'ref', slot}`` or ``{kind: 'result', index}``;
 * ``compare`` opens the side-by-side view of the photos and the selected result.
 */
function openViewer(start = { kind: 'result', index: 0 }, { compare = false } = {}) {
    const { panel, results, compareRefs } = viewerItems();
    const items = [...panel, ...results];
    if (!items.length) return;
    let index = Math.max(0, items.findIndex(item => item.kind === start.kind
        && (start.kind === 'ref' ? item.slot === start.slot : item.index === (start.index ?? state.selectedResultIndex))));
    let sideBySide = compare && results.length > 0;
    let scale = 1;

    const overlay = document.createElement('div');
    overlay.className = 'result-lightbox';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Full-screen preview');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'result-lightbox-close';
    close.setAttribute('aria-label', 'Close preview');
    close.textContent = '×';
    const toolbar = document.createElement('div');
    toolbar.className = 'viewer-toolbar';
    const label = document.createElement('span');
    label.className = 'viewer-label';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'viewer-toggle';
    toggle.hidden = !(results.length && compareRefs.length);
    toolbar.append(label, toggle);
    const stage = document.createElement('div');
    stage.className = 'viewer-stage';
    const makeNav = (text, direction) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `result-lightbox-nav ${direction}`;
        button.setAttribute('aria-label', text);
        button.textContent = direction === 'prev' ? '‹' : '›';
        return button;
    };
    const previous = makeNav('Previous image', 'prev');
    const next = makeNav('Next image', 'next');

    const render = () => {
        stage.replaceChildren();
        overlay.classList.toggle('is-compare', sideBySide);
        previous.hidden = next.hidden = sideBySide || items.length < 2;
        toggle.textContent = sideBySide ? 'One image' : 'Compare with the photos';
        if (sideBySide) {
            const current = items[index].kind === 'result' ? items[index] : results[state.selectedResultIndex] || results[0];
            label.textContent = 'Photos and result';
            for (const item of [...compareRefs, current]) {
                const figure = document.createElement('figure');
                figure.className = 'viewer-figure';
                const image = document.createElement('img');
                image.src = item.src;
                image.alt = item.label;
                const caption = document.createElement('figcaption');
                caption.textContent = item.label;
                figure.append(image, caption);
                stage.append(figure);
            }
            return;
        }
        const item = items[index];
        label.textContent = items.length > 1 ? `${item.label} · ${index + 1} of ${items.length}` : item.label;
        scale = 1;
        const image = document.createElement('img');
        image.className = 'result-lightbox-image';
        image.src = item.src;
        image.alt = item.label;
        image.addEventListener('wheel', event => {
            event.preventDefault();
            scale = Math.max(.5, Math.min(3, scale + (event.deltaY < 0 ? .15 : -.15)));
            image.style.transform = `scale(${scale})`;
        }, { passive: false });
        image.addEventListener('dblclick', () => {
            scale = 1;
            image.style.transform = 'scale(1)';
        });
        stage.append(image);
        if (item.kind === 'result') selectResultIndex(item.index);
    };
    const move = direction => {
        index = (index + direction + items.length) % items.length;
        render();
    };
    previous.addEventListener('click', () => move(-1));
    next.addEventListener('click', () => move(1));
    toggle.addEventListener('click', () => {
        sideBySide = !sideBySide;
        render();
    });
    overlay.append(close, toolbar, previous, next, stage);
    const dismiss = () => {
        overlay.remove();
        document.removeEventListener('keydown', onKeydown);
    };
    const onKeydown = event => {
        if (event.key === 'Escape') dismiss();
        if (!sideBySide && event.key === 'ArrowLeft' && items.length > 1) move(-1);
        if (!sideBySide && event.key === 'ArrowRight' && items.length > 1) move(1);
    };
    close.addEventListener('click', dismiss);
    overlay.addEventListener('click', event => {
        if (event.target === overlay || event.target === stage) dismiss();
    });
    document.addEventListener('keydown', onKeydown);
    render();
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('is-open'));
    close.focus();
}

function esc(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
}

async function json(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw Object.assign(
            new Error(data.suggestion || data.error || `${response.status} ${response.statusText}`),
            { data, status: response.status },
        );
    }
    return data;
}

function latestDownloads(items) {
    const seen = new Set();
    const result = [];
    for (const item of items || []) {
        const key = `${item.folder}/${item.filename}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(item);
    }
    return result;
}

function bytes(value) {
    const amount = Number(value || 0);
    if (!amount) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let number = amount;
    let index = 0;
    while (number >= 1024 && index < units.length - 1) {
        number /= 1024;
        index += 1;
    }
    return `${number >= 100 || index === 0 ? number.toFixed(0) : number.toFixed(1)} ${units[index]}`;
}

function downloadStatus(item) {
    const labels = {
        queued: 'Queued',
        downloading: item.file_size_bytes ? `${Math.round(item.progress || 0)}%` : 'Downloading…',
        paused: 'Paused',
        completed: 'Complete',
        failed: 'Failed',
        cancelled: 'Cancelled',
    };
    return labels[item.status] || item.status;
}

function paintDownloads() {
    const wrap = $('model-downloads');
    if (!wrap) return;
    wrap.hidden = !state.downloads.length;
    wrap.innerHTML = state.downloads.map(item => {
        const canPause = ['queued', 'downloading'].includes(item.status) && item.id > 0;
        const canResume = ['paused', 'failed', 'cancelled'].includes(item.status) && item.id > 0;
        const canCancel = ['queued', 'downloading', 'paused'].includes(item.status) && item.id > 0;
        const indeterminate = item.status === 'downloading' && !item.file_size_bytes;
        const percent = item.file_size_bytes ? Math.round(item.progress || 0) : null;
        const size = item.file_size_bytes
            ? `${bytes(item.downloaded_bytes)} / ${bytes(item.file_size_bytes)}`
            : (item.downloaded_bytes ? bytes(item.downloaded_bytes) : item.folder);
        return `<div class="model-download-row">
            <div class="model-download-head">
                <div class="model-download-copy">
                    <strong>${esc(item.display_name || item.filename)}</strong>
                    <small>${esc(downloadStatus(item))}${size ? ` · ${esc(size)}` : ''}</small>
                </div>
                <div class="model-download-actions">
                    ${percent !== null && ['queued', 'downloading', 'paused'].includes(item.status) ? `<span class="mediastudio-download-percent">${percent}%</span>` : ''}
                    ${canPause ? `<button class="download-mini-btn" type="button" data-download-action="pause" data-download-id="${item.id}">Pause</button>` : ''}
                    ${canResume ? `<button class="download-mini-btn" type="button" data-download-action="resume" data-download-id="${item.id}">${item.status === 'failed' ? 'Retry' : 'Resume'}</button>` : ''}
                    ${canCancel ? `<button class="download-mini-btn mediastudio-download-cancel" type="button" data-download-action="cancel" data-download-id="${item.id}">Cancel</button>` : ''}
                </div>
            </div>
            <div class="model-download-track${indeterminate ? ' is-indeterminate' : ''}"><div class="model-download-fill" style="width:${Math.max(0, Math.min(100, Number(item.progress || 0)))}%"></div></div>
            ${item.error ? `<p class="model-download-error">${esc(item.error)}</p>` : ''}
        </div>`;
    }).join('');
    paintHealth(state.health || { status: 'checking', message: 'Checking local components' });
}

async function loadDownloads() {
    const id = state.modelId;
    if (!id) return;
    try {
        const data = await json(`/api/simple/downloads?profile_id=${encodeURIComponent(id)}`);
        if (state.modelId !== id) return;
        state.downloads = latestDownloads(data.items || []);
        paintDownloads();
        if (state.downloads.some(item => ['queued', 'downloading'].includes(item.status))) {
            startDownloadPolling();
        }
    } catch {}
}

async function installModel() {
    if (!state.modelId) return;
    const button = $('model-install');
    button.disabled = true;
    button.querySelector('span').textContent = 'Preparing…';
    try {
        const data = await json(`/api/simple/models/${encodeURIComponent(state.modelId)}/install`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        if (Array.isArray(data.downloads) && data.downloads.length) {
            state.downloads = latestDownloads(data.downloads);
            paintDownloads();
            startDownloadPolling();
        } else {
            await loadDownloads();
            await loadHealth();
        }
        if (data.unavailable?.length) {
            error('Some components could not be installed', data.unavailable.join('\n'));
        }
    } catch (err) {
        if (err.data?.open_settings) openRuntimeSettings();
            error('Could not start download', err.message);
    } finally {
        button.disabled = false;
        paintHealth(state.health || {});
    }
}

async function downloadAction(id, action) {
    try {
        await json(`/api/simple/downloads/${id}/${action}`, { method: 'POST' });
        await loadDownloads();
        if (action === 'resume') startDownloadPolling();
    } catch (err) {
            error('Could not update download', err.message);
    }
}

function startDownloadPolling() {
    clearInterval(state.downloadPoll);
    state.downloadPoll = setInterval(async () => {
        await loadDownloads();
        const active = state.downloads.some(item => ['queued', 'downloading'].includes(item.status));
        if (!active) {
            clearInterval(state.downloadPoll);
            state.downloadPoll = null;
            if (state.downloads.length && state.downloads.every(item => item.status === 'completed')) {
                setTimeout(() => {
                    loadHealth(true);
                    loadDownloads();
                }, 450);
            }
        }
    }, 850);
}

function shuffleArray(arr) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

function refillAmbientDeck() {
    if (!state.ambient.length) {
        state.ambientDeck = [];
        return;
    }
    const recentSet = new Set(state.ambientHistory);
    const unseen = state.ambient.filter(item => !recentSet.has(ambientKey(item)));
    const seen = state.ambient.filter(item => recentSet.has(ambientKey(item)));

    const shuffledUnseen = shuffleArray(unseen);
    const shuffledSeen = shuffleArray(seen);
    const newDeck = [...shuffledUnseen, ...shuffledSeen];

    // Avoid immediate repeat with currently shown image
    if (newDeck.length > 1 && ambientKey(newDeck[0]) === state.ambientCurrent) {
        const first = newDeck.shift();
        newDeck.push(first);
    }
    state.ambientDeck = newDeck;
}

async function loadMoreAmbient() {
    if (state.ambientLoadingMore) return;
    state.ambientLoadingMore = true;
    const request = state.ambientPoolRequest;
    try {
        const data = await json(ambientPoolUrl());
        if (request !== state.ambientPoolRequest) return;
        const items = Array.isArray(data.items) ? data.items : [];
        if (!items.length) { resetAmbient(); return; }
        if (items.length) {
            const existingIds = new Set(state.ambient.map(it => it.id || it));
            const newItems = items.filter(it => !existingIds.has(it.id || it));
            if (newItems.length) {
                state.ambient.push(...newItems);
                setCachedJson('mediastudio_simple_ambient_items', state.ambient.slice(0, 120), true);
                state.ambientDeck.push(...shuffleArray(newItems));
            }
        }
    } catch {}
    finally {
        state.ambientLoadingMore = false;
    }
}

async function loadAmbient() {
    const request = ++state.ambientPoolRequest;
    try {
        const data = await json(ambientPoolUrl());
        if (request !== state.ambientPoolRequest) return;
        const items = Array.isArray(data.items) ? data.items : [];
        if (!items.length) { resetAmbient(); return; }
        if (items.length) {
            state.ambientRequest += 1;
            state.ambient = items;
            setCachedJson('mediastudio_simple_ambient_items', items, true);
            refillAmbientDeck();
            preloadAmbientPool();
            if (!document.querySelector('.ambient-container.has-ambient')
                || !items.some(item => ambientKey(item) === state.ambientCurrent)) {
                await ambientPick();
            }
            restartAmbientTimer();
        }
    } catch {}
}

function watchAmbientSources() {
    const events = new EventSource('/api/folders/events');
    let previous = null;
    events.onmessage = event => {
        try {
            const sources = JSON.parse(event.data);
            const signature = JSON.stringify(Object.entries(sources).map(([id, source]) =>
                [id, source.image_count, source.enabled, source.source_status, source.revision]));
            if (previous !== null && signature !== previous) loadAmbient();
            previous = signature;
        } catch {}
    };
}

async function ambientPick(resetTimer = true) {
    if (!state.ambient.length) return;
    if (!resetTimer && state.ambientPicking) return;
    const request = ++state.ambientPickRequest;
    state.ambientPicking = true;
    try {
        if (!state.ambientDeck.length) {
            refillAmbientDeck();
        }
        // Try each candidate at most once; a missing source must not stop the slideshow.
        const attempts = state.ambientDeck.length;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            let nextItem = state.ambientDeck.shift();
            if (!nextItem) break;
            if (ambientKey(nextItem) === state.ambientCurrent && state.ambientDeck.length > 0) {
                const alt = state.ambientDeck.shift();
                state.ambientDeck.push(nextItem);
                nextItem = alt;
            }
            // Failover is sequential so only the first working candidate is downloaded/applied.
            // eslint-disable-next-line no-await-in-loop, no-restricted-syntax
            const loaded = await setAmbient(nextItem);
            if (loaded === null) return;
            if (loaded) break;
            state.ambient = state.ambient.filter(item => ambientKey(item) !== ambientKey(nextItem));
        }
        preloadAmbientPool();

        if (resetTimer) {
            restartAmbientTimer(true);
        }

        if (state.ambientDeck.length < 8) {
            loadMoreAmbient();
        }
    } finally {
        if (request === state.ambientPickRequest) state.ambientPicking = false;
    }
}

function preloadAmbientPool() {
    const items = state.ambientDeck.slice(0, 4);
    for (const item of items) {
        const src = typeof item === 'string' ? item : item?.original_url || item?.preview_url || item?.thumbnail_url;
        if (src) {
            const img = new Image();
            img.src = src;
        }
    }
}

async function setAmbient(item) {
    const request = ++state.ambientRequest;
    const url = await loadImageUrl(item, true);
    if (request !== state.ambientRequest) return null;
    if (!url) return false;
    applyAmbient(url);
    state.ambientCurrent = ambientKey(item);
    state.ambientHistory.push(state.ambientCurrent);
    if (state.ambientHistory.length > 30) state.ambientHistory.shift();
    return true;
}

function applyAmbient(url) {
    const next = state.layer ? $('ambient-a') : $('ambient-b');
    const previous = state.layer ? $('ambient-b') : $('ambient-a');
    const nextBg = state.layer ? $('ambient-backdrop-a') : $('ambient-backdrop-b');
    const prevBg = state.layer ? $('ambient-backdrop-b') : $('ambient-backdrop-a');
    const container = document.querySelector('.ambient-container');
    if (!next || !previous) return;
    const formattedUrl = `url("${String(url).replaceAll('"', '%22')}")`;
    next.style.backgroundImage = formattedUrl;
    next.classList.add('active');
    previous.classList.remove('active');
    if (nextBg && prevBg) {
        nextBg.style.backgroundImage = formattedUrl;
        nextBg.classList.add('active');
        prevBg.classList.remove('active');
    }
    if (container) container.classList.add('has-ambient');
    try { localStorage.setItem('mediastudio_simple_ambient_last', url); } catch {}
    state.layer = state.layer ? 0 : 1;
}

function canvasWidthLimits() {
    const min = 360;
    return { min, max: 1100 };
}

function wireCanvasResize() {
    const card = document.querySelector('.studio-canvas-card');
    const layout = $('studio-layout');
    if (!card || !layout || card.querySelector('.canvas-resize-handle')) return;
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'canvas-resize-handle';
    handle.setAttribute('aria-label', 'Resize result panel');
    handle.title = 'Drag to resize';
    card.appendChild(handle);

    let startX = 0;
    let startWidth = 0;
    const onMove = event => {
        const limits = canvasWidthLimits();
        const nextWidth = Math.round(Math.max(limits.min, Math.min(limits.max, startWidth + event.clientX - startX)));
        state.canvasWidth = nextWidth;
        layout.style.setProperty('--canvas-column-width', `${nextWidth}px`);
        save('mediastudio_simple_canvas_width', nextWidth);
    };
    const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        handle.classList.remove('is-resizing');
    };
    handle.addEventListener('pointerdown', event => {
        event.preventDefault();
        startX = event.clientX;
        startWidth = card.getBoundingClientRect().width;
        handle.classList.add('is-resizing');
        handle.setPointerCapture?.(event.pointerId);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
        window.addEventListener('pointercancel', onUp, { once: true });
    });
    window.addEventListener('resize', () => {
        if (!state.canvasWidth) return;
        const limits = canvasWidthLimits();
        state.canvasWidth = Math.max(limits.min, Math.min(limits.max, state.canvasWidth));
        layout.style.setProperty('--canvas-column-width', `${state.canvasWidth}px`);
        save('mediastudio_simple_canvas_width', state.canvasWidth);
    });
}

/**
 * The prompt field takes the free height of the card (CSS) and grows with its text while the
 * card has room below its height limit (stacked: up to 40% of the window); longer text
 * scrolls inside the field, so the Create button stays in view.
 */
function resizePrompt() {
    const textarea = $('prompt');
    if (!textarea) return;
    const minH = 84;
    // Measure the text alone: a field stretched by the card would report its own height.
    textarea.style.flex = 'none';
    textarea.style.minHeight = '0px';
    textarea.style.height = '0px';
    const content = textarea.scrollHeight;
    textarea.style.flex = '';
    textarea.style.height = '';
    textarea.style.minHeight = `${minH}px`;
    let maxH = Math.round(window.innerHeight * 0.4);
    const card = textarea.closest('.studio-controls-card');
    if (card && !matchMedia('(max-width: 1050px)').matches) {
        const limit = parseFloat(getComputedStyle(card).maxHeight);
        if (Number.isFinite(limit)) maxH = Math.min(maxH, textarea.clientHeight + Math.max(0, limit - card.scrollHeight));
    }
    textarea.style.minHeight = `${Math.max(minH, Math.min(content, maxH))}px`;
}

/**
 * The prompt's height depends on everything else in the card: an error or note banner, the
 * refine chip, the status line or a layout switch. Re-measure whenever one of them appears,
 * disappears or changes its text, not only on window resize.
 */
function watchControlsHeight() {
    const card = document.querySelector('.studio-controls-card');
    const layout = $('studio-layout');
    if (!card || !layout || typeof MutationObserver !== 'function') return;
    // Observer callbacks already arrive batched once per task.
    const schedule = () => {
        resizePrompt();
        syncCanvasRowHeight();
    };
    // The Create button's progress text changes every tick without changing its height.
    const ignored = node => {
        const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        return !element || element === $('prompt') || Boolean(element.closest('#create'));
    };
    new MutationObserver(records => {
        if (records.some(record => !ignored(record.target))) schedule();
    }).observe(card, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
    new MutationObserver(schedule).observe(layout, { attributes: true, attributeFilter: ['data-view', 'data-refs', 'data-blocks'] });
}

function playSuccessChime() {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        const now = ctx.currentTime;
        const notes = [659.25, 987.77, 1318.51];
        notes.forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, now + i * 0.08);
            gain.gain.setValueAtTime(0.12, now + i * 0.08);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.08 + 0.6);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now + i * 0.08);
            osc.stop(now + i * 0.08 + 0.65);
        });
        setTimeout(() => { try { ctx.close(); } catch {} }, 1200);
    } catch {}
}

function selectResultIndex(index) {
    if (!state.lastOutputs || !state.lastOutputs[index]) return;
    state.selectedResultIndex = index;
    state.last = state.lastOutputs[index];
    const current = state.last;
    const url = current.preview_url || current.thumbnail_url;

    const img = document.querySelector('.canvas-artwork-wrap .canvas-result-img');
    if (img) {
        img.src = url;
        img.alt = `Result ${index + 1}`;
    }

    const thumbsContainer = $('result-thumbnails');
    if (thumbsContainer) {
        thumbsContainer.querySelectorAll('.canvas-thumb-btn').forEach((btn, i) => {
            btn.classList.toggle('active', i === index);
        });
    }

}

function runtimeDetection(kind, title, text) {
    const card = $('runtime-detection');
    card.className = `runtime-detection-card${kind ? ` is-${kind}` : ''}`;
    $('runtime-detection-title').textContent = title;
    $('runtime-detection-text').textContent = text;
}

function runtimeStatusText(status) {
    if (!status) return 'ComfyUI status is unknown.';
    const owned = status.mode === 'managed' ? ' Started by Create; it closes together with the app.' : '';
    if (['ready', 'external'].includes(status.status)) return `ComfyUI is available at ${status.host || '127.0.0.1'}:${status.port || 8188}.${owned}`;
    if (status.status === 'busy') return `ComfyUI is connected and currently generating.${owned}`;
    if (status.status === 'starting') return 'ComfyUI is starting…';
    if (status.last_error) return status.last_error;
    if (status.status === 'stopped') return 'ComfyUI is not running.';
    return `Current status: ${status.status || 'unknown'}.`;
}

function runtimeUp(status) {
    return Boolean(status) && ['ready', 'external', 'busy'].includes(status.status);
}

// --- remote GPU (Colab) ---------------------------------------------------------------

const COLAB_BOOT_STAGES = {
    allocating: 'getting a GPU',
    drive: 'connecting Google Drive',
    comfyui: 'getting ComfyUI',
    requirements: 'installing packages',
    nodes: 'installing the photo-edit nodes',
    starting: 'starting ComfyUI',
};

function shortGpuName(name) {
    return String(name || '').split(',')[0].replace(/^NVIDIA\s+/, '').replace(/\s+Server Edition$/, '');
}

/** Status line for a Colab backend: badge class, badge label and text. */
function colabStatusLine() {
    const runtime = state.colab || state.health?.backend || {};
    const gpu = runtime.gpu || 'GPU';
    if (state.health?.backend?.signed_in === false) return ['is-missing', 'Colab', 'Sign in to Google to use the Colab GPU'];
    if (state.health?.backend?.civitai_ready === false) return ['is-missing', 'Colab', 'Needs your Civitai API key to fetch Moody Krea2'];
    switch (runtime.state) {
    case 'allocating':
        return ['is-starting', 'Starting', `Colab ${gpu} · getting a GPU…`];
    case 'booting':
        return ['is-starting', 'Starting', `Colab ${gpu} · ${COLAB_BOOT_STAGES[runtime.boot_stage] || 'setting up'}…`];
    case 'stopping':
        return ['is-starting', 'Stopping', `Colab ${gpu} · stopping…`];
    case 'error':
        return ['is-missing', 'Colab', runtime.error?.message || 'The Colab runtime failed'];
    case 'ready': {
        const name = runtime.gpu_name ? shortGpuName(runtime.gpu_name) : `Colab ${gpu}`;
        const tail = runtime.active_jobs
            ? ` · ${runtime.active_jobs} running`
            : runtime.stops_in_seconds != null ? ` · stops in ${formatDuration(runtime.stops_in_seconds)} without work` : '';
        return ['is-ready', 'Colab', `${name} · ready${tail}`];
    }
    default:
        return ['is-idle', 'Colab', `Colab ${gpu} · starts with the first run, about 2 min`];
    }
}

/** Whether a Colab run still waits for the runtime to start or for its models. */
function remoteLaunching(remote) {
    if (!remote) return false;
    if (remote.runtime_state === 'allocating') return true;
    if (remote.runtime_state === 'booting' && ['waiting', 'sent', 'received'].includes(remote.job_state)) return true;
    return Object.keys(remote.downloads || {}).length > 0;
}

function downloadsText(remote) {
    const downloads = Object.values(remote?.downloads || {});
    if (!downloads.length) return '';
    const total = downloads.reduce((sum, item) => sum + (item.total || 0), 0);
    const done = downloads.reduce((sum, item) => sum + (item.done || 0), 0);
    return total
        ? `Downloading models · ${Math.round((100 * done) / total)}%`
        : `Downloading ${downloads.length} model file${downloads.length === 1 ? '' : 's'}`;
}

/** What a Colab run is doing once the runtime is up, before ComfyUI reports its own progress. */
function remoteStageText(remote) {
    if (!remote || remoteLaunching(remote)) return '';
    if (remote.model_cache?.state === 'restoring') return 'Copying model weights from Google Drive';
    if (remote.model_cache?.state === 'saving') return 'Saving model weights to Google Drive';
    if (['waiting', 'sent', 'received', 'preparing'].includes(remote.job_state)) return 'Sending to Colab';
    if (remote.job_state === 'collecting') return 'Fetching the image from Colab';
    return '';
}

// --- launch toast --------------------------------------------------------------------

const LAUNCH_READY_MS = 2600;

function launchWaitText(kind) {
    const cache = currentRemote(state.job)?.model_cache || state.colab?.model_cache;
    if (kind === 'colab' && cache?.state === 'authorizing') {
        return 'Google Drive needs access. Open the Google access page in the dialog.';
    }
    return kind === 'colab' ? 'Starts once the Colab GPU is ready' : 'Starts once ComfyUI is running';
}

function currentRemote(job) {
    if (!job?.runIds || !job.remote) return null;
    const id = job.runIds.find(item => !job.done.has(item));
    return id ? job.remote.get(id) : null;
}

function sentenceCase(text) {
    return text ? text[0].toUpperCase() + text.slice(1) : '';
}

/** What is starting right now: ComfyUI on this computer or a Colab GPU, or null. */
function launchStatus() {
    const job = state.job;
    if (state.backend === 'colab') {
        const remote = currentRemote(job);
        const runtime = state.colab || {};
        const gpu = remote?.gpu || runtime.gpu || 'GPU';
        const phase = remote?.runtime_state || runtime.state;
        if (phase === 'allocating') return { kind: 'colab', title: `Starting Colab ${gpu}`, stage: 'Getting a GPU', since: runtime.started_at };
        if (phase === 'booting') {
            if ((remote?.model_cache || runtime.model_cache)?.state === 'authorizing') {
                return { kind: 'colab', title: 'Google Drive needs access', stage: 'Open the Google access page in the dialog', since: runtime.started_at };
            }
            const stage = sentenceCase(COLAB_BOOT_STAGES[remote?.boot_stage || runtime.boot_stage] || 'setting up');
            return { kind: 'colab', title: `Starting Colab ${gpu}`, stage, since: runtime.started_at };
        }
        const downloads = downloadsText(remote);
        if (downloads) return { kind: 'colab', title: `Preparing Colab ${gpu}`, stage: downloads, since: runtime.started_at };
        if (job?.launch === 'colab' && job.phase === 'queue') {
            return { kind: 'colab', title: `Starting Colab ${gpu}`, stage: 'Getting a GPU', since: job.launchStartedAt / 1000 };
        }
        return null;
    }
    if (state.runtimeBusy) {
        const title = state.runtimeBusy === 'restarting' ? 'Restarting ComfyUI' : 'Starting ComfyUI';
        return { kind: 'local', title, stage: 'On this computer', since: state.runtimeStartedAt / 1000 };
    }
    if (job?.runtimeProgress) {
        return job.runtimeProgress.state === 'starting'
            ? { kind: 'local', title: 'Starting ComfyUI', stage: 'On this computer', since: job.runtimeProgress.started_at }
            : null;
    }
    if (job?.launch === 'local' && job.phase === 'queue') {
        return { kind: 'local', title: 'Starting ComfyUI', stage: 'On this computer', since: job.launchStartedAt / 1000 };
    }
    return null;
}

function launchSucceeded(kind) {
    if (kind === 'colab') return state.colab?.state === 'ready' || currentRemote(state.job)?.runtime_state === 'ready';
    return state.job?.runtimeProgress?.state === 'ready' || state.job?.phase === 'running' || runtimeUp(state.runtimeStatus);
}

function paintDriveAccess() {
    const dialog = $('drive-access');
    if (!dialog) return;
    const cache = state.colab?.model_cache;
    if (state.backend === 'colab' && currentRemote(state.job)?.model_cache?.state === 'authorizing'
        && !cache?.auth_url && !state.driveAccessLoading) {
        state.driveAccessLoading = true;
        loadColabRuntime().finally(() => { state.driveAccessLoading = false; });
    }
    let url = null;
    try {
        const candidate = new URL(cache?.auth_url);
        if (candidate.protocol === 'https:' && ['accounts.google.com', 'colab.research.google.com'].includes(candidate.hostname)) url = candidate.href;
    } catch { /* No authorization link until Google requests consent. */ }
    const waiting = state.backend === 'colab' && state.colab?.state === 'booting' && Boolean(url);
    const opening = waiting && dialog.hidden;
    dialog.hidden = !waiting;
    $('drive-access-backdrop').hidden = !waiting;
    if (!waiting) return;
    const open = $('drive-access-open');
    open.href = url;
    if (opening) {
        $('drive-access-message').textContent = 'Only confirm after Google says access has been granted.';
        open.focus();
    }
    $('drive-access-copy').onclick = async () => {
        try {
            await navigator.clipboard.writeText(url);
            $('drive-access-message').textContent = 'Link copied. Paste it into your browser and allow access in Google.';
        } catch {
            $('drive-access-message').textContent = 'Could not copy the link. Use the Google access button above.';
        }
    };
    $('drive-access-confirm').onclick = async () => {
        const button = $('drive-access-confirm');
        button.disabled = true;
        try {
            state.colab = await json('/api/remote/colab/drive/continue', { method: 'POST' });
            paintDriveAccess();
            loadColabRuntime();
        } catch (err) {
            $('drive-access-message').textContent = err.message;
        } finally { button.disabled = false; }
    };
    $('drive-access-cancel').onclick = async () => {
        try {
            state.colab = await json('/api/remote/colab/runtime/stop', { method: 'POST' });
            paintDriveAccess();
            loadColabRuntime();
        } catch (err) { $('drive-access-message').textContent = err.message; }
    };
}

/** The small notice while ComfyUI or a Colab GPU starts, then a short "ready". */
function paintLaunch() {
    paintDriveAccess();
    const toast = $('launch-toast');
    if (!toast) return;
    const status = launchStatus();
    const last = state.launch;
    if (status) {
        clearTimeout(state.launchHide);
        state.launch = status;
        toast.classList.remove('is-done');
        toast.classList.add('is-visible');
        toast.setAttribute('aria-hidden', 'false');
        $('launch-title').textContent = status.title;
        $('launch-stage').textContent = status.stage;
        const seconds = status.since ? Math.max(0, Math.round(Date.now() / 1000 - status.since)) : null;
        $('launch-elapsed').textContent = seconds != null ? formatDuration(seconds) : '';
        if (!state.launchTick) state.launchTick = setInterval(paintLaunch, 1000);
        return;
    }
    clearInterval(state.launchTick);
    state.launchTick = null;
    if (!last) return;
    state.launch = null;
    if (launchSucceeded(last.kind)) {
        toast.classList.add('is-done');
        $('launch-title').textContent = last.kind === 'colab' ? 'Colab GPU is ready' : 'ComfyUI is running';
        $('launch-stage').textContent = last.kind === 'colab' ? 'Rendering on Colab' : 'Rendering on this computer';
        $('launch-elapsed').textContent = '';
        state.launchHide = setTimeout(hideLaunch, LAUNCH_READY_MS);
    } else {
        hideLaunch();
    }
}

function hideLaunch() {
    const toast = $('launch-toast');
    toast.classList.remove('is-visible');
    toast.setAttribute('aria-hidden', 'true');
}

function paintBackendSwitch() {
    document.querySelectorAll('#backend-switch [data-backend]').forEach(button => {
        const active = button.dataset.backend === state.backend;
        button.classList.toggle('active', active);
        button.setAttribute('aria-checked', String(active));
        button.disabled = Boolean(state.job);
    });
}

async function loadBackend() {
    try {
        const data = await json('/api/remote/settings');
        state.backend = data.backend === 'colab' ? 'colab' : 'local';
    } catch {
        state.backend = 'local';
    }
    paintBackendSwitch();
    if (state.backend === 'colab') {
        await loadHealth(true);
        loadColabRuntime();
    }
}

async function setBackend(backend) {
    if (state.job || backend === state.backend) return;
    try {
        const data = await json('/api/remote/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ backend }),
        });
        state.backend = data.backend;
    } catch (err) {
        return error('Could not switch where Create runs', err.message);
    }
    paintBackendSwitch();
    clearTimeout(state.colabPoll);
    if (state.backend === 'colab') await loadColabRuntime();
    await loadHealth(true);
}

async function loadColabRuntime() {
    clearTimeout(state.colabPoll);
    if (state.backend !== 'colab') return;
    try {
        state.colab = await json('/api/remote/colab/runtime');
    } catch {
        return;
    }
    paintHealth(state.health);
    const runtime = state.colab?.state;
    // Fast while it starts or stops, slower for the idle countdown, none while off.
    const delay = ['allocating', 'booting', 'stopping'].includes(runtime) ? 2000 : runtime === 'ready' ? 10000 : 0;
    if (delay) state.colabPoll = setTimeout(loadColabRuntime, delay);
}

const RUNTIME_ACTIONS = {
    restart: { label: 'Restart ComfyUI', icon: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path>' },
    settings: { label: 'Set up ComfyUI', icon: '<path d="M12 15V3"></path><path d="m7 10 5 5 5-5"></path><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>' },
    'colab-token': { label: 'Add token', icon: '<circle cx="7.5" cy="15.5" r="5.5"></circle><path d="m21 2-9.6 9.6"></path><path d="m15.5 7.5 3 3L22 7l-3-3"></path>' },
    'colab-sign-in': { label: 'Sign in', icon: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path><path d="m10 17 5-5-5-5"></path><path d="M15 12H3"></path>' },
};

/** What the status line offers: the next step for a problem, or a restart of the ComfyUI Create started. */
function runtimeAction() {
    const health = state.health || {};
    if (state.backend === 'colab') {
        if (state.job) return null;
        if (health.backend?.signed_in === false) return 'colab-sign-in';
        if (health.backend?.civitai_ready === false) return 'colab-token';
        return null;
    }
    if (state.runtimeBusy || state.job) return null;
    // ComfyUI starts by itself with the first run; only a missing Desktop needs the user.
    if (health.comfyui_online === false) {
        if (!state.runtimeConfig) return null;
        return state.runtimeConfig.install_path ? null : 'settings';
    }
    const managed = state.runtimeStatus?.mode === 'managed';
    if ((health.restart_required || state.runtimeStale) && managed && runtimeUp(state.runtimeStatus)) return 'restart';
    return null;
}

function paintRuntimeAction() {
    paintBackendSwitch();
    const button = $('runtime-action');
    const action = runtimeAction();
    button.hidden = !action;
    // Without a problem or a next step the status line takes no room.
    const line = $('model-status');
    line.classList.toggle('is-empty', line.classList.contains('is-quiet') && !action);
    if (!action) return;
    button.dataset.action = action;
    button.querySelector('svg').innerHTML = RUNTIME_ACTIONS[action].icon;
    button.querySelector('span').textContent = RUNTIME_ACTIONS[action].label;
}

function paintRuntimePower() {
    const button = $('runtime-power');
    const status = state.runtimeStatus;
    // Only a ComfyUI that Create started can be stopped from here.
    const canStop = status?.mode === 'managed' && ['ready', 'busy', 'starting'].includes(status.status);
    const canStart = !runtimeUp(status) && status?.status !== 'starting' && Boolean(state.runtimeConfig?.install_path);
    button.hidden = !(canStop || canStart || state.runtimeBusy);
    button.disabled = Boolean(state.runtimeBusy);
    button.dataset.action = canStop ? 'stop' : 'start';
    button.textContent = state.runtimeBusy ? 'Starting…' : canStop ? 'Stop ComfyUI' : 'Start ComfyUI';
}

function rememberRuntimeStatus(status) {
    state.runtimeStatus = status;
    setCachedJson('mediastudio_runtime_status', status, false);
    paintRuntimePower();
}

async function startRuntime(kind = 'start') {
    if (state.runtimeBusy) return;
    state.runtimeBusy = kind === 'restart' ? 'restarting' : 'starting';
    state.runtimeStartedAt = Date.now();
    paintHealth(state.health);
    paintRuntimePower();
    try {
        rememberRuntimeStatus(await json(`/api/comfyui/${kind}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        }));
    } catch (err) {
        state.runtimeBusy = null;
        paintHealth(state.health);
        paintRuntimePower();
        return error('Could not start ComfyUI', err.message);
    }
    clearInterval(state.runtimePoll);
    // The manager reports "starting" until the API answers, or "error" after an exit or its timeout.
    return new Promise(resolve => {
        const tick = async () => {
            let status = null;
            try { status = await json('/api/comfyui/status'); } catch {}
            if (!state.runtimeBusy) return;
            if (status) rememberRuntimeStatus(status);
            const up = runtimeUp(status);
            const failed = status && !up && status.status !== 'starting';
            if (!up && !failed) {
                paintHealth(state.health);
                return;
            }
            clearInterval(state.runtimePoll);
            state.runtimePoll = null;
            state.runtimeBusy = null;
            // A fresh start runs with the saved settings.
            if (up) state.runtimeStale = false;
            paintRuntimePower();
            await loadHealth(true);
            if (failed) {
                let log = '';
                try { log = (await json('/api/comfyui/logs?lines=25')).logs.join('\n'); } catch {}
                error('ComfyUI did not start', runtimeStatusText(status), log);
            }
            resolve(up);
        };
        state.runtimePoll = setInterval(tick, 1000);
    });
}

async function stopRuntime() {
    const button = $('runtime-power');
    button.disabled = true;
    button.textContent = 'Stopping…';
    try {
        rememberRuntimeStatus({ ...(await json('/api/comfyui/stop', { method: 'POST' })), online: false });
        state.runtimeStale = false;
        runtimeDetection('', 'ComfyUI stopped', runtimeStatusText(state.runtimeStatus));
    } catch (err) {
        runtimeDetection('error', 'Could not stop ComfyUI', err.message);
    } finally {
        button.disabled = false;
        paintRuntimePower();
        loadHealth(true);
    }
}

function runtimeActionClick() {
    const action = $('runtime-action').dataset.action;
    if (action === 'colab-sign-in') {
        window.location.href = '/settings/ai#remote';
        return;
    }
    if (action === 'colab-token') return openRuntimeSettings();
    if (action === 'settings') return openRuntimeSettings();
    if (action === 'restart') return startRuntime(action);
}

async function runtimePowerClick() {
    if ($('runtime-power').dataset.action === 'stop') return stopRuntime();
    runtimeDetection('', 'Starting ComfyUI…', 'The first start with custom nodes can take a minute.');
    const up = await startRuntime('start');
    runtimeDetection(up ? 'good' : 'error', up ? 'ComfyUI is running' : 'ComfyUI did not start', runtimeStatusText(state.runtimeStatus));
}

async function loadRuntimeSummary() {
    const cachedConfig = getCachedJson('mediastudio_runtime_config', 120 * 1000);
    const cachedStatus = getCachedJson('mediastudio_runtime_status', 30 * 1000);
    if (cachedConfig) state.runtimeConfig = cachedConfig;
    if (cachedStatus) {
        state.runtimeStatus = cachedStatus;
    }
    const [configResult, statusResult] = await Promise.allSettled([
        json('/api/comfyui/config'),
        json('/api/comfyui/status'),
    ]);
    if (configResult.status === 'fulfilled') {
        state.runtimeConfig = configResult.value;
        setCachedJson('mediastudio_runtime_config', configResult.value, false);
    }
    if (statusResult.status === 'fulfilled') {
        state.runtimeStatus = statusResult.value;
        setCachedJson('mediastudio_runtime_status', statusResult.value, false);
    }
    paintRuntimePower();
    if (state.health) paintHealth(state.health);
}

const FOLDER_KEYS = ['models_dir', 'input_dir', 'output_dir'];
const FOLDER_TITLES = {
    models_dir: 'Choose the models folder',
    input_dir: 'Choose the input folder',
    output_dir: 'Choose the output folder',
};

async function openRuntimeSettings() {
    $('runtime-settings-backdrop').hidden = false;
    $('runtime-settings-dialog').hidden = false;
    document.body.classList.add('simple-modal-open');
    await Promise.all([loadRuntimeSummary(), loadDesktop()]);
    const config = state.runtimeConfig || {};
    state.runtimeDraft = {
        installationId: config.desktop_installation_id || state.desktop.installations[0]?.id || null,
        folders: Object.fromEntries(FOLDER_KEYS.map(key => [key, config[key] || null])),
    };
    $('runtime-host').value = config.host || '127.0.0.1';
    $('runtime-port').value = config.port || 8188;
    $('runtime-civitai-token').value = '';
    $('runtime-civitai-token').placeholder = config.has_civitai_token ? 'Saved; leave empty to keep it' : 'Not set';
    paintDesktopChoice();
    paintRuntimeCard();
}

async function loadDesktop(refresh = false) {
    try {
        state.desktop = await json(`/api/comfyui/installations${refresh ? '?refresh=1' : ''}`);
    } catch {
        state.desktop = { installations: [], folders: {} };
    }
}

function paintRuntimeCard() {
    if (!state.desktop?.installations.length) {
        return runtimeDetection('error', 'ComfyUI Desktop is needed', 'Install ComfyUI Desktop, open it once, then press "Check again".');
    }
    const status = state.runtimeStatus;
    runtimeDetection(runtimeUp(status) ? 'good' : '', runtimeUp(status) ? 'ComfyUI is running' : 'ComfyUI', runtimeStatusText(status));
}

function samePath(a, b) {
    const norm = value => String(value || '').trim().replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase();
    return Boolean(a) && norm(a) === norm(b);
}

function paintDesktopChoice() {
    const desktop = state.desktop || { installations: [], folders: {} };
    const draft = state.runtimeDraft;
    const found = desktop.installations.length > 0;
    $('runtime-no-desktop').hidden = found;
    $('runtime-installs').hidden = !found;
    $('runtime-installs').innerHTML = desktop.installations.map(item => {
        const active = item.id === draft.installationId;
        return `<button type="button" class="runtime-install${active ? ' is-active' : ''}" role="radio" aria-checked="${active}" data-install="${esc(item.id)}">
            <span class="runtime-install-dot"></span>
            <span class="runtime-install-main"><strong>${esc(item.name)}</strong><small title="${esc(item.install_path)}">${esc(item.install_path)}</small></span>
            ${item.version ? `<span class="runtime-install-tag">${esc(item.version)}</span>` : ''}
            ${item.last_used ? '<span class="runtime-install-tag">last used</span>' : ''}
        </button>`;
    }).join('');
    $('runtime-folders').querySelectorAll('.runtime-folder').forEach(row => {
        const key = row.dataset.folder;
        const own = draft.folders[key];
        const path = own || desktop.folders?.[key] || '';
        const pathLine = row.querySelector('[data-role="path"]');
        pathLine.textContent = path || 'Desktop default';
        pathLine.title = path;
        row.querySelector('[data-role="source"]').textContent = own ? 'Create only' : 'Same as Desktop';
        row.classList.toggle('is-custom', Boolean(own));
        row.querySelector('[data-action="pick"]').disabled = !found;
        row.querySelector('[data-action="reset"]').hidden = !own;
    });
    $('runtime-save').disabled = !found;
}

async function pickRuntimeFolder(key) {
    const desktopPath = state.desktop?.folders?.[key] || '';
    const current = state.runtimeDraft.folders[key] || desktopPath;
    let path;
    try {
        if (window.mediaStudioDesktop?.chooseFolder) {
            path = await window.mediaStudioDesktop.chooseFolder({ title: FOLDER_TITLES[key], defaultPath: current });
        } else {
            const data = await json('/api/simple/pick-comfyui-directory', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ initial_path: current, title: FOLDER_TITLES[key] }),
            });
            path = data.cancelled ? null : data.path;
        }
    } catch (err) {
        return runtimeDetection('error', 'Could not open the folder picker', err.message);
    }
    if (!path) return;
    // Choosing Desktop's own folder simply follows Desktop again.
    state.runtimeDraft.folders[key] = samePath(path, desktopPath) ? null : path;
    paintDesktopChoice();
}

function runtimeFolderClick(event) {
    const button = event.target.closest('[data-action]');
    const key = button?.closest('.runtime-folder')?.dataset.folder;
    if (!key) return;
    if (button.dataset.action === 'pick') return pickRuntimeFolder(key);
    state.runtimeDraft.folders[key] = null;
    paintDesktopChoice();
}

function runtimeInstallClick(event) {
    const button = event.target.closest('[data-install]');
    if (!button) return;
    state.runtimeDraft.installationId = button.dataset.install;
    paintDesktopChoice();
}

async function rescanDesktop() {
    const button = $('runtime-rescan');
    button.disabled = true;
    try {
        await loadDesktop(true);
        state.runtimeDraft.installationId ||= state.desktop.installations[0]?.id || null;
        paintDesktopChoice();
        paintRuntimeCard();
    } finally {
        button.disabled = false;
    }
}

function closeRuntimeSettings() {
    const dialog = $('runtime-settings-dialog');
    if (!dialog || dialog.hidden) return;
    $('runtime-settings-backdrop').hidden = true;
    dialog.hidden = true;
    document.body.classList.remove('simple-modal-open');
}

async function saveRuntimeSettings(event) {
    event.preventDefault();
    const saveButton = $('runtime-save');
    const before = state.runtimeConfig || {};
    const draft = state.runtimeDraft;
    const payload = {
        desktop_installation_id: draft.installationId,
        host: $('runtime-host').value.trim() || '127.0.0.1',
        port: Number($('runtime-port').value) || 8188,
        // An empty folder follows Desktop again.
        ...Object.fromEntries(FOLDER_KEYS.map(key => [key, draft.folders[key] || ''])),
    };
    const token = $('runtime-civitai-token').value.trim();
    if (token) payload.civitai_api_token = token;
    const relaunch = draft.installationId !== before.desktop_installation_id
        || payload.host !== before.host || payload.port !== Number(before.port)
        || FOLDER_KEYS.some(key => (draft.folders[key] || null) !== (before[key] || null));
    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    try {
        await json('/api/comfyui/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        await loadRuntimeSummary();
        closeRuntimeSettings();
        if (relaunch && runtimeUp(state.runtimeStatus)) {
            // A running ComfyUI keeps its folders until it starts again.
            if (state.runtimeStatus.mode === 'managed') {
                state.runtimeStale = true;
                showNote('Saved. Restart ComfyUI to use the new settings.');
            } else {
                showNote('Saved. ComfyUI is running outside Create; the new settings apply the next time Create starts it.');
            }
        }
        await loadHealth(true);
        await loadDownloads();
    } catch (err) {
        runtimeDetection('error', 'Could not save settings', err.message);
    } finally {
        saveButton.disabled = false;
        saveButton.textContent = 'Save';
    }
}

let activeContextMenu = null;

function closeContextMenu() {
    if (activeContextMenu) {
        activeContextMenu.remove();
        activeContextMenu = null;
    }
}

function createMenuItem({ icon, label, badge, onClick }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'image-context-menu__item';
    btn.innerHTML = `${icon}<span class="image-context-menu__item-label">${esc(label)}</span>${badge ? `<span class="image-context-menu__badge">${esc(badge)}</span>` : ''}`;
    btn.addEventListener('click', () => {
        closeContextMenu();
        if (onClick) onClick();
    });
    return btn;
}

function createSubmenuItem({ icon, label, badge, items }) {
    const wrap = document.createElement('div');
    wrap.className = 'image-context-menu__submenu-wrap';

    const parentBtn = document.createElement('button');
    parentBtn.type = 'button';
    parentBtn.className = 'image-context-menu__item image-context-menu__item--submenu';
    parentBtn.innerHTML = `${icon}<span class="image-context-menu__item-label">${esc(label)}</span>${badge ? `<span class="image-context-menu__badge">${esc(badge)}</span>` : ''}<span class="image-context-menu__chevron" aria-hidden="true">›</span>`;

    const submenu = document.createElement('div');
    submenu.className = 'image-context-menu image-context-menu--submenu';
    submenu.hidden = true;

    items.forEach(it => {
        const itemBtn = document.createElement('button');
        itemBtn.type = 'button';
        itemBtn.className = 'image-context-menu__item';
        itemBtn.innerHTML = `${it.icon || '<span style="width:16px;display:inline-block;text-align:center;font-weight:700;color:var(--accent,#2dd4bf);flex-shrink:0">' + (it.active ? '✓' : '') + '</span>'}<span class="image-context-menu__item-label">${esc(it.label)}</span>`;
        itemBtn.addEventListener('click', e => {
            e.stopPropagation();
            closeContextMenu();
            if (it.onClick) it.onClick();
        });
        submenu.appendChild(itemBtn);
    });

    const openSub = () => {
        submenu.hidden = false;
        const rect = wrap.getBoundingClientRect();
        if (rect.right + 220 > window.innerWidth) {
            submenu.classList.add('image-context-menu--opens-left');
        } else {
            submenu.classList.remove('image-context-menu--opens-left');
        }
    };
    const closeSub = () => {
        submenu.hidden = true;
    };

    wrap.addEventListener('pointerenter', openSub);
    wrap.addEventListener('pointerleave', closeSub);

    wrap.appendChild(parentBtn);
    wrap.appendChild(submenu);
    return wrap;
}

function createSliderItem({ icon, label, min, max, step, value, format, onInput, onChange }) {
    const wrap = document.createElement('div');
    wrap.className = 'image-context-menu__slider-item';
    wrap.addEventListener('click', e => e.stopPropagation());
    wrap.addEventListener('mousedown', e => e.stopPropagation());
    wrap.addEventListener('contextmenu', e => e.stopPropagation());

    const header = document.createElement('div');
    header.className = 'image-context-menu__slider-header';

    const titleWrap = document.createElement('span');
    titleWrap.className = 'image-context-menu__slider-title';
    titleWrap.innerHTML = `${icon}<span>${esc(label)}</span>`;

    const valBadge = document.createElement('span');
    valBadge.className = 'image-context-menu__slider-val';
    valBadge.textContent = format ? format(value) : value;

    header.appendChild(titleWrap);
    header.appendChild(valBadge);

    const range = document.createElement('input');
    range.type = 'range';
    range.className = 'image-context-menu__range';
    range.min = String(min);
    range.max = String(max);
    range.step = String(step || 1);
    range.value = String(value);

    range.addEventListener('input', () => {
        const num = Number(range.value);
        valBadge.textContent = format ? format(num) : num;
        if (onInput) onInput(num);
    });

    range.addEventListener('change', () => {
        const num = Number(range.value);
        if (onChange) onChange(num);
    });

    wrap.appendChild(header);
    wrap.appendChild(range);
    return wrap;
}

function openStudioContextMenu(event) {
    if (event.target.closest('input, textarea, [contenteditable="true"]')) {
        return;
    }
    event.preventDefault();
    closeContextMenu();

    const menu = document.createElement('div');
    menu.className = 'image-context-menu studio-context-menu';

    const title = document.createElement('div');
    title.className = 'image-context-menu__title';
    title.textContent = 'Studio settings';
    menu.appendChild(title);

    menu.appendChild(createMenuItem({
        icon: '<svg viewBox="0 0 24 24"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>',
        label: 'Change background',
        onClick: () => ambientPick(),
    }));

    const sep1 = document.createElement('div');
    sep1.className = 'image-context-menu__separator';
    menu.appendChild(sep1);

    menu.appendChild(createSliderItem({
        icon: '<svg viewBox="0 0 24 24"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
        label: 'Card opacity',
        min: 10,
        max: 95,
        step: 1,
        value: state.opacity ?? 44,
        format: v => `${v}%`,
        onInput: v => {
            state.opacity = v;
            applyVisualSettings();
        },
        onChange: v => {
            state.opacity = v;
            save('mediastudio_simple_glass_opacity', state.opacity);
        },
    }));

    menu.appendChild(createSliderItem({
        icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><line x1="12" y1="1" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="23"/><line x1="1" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="23" y2="12"/></svg>',
        label: 'Background blur',
        min: 0,
        max: 40,
        step: 1,
        value: state.blur ?? 10,
        format: v => (v === 0 ? 'No blur' : `${v} px`),
        onInput: v => {
            state.blur = v;
            applyVisualSettings();
        },
        onChange: v => {
            state.blur = v;
            save('mediastudio_simple_ambient_blur', state.blur);
        },
    }));

    menu.appendChild(createSliderItem({
        icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
        label: 'Change interval',
        min: 0,
        max: 600,
        step: 15,
        value: Math.round((state.interval || 0) / 1000),
        format: v => {
            if (v === 0) return 'Disabled';
            if (v < 60) return `${v} sec`;
            const m = Math.floor(v / 60);
            const s = v % 60;
            return s ? `${m} min ${s} sec` : `${m} min`;
        },
        onInput: setAmbientInterval,
        onChange: setAmbientInterval,
    }));

    const sep2 = document.createElement('div');
    sep2.className = 'image-context-menu__separator';
    menu.appendChild(sep2);

    const fitLabels = {
        cover: 'Cover',
        contain: 'Contain',
        original: '1:1',
    };
    menu.appendChild(createSubmenuItem({
        icon: '<svg viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
        label: 'Background fit',
        badge: fitLabels[state.fit] || 'Cover',
        items: [
            {
                label: 'Cover',
                active: state.fit === 'cover',
                onClick: () => {
                    state.fit = 'cover';
                    save('mediastudio_simple_ambient_fit', state.fit);
                    applyVisualSettings();
                },
            },
            {
                label: 'Contain',
                active: state.fit === 'contain',
                onClick: () => {
                    state.fit = 'contain';
                    save('mediastudio_simple_ambient_fit', state.fit);
                    applyVisualSettings();
                },
            },
            {
                label: 'Original (1:1)',
                active: state.fit === 'original',
                onClick: () => {
                    state.fit = 'original';
                    save('mediastudio_simple_ambient_fit', state.fit);
                    applyVisualSettings();
                },
            },
        ],
    }));

    menu.appendChild(createMenuItem({
        icon: '<svg viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
        label: 'Completion sound',
        badge: state.sound ? 'On' : 'Off',
        onClick: () => {
            state.sound = !state.sound;
            save('mediastudio_simple_sound_alert', state.sound);
            if (state.sound) playSuccessChime();
        },
    }));

    menu.appendChild(createMenuItem({
        icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.6v-.1A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 8.5 4.1a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V2h4v.4A1.7 1.7 0 0 0 15 4.1a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 8.5a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.9v4h-.9a1.7 1.7 0 0 0-1.7 1.1Z"/></svg>',
        label: 'ComfyUI settings…',
        onClick: () => openRuntimeSettings(),
    }));

    document.body.appendChild(menu);
    activeContextMenu = menu;

    const menuRect = menu.getBoundingClientRect();
    let x = event.clientX;
    let y = event.clientY;
    if (x + menuRect.width > window.innerWidth - 8) {
        x = Math.max(8, window.innerWidth - menuRect.width - 8);
    }
    if (y + menuRect.height > window.innerHeight - 8) {
        y = Math.max(8, window.innerHeight - menuRect.height - 8);
    }
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
}

document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', init)
    : init();
