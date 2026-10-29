// Integrations › Remote GPU: Colab CLI setup, Google sign-in, compute units and runtime settings.
import { customConfirm } from './utils.js';

const PANE = 'remote';
const INSTALL_POLL_MS = 1500;

let status = null;
let usage = null;
let usageError = null;
let loading = false;
let login = null; // { url, busy, error }
let installTimer = null;
let newerVersion = null;
let settingsTimer = null;
let runtime = null; // MediaStudio's own Colab runtime
let runtimeTimer = null;

function $(id) {
    return document.getElementById(id);
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
        const error = new Error(data.error || `${response.status} ${response.statusText}`);
        error.code = data.code;
        throw error;
    }
    return data;
}

function postJson(url, body = {}) {
    return requestJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function toast(message, isError = false) {
    const node = $('toast');
    if (!node) return;
    node.textContent = message;
    node.classList.toggle('toast-error', isError);
    node.classList.add('show');
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => node.classList.remove('show'), 3600);
}

function button(label, onClick, className = 'btn btn-secondary') {
    const node = el('button', className, label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
}

function card(title, subtitle, badge) {
    const article = el('article', 'cli-card remote-card');
    const top = el('div', 'cli-topline');
    const heading = el('div');
    heading.append(el('h3', '', title));
    if (subtitle) heading.append(el('p', 'cli-path', subtitle));
    top.append(heading);
    if (badge) top.append(el('span', `cli-status ${badge.className}`, badge.text));
    article.append(top);
    return article;
}

function badgeRow(items) {
    const row = el('div', 'badge-row');
    items.filter(Boolean).forEach(text => row.append(el('span', 'profile-badge', text)));
    return row;
}

function actions(...buttons) {
    const row = el('div', 'card-actions');
    buttons.filter(Boolean).forEach(item => row.append(item));
    return row;
}

/* ---------- data ---------- */

async function loadStatus(refresh = false) {
    if (loading) return;
    loading = true;
    render();
    try {
        status = await requestJson(`/api/remote/colab/status${refresh ? '?refresh=1' : ''}`);
        if (status.install?.state === 'running') pollInstall();
    } catch (error) {
        toast(error.message, true);
    } finally {
        loading = false;
    }
    render();
    if (status?.account?.signed_in) {
        loadUsage(false);
        loadRuntime();
    }
}

async function loadRuntime() {
    window.clearTimeout(runtimeTimer);
    try {
        runtime = await requestJson('/api/remote/colab/runtime');
    } catch {
        runtime = null;
    }
    render();
    if (['allocating', 'booting'].includes(runtime?.state) && runtime.model_cache?.enabled) {
        runtimeTimer = window.setTimeout(loadRuntime, 2000);
    }
}

async function stopRuntime() {
    try {
        runtime = await postJson('/api/remote/colab/runtime/stop');
        toast('Stopping the Colab runtime.');
    } catch (error) {
        toast(error.message, true);
    }
    render();
    window.setTimeout(() => { loadRuntime(); loadUsage(true); }, 4000);
}

async function loadUsage(refresh) {
    try {
        usage = await requestJson(`/api/remote/colab/usage${refresh ? '?refresh=1' : ''}`);
        usageError = null;
    } catch (error) {
        usageError = error.message;
    }
    render();
}

function pollInstall() {
    window.clearTimeout(installTimer);
    installTimer = window.setTimeout(async () => {
        try {
            const job = await requestJson('/api/remote/colab/install');
            status = { ...status, install: job };
            render();
            if (job.state === 'running') {
                pollInstall();
            } else {
                toast(job.state === 'succeeded' ? 'Colab CLI is installed.' : 'Colab CLI install failed; see the log.', job.state !== 'succeeded');
                newerVersion = null;
                loadStatus();
            }
        } catch (error) {
            toast(error.message, true);
        }
    }, INSTALL_POLL_MS);
}

/* ---------- actions ---------- */

async function installWsl() {
    try {
        await postJson('/api/remote/wsl/install');
        toast('Windows asks for permission to set up WSL. Restart the computer when it finishes, then press Re-check.');
    } catch (error) {
        toast(error.message, true);
    }
}

async function installCli() {
    try {
        const job = await postJson('/api/remote/colab/install');
        status = { ...status, install: job };
        render();
        pollInstall();
    } catch (error) {
        toast(error.message, true);
    }
}

async function checkUpdate() {
    try {
        const data = await requestJson('/api/remote/colab/update');
        newerVersion = data.newer_version;
        toast(newerVersion ? `Colab CLI ${newerVersion} is available.` : 'The Colab CLI is up to date.');
        render();
    } catch (error) {
        toast(error.message, true);
    }
}

async function startLogin() {
    login = { url: null, busy: true, error: null };
    render();
    try {
        const data = await postJson('/api/remote/colab/login');
        if (data.signed_in) {
            login = null;
            toast(`Signed in as ${data.email}.`);
            await loadStatus();
            return;
        }
        login = { url: data.url, busy: false, error: null };
        window.open(data.url, '_blank', 'noopener');
    } catch (error) {
        login = { url: null, busy: false, error: error.message };
    }
    render();
}

async function submitCode(code) {
    if (!code.trim()) {
        login = { ...login, error: 'Paste the code Google showed after sign-in.' };
        render();
        return;
    }
    login = { ...login, busy: true, error: null };
    render();
    try {
        const data = await postJson('/api/remote/colab/login/code', { code });
        login = null;
        toast(`Signed in as ${data.email}.`);
        await loadStatus();
    } catch (error) {
        login = { url: error.code === 'login_failed' ? null : login.url, busy: false, error: error.message };
        render();
    }
}

async function logout() {
    const confirmed = await customConfirm(
        'Sign out of Colab?',
        'This removes the Colab CLI sign-in inside WSL, so the colab command outside MediaStudio is signed out too.',
    );
    if (!confirmed) return;
    try {
        await postJson('/api/remote/colab/logout');
        usage = null;
        toast('Signed out of Colab.');
        await loadStatus();
    } catch (error) {
        toast(error.message, true);
    }
}

async function saveSettings(colab) {
    try {
        const data = await postJson('/api/remote/settings', { colab });
        status = { ...status, settings: data };
        render();
    } catch (error) {
        toast(error.message, true);
    }
}

/* ---------- cards ---------- */

function setupCard() {
    const wslState = status?.wsl || {};
    const cli = status?.cli || {};
    const install = status?.install || { state: 'idle', log: [] };
    const running = install.state === 'running';
    let badge;
    if (!wslState.available) badge = { className: 'warning', text: 'WSL needed' };
    else if (running) badge = { className: 'neutral', text: 'Installing…' };
    else if (cli.installed) badge = { className: 'available', text: 'Ready' };
    else badge = { className: 'neutral', text: 'Not installed' };

    const node = card('Colab CLI', cli.installed ? `google-colab-cli ${cli.version}` : 'Google’s command-line tool for Colab', badge);
    const message = el('p', 'cli-message');
    if (!wslState.available) {
        message.textContent = 'The Colab CLI runs on Linux, so Windows needs WSL with a Linux distribution. '
            + (wslState.detail ? `(${wslState.detail}) ` : '')
            + 'Setup asks for administrator permission and a restart.';
    } else if (cli.installed) {
        message.textContent = `Runs inside WSL (${wslState.distro}). MediaStudio keeps its own runtimes apart from the ones you start with colab by hand.`;
    } else {
        message.textContent = `Installs uv and google-colab-cli inside WSL (${wslState.distro}); nothing is installed in Windows itself.`;
    }
    node.append(message);
    node.append(badgeRow([wslState.distro && `WSL: ${wslState.distro}`, cli.version && `CLI ${cli.version}`]));

    if (install.log?.length && (running || install.state === 'failed')) {
        const log = el('pre', 'remote-log');
        log.textContent = install.log.slice(-14).join('\n');
        node.append(log);
    }

    const buttons = [];
    if (!wslState.available) {
        buttons.push(button('Install WSL', installWsl, 'btn btn-primary'));
    } else if (!cli.installed) {
        const installButton = button(running ? 'Installing…' : 'Install Colab CLI', installCli, 'btn btn-primary');
        installButton.disabled = running;
        buttons.push(installButton);
    } else if (newerVersion) {
        const updateButton = button(running ? 'Updating…' : `Update to ${newerVersion}`, installCli, 'btn btn-primary');
        updateButton.disabled = running;
        buttons.push(updateButton);
    } else {
        buttons.push(button('Check for update', checkUpdate));
    }
    const recheck = button(loading ? 'Checking…' : 'Re-check', () => loadStatus(true));
    recheck.disabled = loading;
    buttons.push(recheck);
    node.append(actions(...buttons));
    return node;
}

function loginBlock() {
    const block = el('div', 'remote-login');
    block.append(el('p', 'remote-login-step', 'Google opened in your browser. Sign in, allow access, then copy the code Google shows and paste it here.'));
    const open = el('a', 'remote-login-link', 'Open the Google sign-in page again');
    open.href = login.url;
    open.target = '_blank';
    open.rel = 'noopener';
    block.append(open);
    const row = el('div', 'remote-login-row');
    const input = el('input', 'remote-login-code');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'Authorization code';
    input.setAttribute('aria-label', 'Authorization code from Google');
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') submitCode(input.value);
    });
    const confirm = button(login.busy ? 'Signing in…' : 'Confirm', () => submitCode(input.value), 'btn btn-primary');
    confirm.disabled = login.busy;
    row.append(input, confirm);
    block.append(row);
    window.setTimeout(() => input.focus(), 0);
    return block;
}

