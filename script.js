const obs = new OBSWebSocket();

// Standardize the Haptic function name
const triggerHapticFeedback = () => {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(15);
    }
};

// If your older code uses 'poke', point it to the new one
const poke = triggerHapticFeedback;



let timerIdx = null, seconds = 0, reconnectInterval = null;
let customSounds = JSON.parse(localStorage.getItem('obs_custom_sounds')) || [];
// --- 1. THE MASTER BUTTON FACTORY ---
function createButton(label, icon, action, id = null) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    if (id) btn.id = id;

    const fontSizeClass = label.length > 12 ? 'text-small' : '';

    // Check if icon is an Emoji (Regex checks for non-text/standard characters)
    const isEmoji = /\p{Emoji}/u.test(icon) && !/^[a-z0-9_]+$/i.test(icon);

    if (isEmoji) {
        // If it's an emoji, use a plain span with a specific class for sizing
        btn.innerHTML = `
            <span class="emoji-icon">${icon}</span>
            <span class="label-text ${fontSizeClass}">${label}</span>
        `;
    } else {
        // If it's a word (like 'mic'), use the Google Icon span
        btn.innerHTML = `
            <span class="material-symbols-outlined">${icon}</span>
            <span class="label-text ${fontSizeClass}">${label}</span>
        `;
    }

    btn.onclick = () => {
        if (navigator.vibrate) navigator.vibrate(15);
        action();
    };
    return btn;
}

// --- 2. INITIALIZATION ---
window.onload = () => {
    const fields = ['ip', 'port', 'pass'];
    fields.forEach(f => {
        const val = localStorage.getItem('obs_' + f);
        if (val) document.getElementById(f).value = val;
    });
    
    renderSystemButtons();
    renderSoundboard();
    if (localStorage.getItem('obs_ip')) connect();
};

async function saveAndConnect() {
    ['ip', 'port', 'pass'].forEach(f => {
        localStorage.setItem('obs_' + f, document.getElementById(f).value);
    });
    connect();
}

async function connect() {
    const ip = document.getElementById('ip').value;
    const port = document.getElementById('port').value || '4455';
    const pass = document.getElementById('pass').value;
    try {
        await obs.connect(`ws://${ip}:${port}`, pass);
        clearInterval(reconnectInterval);
        reconnectInterval = null;
        document.getElementById('dot').className = 'status-dot online';
        document.getElementById('status-text').innerText = 'CONNECTED';
        document.getElementById('config').classList.remove('open');
        
        loadScenes();
        loadAudioMixer();
        syncTimerState();
    } catch (e) {
        document.getElementById('status-text').innerText = 'RETRYING...';
        if (!reconnectInterval) reconnectInterval = setInterval(connect, 5000);
    }
}

// --- 3. DYNAMIC GENERATORS ---
function renderSystemButtons() {
    const grid = document.getElementById('system-grid');
    grid.innerHTML = '';
    grid.appendChild(createButton('Live', 'podcasts', () => obs.call('ToggleStream'), 'stream-btn'));
    grid.appendChild(createButton('Rec', 'fiber_manual_record', () => obs.call('ToggleRecord'), 'record-btn'));
    grid.appendChild(createButton('Clip', 'history', saveReplay, 'replay-btn'));
    grid.appendChild(createButton('Mute', 'volume_off', toggleGlobalMute, 'master-mute'));
}
let sortableInstance; // Global variable to store the sortable object

function initSortable() {
    const el = document.getElementById('scene-grid');
    const isLocked = localStorage.getItem('obs_layout_locked') === 'true';
    
    // Set the checkbox state in config UI
    document.getElementById('lock-toggle').checked = isLocked;

    sortableInstance = Sortable.create(el, {
        animation: 150,
        delay: 200,
        disabled: isLocked, // This is the magic line
        ghostClass: 'sortable-ghost',
        onEnd: () => saveSceneOrder()
    });
}

function toggleLock(checked) {
    localStorage.setItem('obs_layout_locked', checked);
    
    if (sortableInstance) {
        // Enable or disable dragging instantly
        sortableInstance.option("disabled", checked);
    }
    
    // Optional: Add a visual hint to the grid
    document.getElementById('scene-grid').style.opacity = checked ? "1" : "0.9";
}


