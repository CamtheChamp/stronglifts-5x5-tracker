const STORAGE_KEY = 'sl5x5_state';

// Bump this alongside CACHE_NAME in sw.js so the dashboard shows which build is
// currently loaded - handy for confirming an update actually took effect.
const APP_VERSION = 'v17';

// --- Cloud sync (Supabase) ---
// To enable cloud sync, create a Supabase project, run supabase/schema.sql in its
// SQL editor, enable the Google auth provider, and fill in these two values with
// your project's URL and anon public key (Project Settings > API). Both values are
// meant to be public/client-side; access is controlled by the row-level security
// policies in supabase/schema.sql.
const SUPABASE_URL = 'https://qonhadvvgfegdituotbw.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFvbmhhZHZ2Z2ZlZ2RpdHVvdGJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzNjQxNzIsImV4cCI6MjA5Njk0MDE3Mn0.V49zKuX7wOZ8Ge6vomDTh6z-S-fNMO3fazu9A2CGflg';

const sb = (SUPABASE_URL && SUPABASE_ANON_KEY && typeof window.supabase !== 'undefined')
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

let currentUser = null;
let cloudSyncTimer = null;

// Order matters for the setup form and matches how exercises appear in each workout.
const ORDER = ['squat', 'bench', 'row', 'ohp', 'deadlift'];

const EXERCISES = {
  squat: { name: 'Squat', sets: 5, reps: 5, deloadPct: 0.10 },
  bench: { name: 'Bench Press', sets: 5, reps: 5, deloadPct: 0.10 },
  row: { name: 'Barbell Row', sets: 5, reps: 5, deloadPct: 0.10 },
  ohp: { name: 'Overhead Press', sets: 5, reps: 5, deloadPct: 0.10 },
  deadlift: { name: 'Deadlift', sets: 1, reps: 5, deloadPct: 0.20 },
};

const WORKOUTS = {
  A: ['squat', 'bench', 'row'],
  B: ['squat', 'ohp', 'deadlift'],
};

const UNIT_DEFAULTS = {
  lb: {
    squat: { weight: 45, increment: 5 },
    bench: { weight: 45, increment: 5 },
    row: { weight: 65, increment: 5 },
    ohp: { weight: 45, increment: 5 },
    deadlift: { weight: 95, increment: 10 },
  },
  kg: {
    squat: { weight: 20, increment: 2.5 },
    bench: { weight: 20, increment: 2.5 },
    row: { weight: 30, increment: 2.5 },
    ohp: { weight: 20, increment: 2.5 },
    deadlift: { weight: 40, increment: 5 },
  },
};

// Average hippo weight, for fun "weight lifted" comparisons.
const HIPPO_WEIGHT = { lb: 3000, kg: 1360 };

// Maps "Exercise" column values from the official StrongLifts CSV export to our exercise keys.
const IMPORT_EXERCISE_MAP = {
  Squat: 'squat',
  'Bench Press': 'bench',
  'Barbell Row': 'row',
  'Overhead Press': 'ohp',
  Deadlift: 'deadlift',
};

function defaultState() {
  return {
    unit: 'lb',
    setupComplete: false,
    nextWorkout: 'A',
    exercises: null,
    session: null,
    history: [],
    plateInventory: defaultPlateInventory(),
    customExercises: {},
  };
}

// Custom exercises added by the user are stored in state.customExercises, keyed by a
// generated id, and behave like the built-in exercises (their own weight, progression,
// and history). These helpers let the rest of the app treat built-in and custom
// exercises the same way.
function getExerciseMeta(key) {
  return EXERCISES[key] || (state.customExercises && state.customExercises[key]);
}

function getWorkoutExercises(workoutKey) {
  const custom = Object.keys(state.customExercises || {}).filter(
    (key) => state.customExercises[key].workout === workoutKey
  );
  return [...WORKOUTS[workoutKey], ...custom];
}

// Combines the built-in exercise name map with custom exercise names, so CSV
// import/export can round-trip custom exercises too.
function getImportExerciseMap() {
  const map = { ...IMPORT_EXERCISE_MAP };
  Object.keys(state.customExercises || {}).forEach((key) => {
    map[state.customExercises[key].name] = key;
  });
  return map;
}

// --- IndexedDB persistence ---

const DB_NAME = 'sl5x5_db';
const DB_VERSION = 1;
const STORE_NAME = 'state';
const STATE_KEY = 'main';

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

async function loadState() {
  try {
    const db = await openDb();
    const stored = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(STATE_KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (stored) {
      if (!stored.plateInventory) {
        stored.plateInventory = defaultPlateInventory();
      }
      if (!stored.customExercises) {
        stored.customExercises = {};
      }
      return stored;
    }
  } catch (e) {
    // Fall through to localStorage migration / defaults below.
  }

  // Migrate data saved by older (localStorage-based) versions of this app.
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const migrated = JSON.parse(raw);
      if (!migrated.plateInventory) {
        migrated.plateInventory = defaultPlateInventory();
      }
      if (!migrated.customExercises) {
        migrated.customExercises = {};
      }
      await saveState(migrated);
      localStorage.removeItem(STORAGE_KEY);
      return migrated;
    } catch (e) {
      // Ignore corrupt legacy data and fall back to defaults.
    }
  }

  return defaultState();
}

async function persistToIndexedDb(stateToSave) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(stateToSave, STATE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    // IndexedDB unavailable - data won't persist, but the app keeps working for this session.
  }
}

async function saveState(state) {
  state.updatedAt = new Date().toISOString();
  await persistToIndexedDb(state);
  scheduleCloudSync();
}

// --- Cloud sync ---

function scheduleCloudSync() {
  if (!sb || !currentUser) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => pushStateToCloud(), 1500);
}

async function pushStateToCloud() {
  if (!sb || !currentUser) return;
  try {
    await sb.from('user_state').upsert({
      user_id: currentUser.id,
      state,
      updated_at: state.updatedAt,
    });
  } catch (e) {
    // Offline or request failed - the next save will retry.
  }
}

// Pulls the latest saved state from another device (if newer) or pushes the
// current local state to the cloud (if it's newer or nothing is saved yet).
async function syncStateWithCloud() {
  if (!sb || !currentUser) return;
  try {
    const { data, error } = await sb
      .from('user_state')
      .select('state, updated_at')
      .eq('user_id', currentUser.id)
      .maybeSingle();
    if (error) throw error;

    const localUpdatedAt = state.updatedAt ? new Date(state.updatedAt).getTime() : 0;
    const remoteUpdatedAt = data ? new Date(data.updated_at).getTime() : 0;

    if (data && remoteUpdatedAt > localUpdatedAt) {
      state = data.state;
      await persistToIndexedDb(state);
      refreshAllScreens();
    } else if (!data || localUpdatedAt > remoteUpdatedAt) {
      await pushStateToCloud();
    }
  } catch (e) {
    // Offline or request failed - sync will retry on the next sign-in or save.
  }
}

// Re-renders whichever screen is currently visible, used after pulling a newer
// state from the cloud.
function refreshAllScreens() {
  const active = document.querySelector('.nav-btn.active');
  const screen = active ? active.dataset.screen : 'dashboard';
  if (screen === 'home') {
    renderHomeScreen();
    showScreen('home');
  } else if (screen === 'progress') {
    renderProgressScreen();
    showScreen('progress');
  } else if (screen === 'history') {
    renderHistoryScreen();
    showScreen('history');
  } else if (state.setupComplete) {
    renderDashboard();
    showScreen('dashboard');
  } else {
    renderSetupForm(false);
    showScreen('setup');
  }
}

function updateAccountUI() {
  const section = document.getElementById('cloud-sync-section');
  if (!section) return;
  document.getElementById('account-signed-out').classList.toggle('hidden', !!currentUser);
  document.getElementById('account-signed-in').classList.toggle('hidden', !currentUser);
  if (currentUser) {
    document.getElementById('account-email').textContent = `Signed in as ${currentUser.email}`;
  }
}