function accountCard() {
    const account = status?.account || {};
    const cliReady = status?.cli?.installed;
    const node = card(
        'Google account',
        account.signed_in ? account.email : 'Not signed in',
        account.signed_in ? { className: 'available', text: 'Signed in' } : { className: 'neutral', text: 'Signed out' },
    );
    node.append(el('p', 'cli-message', account.signed_in
        ? 'Colab runtimes start under this account and use its compute units. MediaStudio never sees the password or the token.'
        : 'Colab runs under the Google account you sign in with, so a paid plan’s GPUs and compute units are yours to use. MediaStudio never sees the password or the token.'));
    if (login?.url) node.append(loginBlock());
    if (login?.error) node.append(el('p', 'card-test-result error', login.error));

    const buttons = [];
    if (account.signed_in) {
        buttons.push(button('Sign out', logout));
    } else if (cliReady) {
        if (login?.url) {
            buttons.push(button('Cancel', () => { login = null; render(); }));
        } else {
            const signIn = button(login?.busy ? 'Opening Google…' : 'Sign in with Google', startLogin, 'btn btn-primary');
            signIn.disabled = Boolean(login?.busy);
            buttons.push(signIn);
        }
    }
    if (buttons.length) node.append(actions(...buttons));
    return node;
}

function usageCard() {
    const node = card('Compute units', 'Balance and runtimes', null);
    if (usageError) {
        node.append(el('p', 'card-test-result error', usageError));
    } else if (!usage) {
        node.append(el('p', 'cli-message', 'Asking Colab…'));
    } else {
        const balance = el('div', 'remote-balance');
        balance.append(el('strong', '', usage.balance.toFixed(2)), el('span', '', 'compute units left'));
        node.append(balance);
        const stats = el('dl', 'remote-stats');
        const add = (term, value) => stats.append(el('dt', '', term), el('dd', '', value));
        add('Spending now', `${(usage.rate_per_hour ?? 0).toFixed(2)} CU per hour`);
        add('Active runtimes', String(usage.active_assignments ?? 0));
        node.append(stats);
        if (usage.sessions?.length) {
            const list = el('ul', 'remote-sessions');
            usage.sessions.forEach(item => {
                const row = el('li');
                row.append(el('strong', '', item.name === '?' ? 'Started outside MediaStudio' : item.name), el('span', '', `${item.hardware} · ${item.variant}`));
                list.append(row);
            });
            node.append(list);
        }
        node.append(el('p', 'cli-message', 'Colab updates the balance with a delay; the rate shows what running runtimes spend.'));
    }
    const live = ['allocating', 'booting', 'ready'].includes(runtime?.state);
    if (live) {
        const where = runtime.gpu_name ? runtime.gpu_name.split(',')[0].replace(/^NVIDIA\s+/, '') : `Colab ${runtime.gpu}`;
        node.append(el('p', 'cli-message', `Create's runtime is ${runtime.state === 'ready' ? 'running' : 'starting'} on ${where}. It stops by itself after the idle time below.`));
    }
    node.append(actions(
        button('Refresh', () => { loadUsage(true); loadRuntime(); }),
        live && button('Stop runtime', stopRuntime),
    ));
    return node;
}