function saveSceneOrder() {
    const sceneOrder = [];
    document.querySelectorAll('#scene-grid .btn').forEach(btn => {
        // We save the text or ID of the scene
        sceneOrder.push(btn.innerText.trim());
    });
    
    // Save to local storage
    localStorage.setItem('obs_scene_order', JSON.stringify(sceneOrder));
    console.log("New scene order saved!");
}


async function loadScenes() {
    const { scenes, currentProgramSceneName } = await obs.call('GetSceneList');
    const grid = document.getElementById('scene-grid');
    grid.innerHTML = '';

    // 1. Check if we have a saved order in LocalStorage
    const savedOrder = JSON.parse(localStorage.getItem('obs_scene_order'));

    let finalScenes = scenes;

    if (savedOrder) {
        // Sort scenes to match the user's custom order
        finalScenes = scenes.sort((a, b) => {
            const indexA = savedOrder.indexOf(a.sceneName);
            const indexB = savedOrder.indexOf(b.sceneName);
            
            // If a scene isn't in the saved list (newly added), put it at the end
            return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB);
        });
    }

    // 2. Create the buttons
    finalScenes.forEach(s => {
        const btn = createButton(
            s.sceneName, 
            'layers', 
            () => obs.call('SetCurrentProgramScene', { sceneName: s.sceneName }), 
            `scene-${s.sceneName.replace(/\s+/g, '-')}`
        );
        
        if (s.sceneName === currentProgramSceneName) btn.classList.add('active');
        grid.appendChild(btn);
    });

    // 3. Initialize SortableJS
    initSortable();
}

async function saveReplay() {
    try {
        await obs.call('SaveReplayBuffer');
        const btn = document.getElementById('replay-btn');
        btn.classList.add('active'); // Flash green on success
        setTimeout(() => btn.classList.remove('active'), 2000);
    } catch (e) {
        console.error("Replay Buffer not active. Enable it in OBS Settings.");
    }
}
async function loadAudioMixer() {
    const container = document.getElementById('audio-mixer');
    if (!container) return;
    container.innerHTML = ''; 

    try {
        const { inputs } = await obs.call('GetInputList');

        // Linux-specific audio kinds from your console:
        // 'alsa_input_capture' = Your Mic
        // 'ffmpeg_source' = Your Soundboard (horn, boing, clap)
        // 'pipewire-audio-client-external' = Desktop Audio (usually)
        const audioKinds = [
            'alsa_input_capture', 
            'ffmpeg_source', 
            'pipewire-audio-client-external', 
            'pulse_input_capture', 
            'pulse_output_capture',
            'vlc_source'
        ];

        for (const input of inputs) {
            // ONLY proceed if it's one of the audio types we identified
            if (audioKinds.includes(input.inputKind)) {
                try {
                    // Ask OBS for mute status
                    const { inputMuted } = await obs.call('GetInputMute', { inputName: input.inputName });

                    let icon = 'volume_up';
                    if (input.inputKind.includes('input') || input.inputName.toLowerCase().includes('mic')) {
                        icon = 'mic';
                    }
                    if (input.inputKind === 'ffmpeg_source') {
                        icon = 'music_note'; // Better for soundboard
                    }

                    const btn = createButton(
                        input.inputName, 
                        icon, 
                        () => obs.call('ToggleInputMute', { inputName: input.inputName }), 
                        `mute-${input.inputName.replace(/\s+/g, '-')}`
                    );

                    if (inputMuted) {
                        btn.classList.add('danger-active');
                        const iconSpan = btn.querySelector('.material-symbols-outlined');
                        if (iconSpan) iconSpan.innerText = (icon === 'mic') ? 'mic_off' : 'volume_off';
                    }

                    container.appendChild(btn);
                } catch (muteError) {
                    // This catches cases where OBS thinks it's audio but it can't be muted
                    console.warn(`Skipping ${input.inputName}: Does not support muting.`);
                }
            }
        }
    } catch (e) {
        console.error("Mixer Error:", e);
    }
}
// Helper to keep code DRY using your createButton factory
async function createAudioMuteButton(input, container) {
    let icon = 'volume_up';
    if (input.inputKind.includes('input')) icon = 'mic';
    if (input.inputKind.includes('ffmpeg')) icon = 'music_note';

    const btn = createButton(
        input.inputName, 
        icon, 
        () => obs.call('ToggleInputMute', { inputName: input.inputName }),
        `mute-${input.inputName.replace(/\s+/g, '-')}`
    );

    // Initial State Check
    const { inputMuted } = await obs.call('GetInputMute', { inputName: input.inputName });
    if (inputMuted) btn.classList.add('danger-active');

    container.appendChild(btn);
}