function initAuth() {
  const section = document.getElementById('cloud-sync-section');
  if (!sb) {
    if (section) section.classList.add('hidden');
    return;
  }
  if (section) section.classList.remove('hidden');

  document.getElementById('google-signin-btn').addEventListener('click', async () => {
    await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname },
    });
  });

  document.getElementById('sign-out-btn').addEventListener('click', async () => {
    await sb.auth.signOut();
  });

  sb.auth.onAuthStateChange((event, session) => {
    currentUser = session ? session.user : null;
    updateAccountUI();
    if (currentUser) {
      syncStateWithCloud();
    }
  });

  // Re-check the cloud whenever the app comes back to the foreground, so changes
  // made on another device while this one was open/backgrounded get pulled in.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentUser) {
      syncStateWithCloud();
    }
  });
}

// Assumes a standard barbell. Plate inventory (how many of each plate the user owns) is
// configurable in Settings; defaults are generous enough to cover typical working weights.
const BAR_WEIGHT = { lb: 45, kg: 20 };
const PLATES = {
  lb: [45, 35, 25, 10, 5, 2.5, 1.25],
  kg: [20, 15, 10, 5, 2.5, 1.25],
};
const DEFAULT_PLATE_COUNTS = {
  lb: { 45: 8, 35: 4, 25: 4, 10: 8, 5: 8, 2.5: 4, 1.25: 4 },
  kg: { 20: 8, 15: 4, 10: 4, 5: 8, 2.5: 8, 1.25: 4 },
};

function defaultPlateInventory() {
  return {
    lb: { ...DEFAULT_PLATE_COUNTS.lb },
    kg: { ...DEFAULT_PLATE_COUNTS.kg },
  };
}

// Returns the plates needed on each side of the bar to reach the given total weight,
// limited by how many of each plate the user has available (per side).
function calculatePlates(weight, unit) {
  let perSide = (weight - BAR_WEIGHT[unit]) / 2;
  const inventory = (state.plateInventory && state.plateInventory[unit]) || DEFAULT_PLATE_COUNTS[unit];
  const plates = [];
  PLATES[unit].forEach((plate) => {
    const available = Math.floor((inventory[plate] !== undefined ? inventory[plate] : DEFAULT_PLATE_COUNTS[unit][plate]) / 2);
    let used = 0;
    while (perSide + 0.001 >= plate && used < available) {
      plates.push(plate);
      perSide = roundTo2(perSide - plate);
      used += 1;
    }
  });
  return { plates, remaining: perSide };
}

function formatPlates(weight, unit) {
  if (weight <= BAR_WEIGHT[unit]) {
    return `Bar only (${BAR_WEIGHT[unit]} ${unit})`;
  }
  const { plates, remaining } = calculatePlates(weight, unit);
  if (plates.length === 0) {
    return `Bar only (${BAR_WEIGHT[unit]} ${unit})`;
  }
  let text = `${plates.join(' + ')} ${unit} per side`;
  if (remaining > 0.001) {
    text += ` (short ${roundTo2(remaining * 2)} ${unit} - not enough plates)`;
  }
  return text;
}

function roundTo2(value) {
  return Math.round(value * 100) / 100;
}

// Rounds a deloaded weight to the nearest small plate increment.
function roundWeight(value, unit) {
  const step = unit === 'kg' ? 1.25 : 2.5;
  return roundTo2(Math.round(value / step) * step);
}

let state = defaultState();

function showScreen(name) {
  const isSetup = name === 'setup';
  document.getElementById('setup-screen').classList.toggle('hidden', name !== 'setup' && name !== 'settings');
  document.getElementById('dashboard-screen').classList.toggle('hidden', name !== 'dashboard');
  document.getElementById('home-screen').classList.toggle('hidden', name !== 'home');
  document.getElementById('progress-screen').classList.toggle('hidden', name !== 'progress');
  document.getElementById('history-screen').classList.toggle('hidden', name !== 'history');
  document.getElementById('bottom-nav').classList.toggle('hidden', isSetup);
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.screen === name);
  });
  if (name === 'setup' || name === 'settings') {
    showSettingsTab('weights');
  }
}

function showSettingsTab(tab) {
  document.querySelectorAll('.settings-tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.settings-tab-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.tab !== tab);
  });
  if (tab === 'exercises') {
    renderCustomExercisesPanel();
  }
}

// --- Custom exercises ---

function renderCustomExercisesPanel() {
  document.getElementById('custom-ex-weight-label').textContent = `Starting weight (${state.unit})`;
  document.getElementById('custom-ex-increment-label').textContent = `Weight increase on success (${state.unit})`;
  renderCustomExerciseList();
}

function renderCustomExerciseList() {
  const container = document.getElementById('custom-exercise-list');
  container.innerHTML = '';
  const keys = Object.keys(state.customExercises || {});

  if (keys.length === 0) {
    container.innerHTML = '<p class="hint">No custom exercises yet.</p>';
    return;
  }

  keys.forEach((key) => {
    const meta = state.customExercises[key];
    const ex = state.exercises && state.exercises[key];
    const weightText = ex ? `${ex.weight} ${state.unit}` : '';
    const div = document.createElement('div');
    div.className = 'custom-exercise-item';
    div.innerHTML = `
      <span>${meta.name} (Workout ${meta.workout}) - ${weightText}</span>
      <button class="remove-custom-ex-btn" data-key="${key}" type="button">Remove</button>
    `;
    container.appendChild(div);
  });
}

document.getElementById('add-custom-exercise-btn').addEventListener('click', () => {
  const name = document.getElementById('custom-ex-name').value.trim();
  if (!name) {
    alert('Please enter a name for the exercise.');
    return;
  }

  const workout = document.getElementById('custom-ex-workout').value;
  const sets = Math.min(Math.max(parseInt(document.getElementById('custom-ex-sets').value, 10) || 1, 1), 5);
  const reps = Math.max(parseInt(document.getElementById('custom-ex-reps').value, 10) || 1, 1);
  const weight = parseFloat(document.getElementById('custom-ex-weight').value) || 0;
  const increment = parseFloat(document.getElementById('custom-ex-increment').value) || 0;
  const deloadPct = Math.max(parseFloat(document.getElementById('custom-ex-deload').value) || 0, 0) / 100;

  const key = `custom_${Date.now()}`;
  state.customExercises = state.customExercises || {};
  state.customExercises[key] = { name, sets, reps, deloadPct, workout };

  state.exercises = state.exercises || {};
  state.exercises[key] = { weight, increment, fails: 0 };

  // Add it to the in-progress session too, if it's for the workout currently being done.
  if (state.session && state.session.workout === workout) {
    state.session.sets[key] = Array(sets).fill('pending');
  }

  saveState(state);

  document.getElementById('custom-ex-name').value = '';
  document.getElementById('custom-ex-sets').value = '5';
  document.getElementById('custom-ex-reps').value = '5';
  document.getElementById('custom-ex-weight').value = '45';
  document.getElementById('custom-ex-increment').value = '5';
  document.getElementById('custom-ex-deload').value = '10';

  renderCustomExerciseList();
});

document.getElementById('custom-exercise-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.remove-custom-ex-btn');
  if (!btn) return;

  const key = btn.dataset.key;
  const meta = state.customExercises[key];
  if (!confirm(`Remove "${meta.name}"? Its past history will be kept, but you won't be able to log it anymore.`)) {
    return;
  }

  delete state.customExercises[key];
  if (state.exercises) delete state.exercises[key];
  if (state.session && state.session.sets) delete state.session.sets[key];

  saveState(state);
  renderCustomExerciseList();
});