function settingsCard() {
    const settings = status?.settings;
    const node = card('Runtime', 'GPU and idle auto-stop', null);
    if (!settings) return node;
    const list = el('div', 'remote-gpu-list');
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', 'Colab GPU');
    // Colab names the GPUs this plan may use; until it answered, every choice is offered.
    const eligible = usage?.eligible_gpus || null;
    settings.gpus.forEach(gpu => {
        const allowed = !eligible || eligible.includes(gpu.id);
        const option = el('label', `remote-gpu-option${gpu.id === settings.colab.gpu ? ' selected' : ''}${allowed ? '' : ' unavailable'}`);
        const radio = el('input');
        radio.type = 'radio';
        radio.name = 'remote-gpu';
        radio.value = gpu.id;
        radio.checked = gpu.id === settings.colab.gpu;
        radio.disabled = !allowed && gpu.id !== settings.colab.gpu;
        radio.addEventListener('change', () => saveSettings({ gpu: gpu.id }));
        const text = el('span', 'remote-gpu-text');
        const rate = gpu.cu_per_hour ? ` · about ${gpu.cu_per_hour.toFixed(2)} CU/h` : '';
        const note = allowed ? gpu.note : 'Not on your Colab plan';
        text.append(el('strong', '', gpu.label), el('small', '', `Colab ${gpu.id} · ${gpu.vram_gb} GB${rate} · ${note}`));
        option.append(radio, text);
        list.append(option);
    });
    node.append(list);

    const [min, max] = settings.idle_minutes_range;
    const idle = el('div', 'remote-idle');
    const label = el('label', 'remote-idle-label');
    label.htmlFor = 'remote-idle-minutes';
    const value = el('strong', '', `${settings.colab.idle_minutes} min`);
    label.append(el('span', '', 'Stop the runtime after'), value, el('span', '', 'without work'));
    const range = el('input');
    range.type = 'range';
    range.id = 'remote-idle-minutes';
    range.min = String(min);
    range.max = String(max);
    range.step = '1';
    range.value = String(settings.colab.idle_minutes);
    range.addEventListener('input', () => {
        value.textContent = `${range.value} min`;
        window.clearTimeout(settingsTimer);
        settingsTimer = window.setTimeout(() => saveSettings({ idle_minutes: Number(range.value) }), 400);
    });
    idle.append(label, range, el('p', 'cli-message', `From ${min} to ${max} minutes. The remote notebook also stops itself shortly after that if MediaStudio is closed or the computer sleeps.`));
    node.append(idle);
    const cacheOption = el('label', 'remote-gpu-option');
    const cacheToggle = el('input');
    cacheToggle.type = 'checkbox';
    cacheToggle.checked = Boolean(settings.colab.model_cache);
    cacheToggle.addEventListener('change', () => saveSettings({ model_cache: cacheToggle.checked }));
    cacheOption.append(cacheToggle, el('span', 'remote-gpu-text', 'Keep model weights in Google Drive'));
    node.append(cacheOption, el('p', 'cli-message',
        'Takes effect in the next Colab runtime. Models are saved in My Drive / VEIL / model-cache and copied to the fast runtime disk for generation. Google may ask you to grant Drive access.'));
    const cache = runtime?.model_cache;
    const states = {mounting: 'Connecting Google Drive…', authorizing: 'Google Drive needs your approval.',
        ready: 'Google Drive model cache is ready.', saving: 'Saving model weights to Google Drive…',
        saved: 'Model weights saved in Google Drive.', restoring: 'Loading cached weights from Google Drive…',
        restored: 'Cached model weights loaded.', warning: 'The model cache reported an error; generation can still use the runtime copy.',
        error: 'Google Drive could not connect. Grant access and try again.'};
    if (cache?.enabled && states[cache.state]) node.append(el('p', 'cli-message', states[cache.state]));
    if (cache?.auth_url) {
        const link = el('a', 'btn btn-primary', 'Grant Google Drive access');
        link.href = cache.auth_url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        const resume = button('I have granted access', async () => {
            try {
                runtime = await postJson('/api/remote/colab/drive/continue');
                render();
                loadRuntime();
            } catch (error) { toast(error.message, true); }
        });
        node.append(actions(link, resume));
    }
    return node;
}

function render() {
    const grid = $('remote-grid');
    if (!grid) return;
    if (!status) {
        const placeholder = card('Remote GPU', null, { className: 'neutral', text: loading ? 'Checking…' : 'Not checked' });
        placeholder.append(el('p', 'cli-message', loading ? 'Checking WSL, the Colab CLI and your account…' : 'Open this tab to check.'));
        grid.replaceChildren(placeholder);
        return;
    }
    const cards = [setupCard(), accountCard()];
    if (status.account?.signed_in) cards.push(usageCard());
    if (status.cli?.installed) cards.push(settingsCard());
    grid.replaceChildren(...cards);
}

function onPane() {
    if (window.location.hash.replace('#', '') !== PANE || loading) return;
    if (!status) loadStatus();
    else loadRuntime();
}

render();
window.addEventListener('hashchange', onPane);
onPane();