// --- 4. SOUNDBOARD LOGIC ---
function addNewSound() {
    triggerHapticFeedback();
    
    const nameInput = document.getElementById('new-sound-name');
    const emojiInput = document.getElementById('new-sound-emoji');
    
    const name = nameInput.value.trim();
    // Default to 'play_arrow' if emoji input is empty
    const icon = emojiInput.value.trim() || 'play_arrow';

    if (!name) {
        alert("Please enter the Source Name exactly as it appears in OBS.");
        return;
    }

    // Add to our global array
    customSounds.push({
        name: name,
        icon: icon
    });

    // Save to LocalStorage so it persists after refresh
    localStorage.setItem('obs_custom_sounds', JSON.stringify(customSounds));

    // Refresh the UI
    renderSoundboard();

    // Clear the inputs for the next sound
    nameInput.value = '';
    emojiInput.value = '';
    
    console.log(`Added sound: ${name} with icon: ${icon}`);
}

function renderSoundboard() {
    const grid = document.getElementById('soundboard-grid');
    if (!grid) return;
    grid.innerHTML = '';

    customSounds.forEach((sound, index) => {
        const buttonIcon = sound.icon || 'play_arrow';

        const btn = createButton(
            sound.name, 
            buttonIcon, 
            () => {
                obs.call('TriggerMediaInputAction', { 
                    inputName: sound.name, 
                    mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' 
                }).catch(err => console.error("Playback error:", err));
            }
        );
        
        // Context menu (Long press) to delete
        btn.oncontextmenu = (e) => {
            e.preventDefault();
            triggerHapticFeedback(); // Use your haptic helper
            if(confirm(`Delete ${sound.name}?`)) {
                customSounds.splice(index, 1);
                localStorage.setItem('obs_custom_sounds', JSON.stringify(customSounds));
                renderSoundboard();
            }
        };

        grid.appendChild(btn);
    });
}
function clearSoundboardData() {
    if (confirm("Are you sure you want to remove ALL buttons from your soundboard?")) {
        // 1. Empty the local array
        customSounds = [];

        // 2. Update LocalStorage so they stay gone on refresh
        localStorage.setItem('obs_custom_sounds', JSON.stringify(customSounds));

        // 3. Re-render the grid (it will now be empty)
        renderSoundboard();
        
        console.log("Soundboard cleared.");
    }
}

// --- 5. GLOBAL MUTE TOGGLE ---
async function toggleGlobalMute() {
    triggerHapticFeedback();
    
    const masterBtn = document.getElementById('master-mute');
    if (!masterBtn) return;

    try {
        // 1. Check the UI: If the button is RED (danger-active), we want to UNMUTE (false)
        // If the button is NOT red, we want to MUTE (true)
        const shouldMute = !masterBtn.classList.contains('danger-active');

        // 2. Get all sources
        const { inputs } = await obs.call('GetInputList');

        // 3. Process every source individually
        for (const input of inputs) {
            try {
                await obs.call('SetInputMute', {
                    inputName: input.inputName,
                    inputMuted: shouldMute
                });
            } catch (innerError) {
                // Ignore errors for images/scenes/sources without audio
                continue;
            }
        }

        // 4. Update the Master Button UI immediately
        if (shouldMute) {
            masterBtn.classList.add('danger-active');
            masterBtn.querySelector('span').innerText = 'All Muted';
            masterBtn.querySelector('.material-symbols-outlined').innerText = 'volume_off';
        } else {
            masterBtn.classList.remove('danger-active');
            masterBtn.querySelector('span').innerText = 'All Sound On';
            masterBtn.querySelector('.material-symbols-outlined').innerText = 'volume_up';
        }

    } catch (error) {
        console.error("Global Mute Error:", error);
    }
}// --- 7. TIMER & STATE LOGIC ---