function renderSetupForm(isEdit) {
  const unitRadios = document.querySelectorAll('input[name="unit"]');
  const selectedUnit = state.unit || 'lb';
  unitRadios.forEach((r) => {
    r.checked = r.value === selectedUnit;
  });

  const buildRows = (unit) => {
    const container = document.getElementById('setup-exercises');
    container.innerHTML = '';
    ORDER.forEach((key) => {
      const ex = EXERCISES[key];
      const useExisting = isEdit && state.exercises && state.unit === unit;
      const current = useExisting ? state.exercises[key].weight : UNIT_DEFAULTS[unit][key].weight;
      const div = document.createElement('div');
      div.className = 'field';
      div.innerHTML = `
        <label for="weight-${key}">${ex.name} starting weight (${unit})</label>
        <input type="number" id="weight-${key}" min="0" step="${unit === 'kg' ? 1.25 : 2.5}" value="${current}">
      `;
      container.appendChild(div);
    });
  };

  const plateId = (plate) => `plate-${String(plate).replace('.', '_')}`;

  const buildPlateRows = (unit) => {
    const container = document.getElementById('setup-plates');
    container.innerHTML = '';
    const inventory = (state.plateInventory && state.plateInventory[unit]) || DEFAULT_PLATE_COUNTS[unit];
    PLATES[unit].forEach((plate) => {
      const current = inventory[plate] !== undefined ? inventory[plate] : DEFAULT_PLATE_COUNTS[unit][plate];
      const div = document.createElement('div');
      div.className = 'field';
      div.innerHTML = `
        <label for="${plateId(plate)}">${plate} ${unit} plates (total owned)</label>
        <input type="number" id="${plateId(plate)}" min="0" step="2" value="${current}">
      `;
      container.appendChild(div);
    });
  };

  buildRows(selectedUnit);
  buildPlateRows(selectedUnit);

  unitRadios.forEach((r) => {
    r.onchange = () => {
      buildRows(r.value);
      buildPlateRows(r.value);
    };
  });

  document.getElementById('setup-title').textContent = isEdit ? 'Settings' : 'Set Up Your Starting Weights';
  document.querySelector('#setup-form button[type="submit"]').textContent = isEdit ? 'Save Changes' : 'Save & Start';
}

function newSessionFor(workoutKey) {
  const sets = {};
  getWorkoutExercises(workoutKey).forEach((key) => {
    sets[key] = Array(getExerciseMeta(key).sets).fill('pending');
  });
  const session = { workout: workoutKey, sets };
  if (state.lastBodyWeight !== undefined) {
    session.bodyWeight = state.lastBodyWeight;
  }
  return session;
}

function ensureSession() {
  if (!state.session) {
    state.session = newSessionFor(state.nextWorkout);
    saveState(state);
  }
}

function hasSessionProgress() {
  if (!state.session) return false;
  return Object.values(state.session.sets).some((sets) => sets.some((s) => s !== 'pending'));
}

function selectWorkout(workoutKey) {
  if (state.session && state.session.workout === workoutKey) return;

  if (hasSessionProgress()) {
    const currentWorkout = state.session.workout;
    if (!confirm(`Switching to Workout ${workoutKey} will reset your progress for Workout ${currentWorkout}. Continue?`)) {
      return;
    }
  }

  state.session = newSessionFor(workoutKey);
  saveState(state);
  renderHomeScreen();
}

function renderHomeScreen() {
  if (!state.exercises) return;
  ensureSession();

  document.getElementById('workout-title').textContent = `Workout ${state.session.workout}`;
  document.getElementById('workout-date').textContent = new Date().toLocaleDateString();

  document.querySelectorAll('.workout-select-btn').forEach((btn) => {
    const workoutKey = btn.dataset.workout;
    btn.classList.toggle('active', state.session.workout === workoutKey);
    btn.querySelector('.badge').classList.toggle('hidden', state.nextWorkout !== workoutKey);
  });

  const list = document.getElementById('exercise-list');
  list.innerHTML = '';
  getWorkoutExercises(state.session.workout).forEach((key) => {
    const meta = getExerciseMeta(key);
    const ex = state.exercises[key];
    const setsHtml = state.session.sets[key]
      .map((status, i) => {
        const display = status === 'pending' ? meta.reps : status;
        const cls = status === 'pending' ? '' : status === meta.reps ? 'done' : 'failed';
        return `<button class="set-btn ${cls}" data-exercise="${key}" data-set="${i}">${display}</button>`;
      })
      .join('');

    const card = document.createElement('div');
    card.className = 'exercise-card';
    card.innerHTML = `
      <div class="exercise-header">
        <h3>${meta.name}</h3>
        <span class="weight">${ex.weight} ${state.unit}</span>
      </div>
      <p class="plates">${formatPlates(ex.weight, state.unit)}</p>
      <div class="sets">${setsHtml}</div>
    `;
    list.appendChild(card);
  });

  document.getElementById('body-weight-label').textContent = `Body Weight (${state.unit})`;
  document.getElementById('body-weight-input').value =
    state.session.bodyWeight !== undefined ? state.session.bodyWeight : '';
}

function finishWorkout() {
  const workoutKey = state.session.workout;
  const lines = [];
  const results = {};
  let totalWeight = 0;

  getWorkoutExercises(workoutKey).forEach((key) => {
    const sets = state.session.sets[key];
    const meta = getExerciseMeta(key);
    const allDone = sets.every((s) => s === meta.reps);
    const ex = state.exercises[key];

    sets.forEach((s) => {
      if (typeof s === 'number') {
        totalWeight += ex.weight * s;
      }
    });

    if (allDone) {
      ex.weight = roundTo2(ex.weight + ex.increment);
      ex.fails = 0;
      results[key] = { outcome: 'success', weight: ex.weight, fails: 0, name: meta.name };
      lines.push(`${meta.name}: nailed it! Next time: ${ex.weight} ${state.unit}`);
    } else {
      ex.fails = (ex.fails || 0) + 1;
      if (ex.fails >= 3) {
        ex.weight = roundWeight(ex.weight * (1 - meta.deloadPct), state.unit);
        ex.fails = 0;
        results[key] = { outcome: 'deload', weight: ex.weight, fails: 0, name: meta.name };
        lines.push(`${meta.name}: missed 3rd time - deloaded to ${ex.weight} ${state.unit}`);
      } else {
        results[key] = { outcome: 'fail', weight: ex.weight, fails: ex.fails, name: meta.name };
        lines.push(`${meta.name}: missed a set (${ex.fails}/3). Weight stays ${ex.weight} ${state.unit}`);
      }
    }
  });

  const entry = { date: new Date().toISOString(), workout: workoutKey, results };
  const bodyWeight = parseFloat(state.session.bodyWeight);
  if (Number.isFinite(bodyWeight)) {
    entry.bodyWeight = bodyWeight;
    state.lastBodyWeight = bodyWeight;
  }
  state.history.push(entry);
  const workoutNumber = state.history.length;

  state.nextWorkout = workoutKey === 'A' ? 'B' : 'A';
  state.session = null;
  saveState(state);

  return {
    lines,
    nextWorkout: state.nextWorkout,
    workoutNumber,
    totalWeight: roundTo2(totalWeight),
    hippos: totalWeight / HIPPO_WEIGHT[state.unit],
    unit: state.unit,
  };
}

function showCongratsModal(result) {
  const lineItems = result.lines.map((line) => `<li>${line}</li>`).join('');

  document.getElementById('congrats-body').innerHTML = `
    <p class="congrats-stat">Workout #${result.workoutNumber} complete!</p>
    <p class="congrats-stat">Total weight lifted: ${result.totalWeight} ${result.unit}</p>
    <p class="congrats-stat">That's about ${result.hippos.toFixed(2)} average hippos! 🦛</p>
    <ul class="congrats-details">${lineItems}</ul>
    <p>Next up: Workout ${result.nextWorkout}</p>
  `;
  document.getElementById('congrats-modal').classList.remove('hidden');
}

document.getElementById('congrats-close-btn').addEventListener('click', () => {
  document.getElementById('congrats-modal').classList.add('hidden');
});

const CHART_COLORS = {
  squat: '#c9a84c',
  bench: '#e8c873',
  row: '#d98c2b',
  ohp: '#8a6b32',
  deadlift: '#c0392b',
  bodyWeight: '#a8957a',
};

// Colors for custom exercises, assigned in the order they were added.
const CUSTOM_CHART_COLORS = ['#e0b84a', '#b5862f', '#d4a373', '#9c7a3a', '#cf6b4a', '#a3753c', '#e6c07b', '#7a5c2e'];

// Theme Chart.js for the dark gladiator UI so axis labels, grid lines, and
// legends remain legible against the dark backgrounds.
if (typeof Chart !== 'undefined') {
  Chart.defaults.color = '#a8957a';
  Chart.defaults.borderColor = 'rgba(201, 168, 76, 0.15)';
  Chart.defaults.font.family = "'Oswald', sans-serif";
}

const OUTCOME_LABELS = {
  success: 'Success',
  fail: 'Missed',
  deload: 'Deload',
};

let progressChart = null;
let frequencyChart = null;
let exerciseDetailChart = null;
let progressRange = 'lifetime';
let visibleExercises = new Set(['squat']);
let showTrendLines = false;

function getAllExerciseKeys() {
  return [...ORDER, ...Object.keys(state.customExercises || {})];
}

// History only stores the weight to use *next* time for successes, and the new
// (already-deloaded) weight for deloads. This recovers the weight actually used
// in a given session - same logic as the CSV export.
function getWeightUsed(entry, key) {
  const r = entry.results[key];
  if (!r) return null;
  if (entry.workout === 'deload') return r.weight;

  const meta = getExerciseMeta(key) || { deloadPct: 0.10 };
  const increment = (state.exercises && state.exercises[key] && state.exercises[key].increment) || 0;

  if (r.outcome === 'success') return roundTo2(r.weight - increment);
  if (r.outcome === 'deload') return roundTo2(r.weight / (1 - meta.deloadPct));
  return r.weight;
}

function formatShortDate(dateStr) {
  return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatBigNumber(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

// All-time PR (heaviest weight successfully completed) per exercise, with the date it was set.
function computeAllTimePRs() {
  const history = getValidHistory();
  const prs = {};
  history.forEach((entry) => {
    Object.keys(entry.results).forEach((key) => {
      const r = entry.results[key];
      if (r.outcome !== 'success') return;
      const weight = getWeightUsed(entry, key);
      if (!prs[key] || weight > prs[key].weight) {
        prs[key] = { weight, date: entry.date };
      }
    });
  });
  return prs;
}

// A streak is a run of A/B workouts spaced no more than 4 days apart (StrongLifts
// is typically done 3x/week). The current streak resets to 0 if it's been more
// than 4 days since the last workout.
const STREAK_GAP_DAYS = 4;

function computeStreaks() {
  const history = getValidHistory().filter((entry) => entry.workout === 'A' || entry.workout === 'B');
  if (history.length === 0) return { current: 0, longest: 0 };

  let longest = 1;
  let run = 1;
  for (let i = 1; i < history.length; i++) {
    const gapDays = (new Date(history[i].date) - new Date(history[i - 1].date)) / (1000 * 60 * 60 * 24);
    run = gapDays <= STREAK_GAP_DAYS ? run + 1 : 1;
    longest = Math.max(longest, run);
  }

  const daysSinceLast = (Date.now() - new Date(history[history.length - 1].date).getTime()) / (1000 * 60 * 60 * 24);
  const current = daysSinceLast <= STREAK_GAP_DAYS ? run : 0;

  return { current, longest };
}

// Estimated total weight lifted all-time, using full sets x reps for successful
// sessions and one rep short of that for missed/deload sessions.
function computeTotalVolume() {
  let total = 0;
  getValidHistory().forEach((entry) => {
    if (entry.workout === 'deload') return;
    Object.keys(entry.results).forEach((key) => {
      const r = entry.results[key];
      const meta = getExerciseMeta(key);
      if (!meta) return;
      const weight = getWeightUsed(entry, key);
      const reps = r.outcome === 'success' ? meta.reps : Math.max(meta.reps - 1, 0);
      total += weight * meta.sets * reps;
    });
  });
  return roundTo2(total);
}

function computeWorkoutCount() {
  return getValidHistory().filter((entry) => entry.workout === 'A' || entry.workout === 'B').length;
}

// Per-exercise breakdown: full weight history, PR timeline, deload count, and
// progression rate (average weight gain per month) for the detail view.
function computeExerciseDetail(key) {
  const history = getValidHistory().filter((entry) => entry.results[key]);
  const meta = getExerciseMeta(key);

  const points = history.map((entry) => ({
    date: entry.date,
    weight: getWeightUsed(entry, key),
    outcome: entry.results[key].outcome,
  }));

  const prTimeline = [];
  let maxWeight = -Infinity;
  history.forEach((entry) => {
    const r = entry.results[key];
    if (r.outcome !== 'success') return;
    const weight = getWeightUsed(entry, key);
    if (weight > maxWeight) {
      maxWeight = weight;
      prTimeline.push({ date: entry.date, weight });
    }
  });

  const deloadCount = history.filter((entry) => entry.results[key].outcome === 'deload').length;

  let progressionRate = 0;
  if (points.length >= 2) {
    const first = points[0];
    const last = points[points.length - 1];
    const months = Math.max((new Date(last.date) - new Date(first.date)) / (1000 * 60 * 60 * 24 * 30.44), 1 / 30.44);
    progressionRate = (last.weight - first.weight) / months;
  }

  return { meta, points, prTimeline, deloadCount, progressionRate };
}

// Simple linear regression over the visible data points (x = index, y = weight),
// used to draw an optional trend line per exercise.
function computeTrendLineData(data) {
  const points = data
    .map((y, x) => ({ x, y }))
    .filter((p) => p.y !== null && p.y !== undefined);
  if (points.length < 2) return null;

  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return data.map((_, x) => slope * x + intercept);
}

function tileHtml(icon, value, label) {
  return `
    <div class="stat-tile">
      <span class="stat-icon">${icon}</span>
      <span class="stat-value">${value}</span>
      <span class="stat-label">${label}</span>
    </div>
  `;
}

// Filters chart history down to the selected time range.
function filterHistoryByRange(history) {
  if (progressRange === 'lifetime') return history;
  const cutoff = new Date();
  if (progressRange === 'month') cutoff.setMonth(cutoff.getMonth() - 1);
  if (progressRange === 'year') cutoff.setFullYear(cutoff.getFullYear() - 1);
  return history.filter((entry) => new Date(entry.date) >= cutoff);
}

// Older versions of the app stored a different history format; skip those entries.
function getValidHistory() {
  return state.history.filter((entry) => entry.results);
}

function renderHistoryScreen() {
  const history = getValidHistory();
  const historyContainer = document.getElementById('history-list');
  historyContainer.innerHTML = '';

  if (history.length === 0) {
    historyContainer.innerHTML = '<p class="hint">No workouts logged yet. Finish a workout to see your history here.</p>';
    return;
  }

  [...history].reverse().forEach((entry) => {
    const date = new Date(entry.date).toLocaleDateString();
    const rows = Object.keys(entry.results)
      .map((key) => {
        const r = entry.results[key];
        const meta = getExerciseMeta(key);
        const name = (meta && meta.name) || r.name || key;
        const label = r.outcome === 'fail' ? `${OUTCOME_LABELS.fail} (${r.fails}/3)` : OUTCOME_LABELS[r.outcome];
        return `
          <div class="history-exercise">
            <span>${name}</span>
            <span class="tag ${r.outcome}">${label}</span>
            <span>${r.weight} ${state.unit}</span>
          </div>
        `;
      })
      .join('');

    const bodyWeightRow = entry.bodyWeight !== undefined
      ? `
        <div class="history-exercise history-row-2col">
          <span>Body Weight</span>
          <span>${entry.bodyWeight} ${state.unit}</span>
        </div>
      `
      : '';

    const title = entry.workout === 'deload' ? 'Deload Day' : `Workout ${entry.workout}`;

    const card = document.createElement('div');
    card.className = 'history-card';
    card.innerHTML = `
      <div class="history-card-header">
        <h4>${date} - ${title}</h4>
        <button class="history-delete-btn" type="button" aria-label="Delete this workout">Delete</button>
      </div>
      ${rows}${bodyWeightRow}
    `;
    card.querySelector('.history-delete-btn').addEventListener('click', () => {
      if (!confirm(`Delete the ${date} - ${title} workout? This can't be undone.`)) return;
      const index = state.history.indexOf(entry);
      if (index !== -1) {
        state.history.splice(index, 1);
        saveState(state);
      }
      renderHistoryScreen();
    });
    historyContainer.appendChild(card);
  });
}

function renderProgressScreen() {
  const history = getValidHistory();

  renderProgressStats();

  const chartCanvas = document.getElementById('progress-chart');
  const emptyMsg = document.getElementById('chart-empty-msg');
  if (typeof Chart === 'undefined') {
    chartCanvas.classList.add('hidden');
    emptyMsg.classList.add('hidden');
    return;
  }

  if (progressChart) {
    progressChart.destroy();
    progressChart = null;
  }

  const chartHistory = filterHistoryByRange(history);

  const customKeys = Object.keys(state.customExercises || {});
  const chartKeys = [...ORDER, ...customKeys, 'bodyWeight'];
  renderExercisePills(chartKeys, customKeys);

  if (chartHistory.length === 0) {
    chartCanvas.classList.add('hidden');
    emptyMsg.classList.remove('hidden');
    return;
  }
  chartCanvas.classList.remove('hidden');
  emptyMsg.classList.add('hidden');

  const labels = chartHistory.map((entry) => formatShortDate(entry.date));
  const datasets = chartKeys.map((key) => {
    const isBodyWeight = key === 'bodyWeight';
    const customIndex = customKeys.indexOf(key);
    const color = isBodyWeight
      ? CHART_COLORS.bodyWeight
      : CHART_COLORS[key] || CUSTOM_CHART_COLORS[customIndex % CUSTOM_CHART_COLORS.length];
    return {
      label: isBodyWeight ? `Body Weight (${state.unit})` : getExerciseMeta(key).name,
      data: chartHistory.map((entry) => {
        if (isBodyWeight) return entry.bodyWeight !== undefined ? entry.bodyWeight : null;
        return entry.results[key] ? getWeightUsed(entry, key) : null;
      }),
      borderColor: color,
      backgroundColor: color,
      spanGaps: true,
      tension: 0.2,
      hidden: !visibleExercises.has(key),
    };
  });

  if (showTrendLines) {
    chartKeys.forEach((key, index) => {
      if (!visibleExercises.has(key)) return;
      const trendData = computeTrendLineData(datasets[index].data);
      if (!trendData) return;
      datasets.push({
        label: `${datasets[index].label} Trend`,
        data: trendData,
        borderColor: datasets[index].borderColor,
        backgroundColor: 'transparent',
        borderDash: [6, 6],
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 0,
        tension: 0,
      });
    });
  }

  progressChart = new Chart(chartCanvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { title: { display: true, text: `Weight (${state.unit})` } },
        x: {
          title: { display: true, text: 'Date' },
          ticks: { maxRotation: 45, minRotation: 45, autoSkip: true, maxTicksLimit: 8 },
        },
      },
      plugins: {
        legend: { display: false },
        zoom: {
          pan: { enabled: true, mode: 'x' },
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            mode: 'x',
          },
          limits: { x: { minRange: 2 } },
        },
      },
      onClick: (evt) => {
        const points = progressChart.getElementsAtEventForMode(evt, 'nearest', { intersect: false, axis: 'x' }, true);
        if (!points.length) return;
        const { datasetIndex, index } = points[0];
        if (datasetIndex >= chartKeys.length) return; // trend line dataset
        const entry = chartHistory[index];
        if (entry) openDataPointModal(entry);
      },
    },
  });
}