/**
 * Checks if OBS is streaming or recording and starts/stops the clock
 */
async function syncTimerState() {
    try {
        const stream = await obs.call('GetStreamStatus');
        const record = await obs.call('GetRecordStatus');

        // If either output is active, ensure the interval is running
        if (stream.outputActive || record.outputActive) {
            if (!timerIdx) {
                timerIdx = setInterval(() => {
                    seconds++;
                    const timeString = new Date(seconds * 1000).toISOString().substr(11, 8);
                    document.getElementById('timer').innerText = timeString;
                }, 1000);
            }
        } else {
            // Stop and reset if nothing is running
            clearInterval(timerIdx);
            timerIdx = null;
            seconds = 0;
            document.getElementById('timer').innerText = "00:00:00";
        }
    } catch (e) {
        console.error("Timer Sync Failed", e);
    }
}

// --- 8. OBS STATUS EVENT LISTENERS ---

// Stream State: Turns the button RED when live
obs.on('StreamStateChanged', d => {
    const btn = document.getElementById('stream-btn');
    if (btn) {
        btn.classList.toggle('danger-active', d.outputActive);
        // Change icon to 'stop' when live
        const icon = btn.querySelector('.material-symbols-outlined');
        if (icon) icon.innerText = d.outputActive ? 'stop_circle' : 'podcasts';
    }
    syncTimerState();
});

// Record State: Turns the button RED when recording
obs.on('RecordStateChanged', d => {
    const btn = document.getElementById('record-btn');
    if (btn) {
        btn.classList.toggle('danger-active', d.outputActive);
        // Change icon to 'pause' or 'stop' when recording
        const icon = btn.querySelector('.material-symbols-outlined');
        if (icon) icon.innerText = d.outputActive ? 'stop_circle' : 'fiber_manual_record';
    }
    syncTimerState();
});

// Handle disconnected state
obs.on('ConnectionClosed', () => {
    document.getElementById('dot').className = 'status-dot';
    document.getElementById('status-text').innerText = 'OFFLINE';
    // Clear the timer if connection drops
    clearInterval(timerIdx);
    timerIdx = null;
    if (!reconnectInterval) reconnectInterval = setInterval(connect, 5000);
});

obs.on('InputMuteStateChanged', data => {
    // Matches the ID format: mute-Mic-Aux
    const safeId = `mute-${data.inputName.replace(/\s+/g, '-')}`;
    const btn = document.getElementById(safeId);
    
    if (btn) {
        const iconSpan = btn.querySelector('.material-symbols-outlined');
        
        // Toggle the red background class
        btn.classList.toggle('danger-active', data.inputMuted);

        if (iconSpan) {
            // Logic for Microphone icon swap
            if (iconSpan.innerText === 'mic' || iconSpan.innerText === 'mic_off') {
                iconSpan.innerText = data.inputMuted ? 'mic_off' : 'mic';
            } 
            // Logic for Speaker icon swap
            else if (iconSpan.innerText === 'volume_up' || iconSpan.innerText === 'volume_off') {
                iconSpan.innerText = data.inputMuted ? 'volume_off' : 'volume_up';
            }
        }
    }
});

// Add 'async' here so 'await' works inside
obs.on('CurrentProgramSceneChanged', async data => {
    // 1. Update Scene Button UI Highlighting
    document.querySelectorAll('#scene-grid .btn').forEach(btn => {
        btn.classList.remove('active');
    });

    const safeId = `scene-${data.sceneName.replace(/\s+/g, '-')}`;
    const activeBtn = document.getElementById(safeId);
    
    if (activeBtn) {
        activeBtn.classList.add('active');
    }

    // 2. Refresh Audio Mixer 
    // We move this OUTSIDE the if(activeBtn) so the mixer updates 
    // even if you switch to a scene that doesn't have a button yet.
    await loadAudioMixer();
});

obs.on('InputMuteStateChanged', async () => {
    // Optional: Add logic here to check if ALL inputs are currently muted
    // and highlight the 'master-mute' button automatically.
});