// Renders the achievement-tile stats grid: streaks, total volume, workout
// count, and an all-time PR tile per exercise.
function renderProgressStats() {
  const grid = document.getElementById('stats-grid');

  const prs = computeAllTimePRs();
  const streaks = computeStreaks();
  const totalVolume = computeTotalVolume();
  const workoutCount = computeWorkoutCount();

  const tiles = [
    tileHtml('🔥', `${streaks.current}`, 'Current Streak'),
    tileHtml('🏆', `${streaks.longest}`, 'Longest Streak'),
    tileHtml('🏋', `${formatBigNumber(totalVolume)}`, `${state.unit} Lifted (All-Time)`),
    tileHtml('⚔️', `${workoutCount}`, 'Workouts Completed'),
  ];

  getAllExerciseKeys().forEach((key) => {
    const meta = getExerciseMeta(key);
    const pr = prs[key];
    if (!meta || !pr) return;
    tiles.push(tileHtml('👑', `${pr.weight} ${state.unit}`, `${meta.name} PR - ${new Date(pr.date).toLocaleDateString()}`));
  });

  grid.innerHTML = tiles.join('');
}

// Renders the large, touch-friendly exercise toggle pills below the chart.
// Tapping the pill toggles that line's visibility; the info button opens the
// exercise's detail view.
function renderExercisePills(chartKeys, customKeys) {
  const container = document.getElementById('exercise-pills');
  container.innerHTML = '';

  chartKeys.forEach((key) => {
    const isBodyWeight = key === 'bodyWeight';
    const customIndex = customKeys.indexOf(key);
    const color = isBodyWeight
      ? CHART_COLORS.bodyWeight
      : CHART_COLORS[key] || CUSTOM_CHART_COLORS[customIndex % CUSTOM_CHART_COLORS.length];
    const name = isBodyWeight ? 'Body Weight' : getExerciseMeta(key).name;
    const active = visibleExercises.has(key);

    const pill = document.createElement('div');
    pill.className = `exercise-pill ${active ? 'active' : ''}`;
    pill.style.setProperty('--pill-color', color);
    pill.innerHTML = `
      <button class="pill-toggle" data-key="${key}" type="button">${name}</button>
      ${isBodyWeight ? '' : `<button class="pill-info" data-key="${key}" type="button" aria-label="${name} details">ⓘ</button>`}
    `;
    container.appendChild(pill);
  });
}

// Tap-a-data-point popup: shows the full results for that session.
function openDataPointModal(entry) {
  const date = new Date(entry.date).toLocaleDateString();
  const title = entry.workout === 'deload' ? 'Deload Day' : `Workout ${entry.workout}`;

  const rows = Object.keys(entry.results)
    .map((key) => {
      const r = entry.results[key];
      const meta = getExerciseMeta(key);
      const name = (meta && meta.name) || r.name || key;
      const label = r.outcome === 'fail' ? `${OUTCOME_LABELS.fail} (${r.fails}/3)` : OUTCOME_LABELS[r.outcome];
      const weightUsed = getWeightUsed(entry, key);
      return `
        <div class="history-exercise">
          <span>${name}</span>
          <span class="tag ${r.outcome}">${label}</span>
          <span>${weightUsed} ${state.unit}</span>
        </div>
      `;
    })
    .join('');

  const bodyWeightRow = entry.bodyWeight !== undefined
    ? `
      <div class="history-exercise">
        <span>Body Weight</span>
        <span>${entry.bodyWeight} ${state.unit}</span>
      </div>
    `
    : '';

  document.getElementById('datapoint-title').textContent = `${date} - ${title}`;
  document.getElementById('datapoint-body').innerHTML = rows + bodyWeightRow;
  document.getElementById('datapoint-modal').classList.remove('hidden');
}

// Exercise breakdown detail view: full weight history chart, PR timeline,
// deload count, and progression rate.
function openExerciseDetailModal(key) {
  const detail = computeExerciseDetail(key);
  const meta = detail.meta;

  document.getElementById('exercise-detail-title').textContent = meta.name;

  const rateValue = detail.progressionRate >= 0
    ? `+${detail.progressionRate.toFixed(2)}`
    : detail.progressionRate.toFixed(2);

  document.getElementById('exercise-detail-stats').innerHTML = [
    tileHtml('📈', `${rateValue} ${state.unit}`, 'Progression / Month'),
    tileHtml('⚠️', `${detail.deloadCount}`, 'Times Deloaded'),
  ].join('');

  if (exerciseDetailChart) {
    exerciseDetailChart.destroy();
    exerciseDetailChart = null;
  }

  const canvas = document.getElementById('exercise-detail-chart');
  if (typeof Chart !== 'undefined' && detail.points.length > 0) {
    canvas.classList.remove('hidden');
    const customIndex = Object.keys(state.customExercises || {}).indexOf(key);
    const color = CHART_COLORS[key] || CUSTOM_CHART_COLORS[customIndex % CUSTOM_CHART_COLORS.length];

    exerciseDetailChart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: detail.points.map((p) => formatShortDate(p.date)),
        datasets: [{
          label: meta.name,
          data: detail.points.map((p) => p.weight),
          borderColor: color,
          backgroundColor: color,
          spanGaps: true,
          tension: 0.2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { ticks: { maxRotation: 45, minRotation: 45, autoSkip: true, maxTicksLimit: 6 } },
          y: { title: { display: true, text: `Weight (${state.unit})` } },
        },
        plugins: { legend: { display: false } },
      },
    });
  } else {
    canvas.classList.add('hidden');
  }

  const prList = document.getElementById('exercise-detail-pr-list');
  if (detail.prTimeline.length === 0) {
    prList.innerHTML = '<p class="hint">No PRs recorded yet.</p>';
  } else {
    prList.innerHTML = [...detail.prTimeline].reverse().map((pr) => `
      <div class="history-exercise history-row-2col">
        <span>${new Date(pr.date).toLocaleDateString()}</span>
        <span class="weight">${pr.weight} ${state.unit}</span>
      </div>
    `).join('');
  }

  document.getElementById('exercise-detail-modal').classList.remove('hidden');
}

// --- Dashboard ---

function renderDashboard() {
  renderLastWorkoutCard();
  renderFrequencyChart();
  renderWeightTrends();
  renderDeloadCard();
}

function renderLastWorkoutCard() {
  const history = getValidHistory();
  const container = document.getElementById('last-workout-body');

  if (history.length === 0) {
    container.innerHTML = '<p class="hint">No workouts logged yet. Tap "Start Workout" to log your first session!</p>';
    return;
  }

  const last = history[history.length - 1];
  const date = new Date(last.date);
  const daysAgo = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
  const dayLabel = daysAgo <= 0 ? 'Today' : daysAgo === 1 ? '1 day ago' : `${daysAgo} days ago`;
  const title = last.workout === 'deload' ? 'Deload Day' : `Workout ${last.workout}`;

  const rows = Object.keys(last.results)
    .map((key) => {
      const r = last.results[key];
      const meta = getExerciseMeta(key);
      const name = (meta && meta.name) || r.name || key;
      const label = r.outcome === 'fail' ? `${OUTCOME_LABELS.fail} (${r.fails}/3)` : OUTCOME_LABELS[r.outcome];
      return `
        <div class="history-exercise">
          <span>${name}</span>
          <span class="tag ${r.outcome}">${label}</span>
          <span>${r.weight} ${state.unit}</span>
        </div>
      `;
    })
    .join('');

  container.innerHTML = `
    <p class="congrats-stat">${title} - ${date.toLocaleDateString()} (${dayLabel})</p>
    ${rows}
  `;
}

// Buckets workout history into 12 weekly counts (Sunday-start weeks) for the
// last ~3 months and renders them as a bar chart.
function renderFrequencyChart() {
  const canvas = document.getElementById('frequency-chart');
  const emptyMsg = document.getElementById('frequency-empty-msg');

  if (typeof Chart === 'undefined') {
    canvas.classList.add('hidden');
    emptyMsg.classList.add('hidden');
    return;
  }

  if (frequencyChart) {
    frequencyChart.destroy();
    frequencyChart = null;
  }

  const history = getValidHistory().filter((entry) => entry.workout === 'A' || entry.workout === 'B');

  if (history.length === 0) {
    canvas.classList.add('hidden');
    emptyMsg.classList.remove('hidden');
    return;
  }
  canvas.classList.remove('hidden');
  emptyMsg.classList.add('hidden');

  const WEEKS = 12;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const weekBuckets = [];
  for (let i = WEEKS - 1; i >= 0; i--) {
    const start = new Date(today);
    start.setDate(start.getDate() - start.getDay() - i * 7);
    weekBuckets.push({ start, count: 0 });
  }

  history.forEach((entry) => {
    const date = new Date(entry.date);
    for (let i = weekBuckets.length - 1; i >= 0; i--) {
      if (date >= weekBuckets[i].start) {
        weekBuckets[i].count += 1;
        break;
      }
    }
  });

  const labels = weekBuckets.map((b) => b.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  const data = weekBuckets.map((b) => b.count);

  frequencyChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Workouts',
        data,
        backgroundColor: '#c9a84c',
      }],
    },
    options: {
      responsive: true,
      scales: {
        y: { beginAtZero: true, ticks: { stepSize: 1 } },
        x: { title: { display: true, text: 'Week of' } },
      },
      plugins: {
        legend: { display: false },
      },
    },
  });
}

// Shows whether each exercise's working weight has gone up, stayed flat,
// stalled (failed but not yet deloaded), or been deloaded over the last 4 weeks.
function renderWeightTrends() {
  const container = document.getElementById('weight-trends-list');
  container.innerHTML = '';

  const history = getValidHistory();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 28);

  const keys = [...ORDER, ...Object.keys(state.customExercises || {})];

  keys.forEach((key) => {
    const meta = getExerciseMeta(key);
    if (!meta) return;

    const recent = history.filter((entry) => new Date(entry.date) >= cutoff && entry.results[key]);

    let icon = '➡️';
    let label = 'No recent data';
    let cls = 'trend-flat';

    if (recent.length > 0) {
      const first = recent[0].results[key];
      const last = recent[recent.length - 1].results[key];

      if (last.weight > first.weight) {
        icon = '⬆️';
        label = 'Trending up';
        cls = 'trend-up';
      } else if (last.weight < first.weight) {
        icon = '⬇️';
        label = 'Deloaded';
        cls = 'trend-down';
      } else if (recent.some((entry) => entry.results[key].outcome === 'fail')) {
        icon = '⏸️';
        label = 'Stalled';
        cls = 'trend-stalled';
      } else {
        icon = '➡️';
        label = 'Flat';
        cls = 'trend-flat';
      }
    }

    const div = document.createElement('div');
    div.className = 'trend-item';
    div.innerHTML = `
      <span class="trend-name">${meta.name}</span>
      <span class="trend-indicator ${cls}">${icon} ${label}</span>
    `;
    container.appendChild(div);
  });
}

// Shows a deload card if the user hasn't logged a workout in 10+ days, with a
// slider to preview and apply a deload across all exercises.
function renderDeloadCard() {
  const card = document.getElementById('deload-card');
  const history = getValidHistory();

  if (history.length === 0) {
    card.classList.add('hidden');
    return;
  }

  const last = history[history.length - 1];
  const daysAgo = Math.floor((Date.now() - new Date(last.date).getTime()) / (1000 * 60 * 60 * 24));

  if (daysAgo < 10) {
    card.classList.add('hidden');
    return;
  }

  card.classList.remove('hidden');
  document.getElementById('deload-message').textContent =
    `It's been ${daysAgo} days since your last workout. Consider easing back in with a deload.`;
  updateDeloadPreview();
}

function updateDeloadPreview() {
  const pct = parseInt(document.getElementById('deload-slider').value, 10);
  document.getElementById('deload-pct-display').textContent = `${pct}%`;

  const preview = document.getElementById('deload-preview');
  preview.innerHTML = '';

  [...ORDER, ...Object.keys(state.customExercises || {})].forEach((key) => {
    const meta = getExerciseMeta(key);
    const ex = state.exercises && state.exercises[key];
    if (!meta || !ex) return;

    const newWeight = roundWeight(ex.weight * (1 - pct / 100), state.unit);
    const row = document.createElement('div');
    row.className = 'history-exercise history-row-2col';
    row.innerHTML = `
      <span>${meta.name}</span>
      <span>${ex.weight} ${state.unit} → ${newWeight} ${state.unit}</span>
    `;
    preview.appendChild(row);
  });
}

// --- StrongLifts CSV import ---

// Splits a CSV export into rows of { headerName: value }. Every field in the
// StrongLifts export is double-quoted, so each row is parsed by pulling out
// the quoted segments in order and pairing them with the trimmed headers.
// Builds a CSV of the workout history using the same column layout the StrongLifts
// CSV import expects, so an exported file can be re-imported into this app.
function buildExportCsv() {
  const header = [
    'Date (yyyy/mm/dd)',
    'Workout',
    'Workout Name',
    'Body Weight (LBS)',
    'Exercise',
    'Set 1 (Reps)', 'Set 1 (LBS)',
    'Set 2 (Reps)', 'Set 2 (LBS)',
    'Set 3 (Reps)', 'Set 3 (LBS)',
    'Set 4 (Reps)', 'Set 4 (LBS)',
    'Set 5 (Reps)', 'Set 5 (LBS)',
  ];
  const rows = [header];

  getValidHistory().forEach((entry, index) => {
    const date = new Date(entry.date).toISOString().slice(0, 10).replace(/-/g, '/');
    const sessionNumber = index + 1;
    const workoutName = entry.workout === 'deload' ? 'Deload Day' : `Workout ${entry.workout}`;
    const bodyWeight = entry.bodyWeight !== undefined ? entry.bodyWeight : '';

    Object.keys(entry.results).forEach((key) => {
      const r = entry.results[key];
      if (!r) return;
      const meta = getExerciseMeta(key) || { name: r.name || key, sets: 5, reps: 5, deloadPct: 0.10 };
      const increment = (state.exercises[key] && state.exercises[key].increment) || 0;

      // Estimate the weight actually used in this session, since the history only
      // stores the weight to use *next* time for successes and deloads. Deload Day
      // entries are special - r.weight is the new (already-deloaded) weight itself.
      let weightUsed;
      let repsHit;
      if (entry.workout === 'deload') {
        weightUsed = r.weight;
        repsHit = 0;
      } else if (r.outcome === 'success') {
        weightUsed = roundTo2(r.weight - increment);
        repsHit = meta.reps;
      } else if (r.outcome === 'deload') {
        weightUsed = roundTo2(r.weight / (1 - meta.deloadPct));
        repsHit = Math.max(meta.reps - 1, 0);
      } else {
        weightUsed = r.weight;
        repsHit = Math.max(meta.reps - 1, 0);
      }

      const row = [date, sessionNumber, workoutName, bodyWeight, meta.name];
      for (let s = 1; s <= 5; s++) {
        if (s <= meta.sets) {
          row.push(repsHit, weightUsed);
        } else {
          row.push('', '');
        }
      }
      rows.push(row);
    });
  });

  return rows
    .map((row) => row.map((field) => `"${String(field).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
}

function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  // Strip surrounding quotes from header cells too, so CSVs we export ourselves
  // (which quote every field, including the header) can be re-imported.
  const header = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const matches = lines[i].match(/"([^"]*)"/g);
    if (!matches) continue;
    const values = matches.map((m) => m.slice(1, -1));
    const row = {};
    header.forEach((h, idx) => {
      row[h] = values[idx];
    });
    rows.push(row);
  }
  return rows;
}

// Groups CSV rows into workout sessions and figures out, for each exercise,
// whether the session was a success, a missed-rep attempt, or a deload.
function buildHistoryFromCsv(rows) {
  const sessionsMap = new Map();
  const importExerciseMap = getImportExerciseMap();

  rows.forEach((row) => {
    const exerciseKey = importExerciseMap[row.Exercise];
    if (!exerciseKey) return; // skip exercises we don't track (e.g. Pullups)

    const date = row['Date (yyyy/mm/dd)'];
    const order = parseInt(row.Workout, 10);
    const sessionKey = `${date}_${row.Workout}`;

    if (!sessionsMap.has(sessionKey)) {
      const bodyWeight = parseFloat(row['Body Weight (LBS)']);
      const workoutName = (row['Workout Name'] || '').trim();
      sessionsMap.set(sessionKey, {
        date,
        order: Number.isFinite(order) ? order : 0,
        workout: workoutName === 'Deload Day' ? 'deload' : (workoutName.endsWith('B') ? 'B' : 'A'),
        exercises: {},
        bodyWeight: Number.isFinite(bodyWeight) ? bodyWeight : undefined,
      });
    }

    const meta = getExerciseMeta(exerciseKey);
    const weight = parseFloat(row['Set 1 (LBS)']);
    let success = true;
    for (let s = 1; s <= meta.sets; s++) {
      const reps = parseInt(row[`Set ${s} (Reps)`], 10);
      if (!Number.isFinite(reps) || reps < meta.reps) success = false;
    }

    sessionsMap.get(sessionKey).exercises[exerciseKey] = {
      success,
      weight: Number.isFinite(weight) ? weight : 0,
    };
  });

  const sessions = [...sessionsMap.values()].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.order - b.order;
  });

  const failsTracker = {};
  const lastWeight = {};
  const history = [];

  sessions.forEach((session) => {
    const results = {};
    const exerciseKeys = session.workout === 'deload'
      ? Object.keys(session.exercises)
      : getWorkoutExercises(session.workout);
    exerciseKeys.forEach((key) => {
      const data = session.exercises[key];
      if (!data) return;

      const meta = getExerciseMeta(key);
      const prevWeight = lastWeight[key];
      let outcome;
      if (data.success) {
        outcome = 'success';
        failsTracker[key] = 0;
      } else {
        failsTracker[key] = (failsTracker[key] || 0) + 1;
        if (prevWeight !== undefined && data.weight < prevWeight) {
          outcome = 'deload';
          failsTracker[key] = 0;
        } else {
          outcome = 'fail';
        }
      }

      results[key] = {
        outcome,
        weight: data.weight,
        fails: outcome === 'fail' ? Math.min(failsTracker[key], 3) : 0,
        name: meta.name,
      };
      lastWeight[key] = data.weight;
    });

    const entry = {
      date: new Date(session.date.replace(/\//g, '-')).toISOString(),
      workout: session.workout,
      results,
    };
    if (session.bodyWeight !== undefined) {
      entry.bodyWeight = session.bodyWeight;
    }
    history.push(entry);
  });

  const lastBodyWeight = [...sessions].reverse().find((s) => s.bodyWeight !== undefined);
  const lastAbWorkout = [...sessions].reverse().find((s) => s.workout === 'A' || s.workout === 'B');
  const lastWorkout = lastAbWorkout ? lastAbWorkout.workout : null;
  return { history, lastWeight, failsTracker, lastWorkout, lastBodyWeight: lastBodyWeight ? lastBodyWeight.bodyWeight : undefined };
}

function applyImport(result) {
  const unit = 'lb'; // the StrongLifts export used here is always in LBS
  state.unit = unit;
  state.history = result.history;
  state.exercises = state.exercises || {};

  ORDER.forEach((key) => {
    const existingFails = (state.exercises[key] && state.exercises[key].fails) || 0;
    state.exercises[key] = {
      weight: result.lastWeight[key] !== undefined ? result.lastWeight[key] : UNIT_DEFAULTS[unit][key].weight,
      increment: UNIT_DEFAULTS[unit][key].increment,
      fails: result.failsTracker[key] !== undefined ? result.failsTracker[key] : existingFails,
    };
  });

  // Custom exercises keep their existing weight/increment unless the import has newer data.
  Object.keys(state.customExercises || {}).forEach((key) => {
    const existing = state.exercises[key] || { weight: 0, increment: 0, fails: 0 };
    state.exercises[key] = {
      weight: result.lastWeight[key] !== undefined ? result.lastWeight[key] : existing.weight,
      increment: existing.increment,
      fails: result.failsTracker[key] !== undefined ? result.failsTracker[key] : existing.fails || 0,
    };
  });

  if (result.lastWorkout) {
    state.nextWorkout = result.lastWorkout === 'A' ? 'B' : 'A';
  }

  if (result.lastBodyWeight !== undefined) {
    state.lastBodyWeight = result.lastBodyWeight;
  }

  state.setupComplete = true;
  state.session = null;
  saveState(state);
}

// --- Event wiring ---

document.getElementById('setup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const unit = document.querySelector('input[name="unit"]:checked').value;
  const exercises = {};
  ORDER.forEach((key) => {
    const input = document.getElementById(`weight-${key}`);
    const weight = parseFloat(input.value);
    const existingFails = (state.exercises && state.exercises[key] && state.exercises[key].fails) || 0;
    exercises[key] = {
      weight: Number.isFinite(weight) ? weight : UNIT_DEFAULTS[unit][key].weight,
      increment: UNIT_DEFAULTS[unit][key].increment,
      fails: existingFails,
    };
  });

  const plateInventory = state.plateInventory || defaultPlateInventory();
  const plateCounts = {};
  PLATES[unit].forEach((plate) => {
    const id = `plate-${String(plate).replace('.', '_')}`;
    const input = document.getElementById(id);
    const count = parseInt(input.value, 10);
    plateCounts[plate] = Number.isFinite(count) && count >= 0 ? count : DEFAULT_PLATE_COUNTS[unit][plate];
  });
  plateInventory[unit] = plateCounts;

  state.unit = unit;
  state.exercises = exercises;
  state.plateInventory = plateInventory;
  state.setupComplete = true;
  state.session = null; // restart the session in case the workout in progress changed

  saveState(state);
  renderHomeScreen();
  showScreen('home');
});

document.getElementById('import-csv').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    let result;
    try {
      const rows = parseCsv(reader.result);
      result = buildHistoryFromCsv(rows);
    } catch (err) {
      alert('Could not read that file. Make sure it is a CSV export from the StrongLifts app.');
      return;
    }

    if (result.history.length === 0) {
      alert('No StrongLifts workout sessions were found in that file.');
      return;
    }

    const message =
      `Found ${result.history.length} workout session(s) in this file.\n\n` +
      'This will REPLACE your current workout history and update your working weights ' +
      'to match the most recent session in the file. Continue?';
    if (!confirm(message)) return;

    applyImport(result);
    renderHomeScreen();
    showScreen('home');
    alert('Import complete! Your history and weights have been updated.');
  };
  reader.onerror = () => {
    alert('Could not read that file.');
  };
  reader.readAsText(file);
  e.target.value = ''; // allow re-selecting the same file later
});

document.getElementById('start-workout-btn').addEventListener('click', () => {
  renderHomeScreen();
  showScreen('home');
});

document.getElementById('deload-slider').addEventListener('input', updateDeloadPreview);

document.getElementById('confirm-deload-btn').addEventListener('click', () => {
  const pct = parseInt(document.getElementById('deload-slider').value, 10);
  if (!confirm(`Apply a ${pct}% deload to all exercises and log it as a Deload Day?`)) return;

  const results = {};
  [...ORDER, ...Object.keys(state.customExercises || {})].forEach((key) => {
    const meta = getExerciseMeta(key);
    const ex = state.exercises && state.exercises[key];
    if (!meta || !ex) return;

    const newWeight = roundWeight(ex.weight * (1 - pct / 100), state.unit);
    ex.weight = newWeight;
    ex.fails = 0;
    results[key] = { outcome: 'deload', weight: newWeight, fails: 0, name: meta.name };
  });

  state.history.push({ date: new Date().toISOString(), workout: 'deload', results });
  saveState(state);
  renderDashboard();
});

document.getElementById('export-data-btn').addEventListener('click', () => {
  const csv = buildExportCsv();
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `stronglifts-history-${date}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

document.querySelectorAll('.settings-tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    showSettingsTab(btn.dataset.tab);
  });
});

document.querySelectorAll('.range-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    progressRange = btn.dataset.range;
    document.querySelectorAll('.range-btn').forEach((b) => b.classList.toggle('active', b === btn));
    renderProgressScreen();
  });
});

document.getElementById('exercise-pills').addEventListener('click', (e) => {
  const toggleBtn = e.target.closest('.pill-toggle');
  const infoBtn = e.target.closest('.pill-info');

  if (toggleBtn) {
    const key = toggleBtn.dataset.key;
    if (visibleExercises.has(key)) {
      visibleExercises.delete(key);
    } else {
      visibleExercises.add(key);
    }
    renderProgressScreen();
    return;
  }

  if (infoBtn) {
    openExerciseDetailModal(infoBtn.dataset.key);
  }
});

document.getElementById('trend-toggle-btn').addEventListener('click', (e) => {
  showTrendLines = !showTrendLines;
  e.target.classList.toggle('active', showTrendLines);
  renderProgressScreen();
});

document.getElementById('reset-zoom-btn').addEventListener('click', () => {
  if (progressChart) progressChart.resetZoom();
});

document.getElementById('datapoint-close-btn').addEventListener('click', () => {
  document.getElementById('datapoint-modal').classList.add('hidden');
});

document.getElementById('exercise-detail-close-btn').addEventListener('click', () => {
  document.getElementById('exercise-detail-modal').classList.add('hidden');
});

document.querySelectorAll('.workout-select-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    selectWorkout(btn.dataset.workout);
  });
});

document.getElementById('exercise-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.set-btn');
  if (!btn) return;
  const key = btn.dataset.exercise;
  const idx = parseInt(btn.dataset.set, 10);
  const meta = EXERCISES[key];
  const current = state.session.sets[key][idx];

  let next;
  if (current === 'pending') {
    next = meta.reps;
  } else if (current === 0) {
    next = 'pending';
  } else {
    next = current - 1;
  }

  state.session.sets[key][idx] = next;
  saveState(state);
  renderHomeScreen();

  if (next !== 'pending') {
    startRestTimer();
  }
});

document.getElementById('body-weight-input').addEventListener('input', (e) => {
  const value = e.target.value;
  state.session.bodyWeight = value === '' ? undefined : value;
  saveState(state);
});

document.getElementById('finish-btn').addEventListener('click', () => {
  const allSets = WORKOUTS[state.session.workout].flatMap((key) => state.session.sets[key]);
  const untouched = allSets.filter((s) => s === 'pending').length;
  if (untouched > 0) {
    const proceed = confirm(`${untouched} set(s) are still marked as not done. Finish anyway?`);
    if (!proceed) return;
  }
  if (!confirm('Finish this workout and save your progress?')) return;

  const result = finishWorkout();
  renderHomeScreen();
  showCongratsModal(result);
});

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const screen = btn.dataset.screen;
    if (screen === 'dashboard') {
      renderDashboard();
      showScreen('dashboard');
    } else if (screen === 'home') {
      renderHomeScreen();
      showScreen('home');
    } else if (screen === 'progress') {
      renderProgressScreen();
      showScreen('progress');
    } else if (screen === 'history') {
      renderHistoryScreen();
      showScreen('history');
    } else if (screen === 'settings') {
      renderSetupForm(true);
      showScreen('settings');
    }
  });
});

// --- Rest timer ---

const REST_DURATION = 180; // 3 minutes

let timerInterval = null;
let timerSeconds = REST_DURATION;

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateTimerDisplay() {
  document.getElementById('timer-display').textContent = formatTime(timerSeconds);
}

function hideTimerBar() {
  document.getElementById('rest-timer-bar').classList.add('hidden');
  document.getElementById('app').classList.remove('timer-active');
}

function startRestTimer() {
  clearInterval(timerInterval);
  timerSeconds = REST_DURATION;
  updateTimerDisplay();
  document.getElementById('rest-timer-bar').classList.remove('hidden');
  document.getElementById('app').classList.add('timer-active');

  timerInterval = setInterval(() => {
    timerSeconds -= 1;
    updateTimerDisplay();
    if (timerSeconds <= 0) {
      clearInterval(timerInterval);
      timerInterval = null;
      hideTimerBar();
    }
  }, 1000);
}

document.getElementById('timer-skip-btn').addEventListener('click', () => {
  clearInterval(timerInterval);
  timerInterval = null;
  hideTimerBar();
});

// --- Init ---

async function init() {
  document.getElementById('app-version').textContent = `Version ${APP_VERSION}`;
  state = await loadState();
  if (state.setupComplete) {
    renderDashboard();
    showScreen('dashboard');
  } else {
    renderSetupForm(false);
    showScreen('setup');
  }
  initAuth();
}

init();

// --- Service worker update handling ---

// Once the new worker takes over, reload so the page picks up the new assets.
let refreshing = false;

function reloadForUpdate() {
  if (refreshing) return;
  refreshing = true;
  window.location.reload();
}

function showUpdateBanner(worker) {
  const banner = document.getElementById('update-banner');
  banner.classList.remove('hidden');
  document.getElementById('update-btn').onclick = () => {
    worker.postMessage('SKIP_WAITING');
    banner.classList.add('hidden');
    // controllerchange should fire and trigger the reload, but some mobile
    // browsers don't reliably deliver it after a postMessage-triggered
    // skipWaiting, so fall back to a timed reload either way.
    setTimeout(reloadForUpdate, 750);
  };
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((registration) => {
      // A worker may already be waiting from a previous visit (e.g. if the
      // user didn't tap "update" last time).
      if (registration.waiting) {
        showUpdateBanner(registration.waiting);
      }

      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBanner(newWorker);
          }
        });
      });

      // Check for a fresh service worker whenever the app is reopened/foregrounded.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          registration.update().catch(() => {});
        }
      });
    }).catch(() => {});
  });

  navigator.serviceWorker.addEventListener('controllerchange', reloadForUpdate);
}
