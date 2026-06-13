const STORAGE_KEY = 'sl5x5_state';

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

async function saveState(state) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(state, STATE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    // IndexedDB unavailable - data won't persist, but the app keeps working for this session.
  }
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
  squat: '#2563eb',
  bench: '#16a34a',
  row: '#f59e0b',
  ohp: '#a855f7',
  deadlift: '#ef4444',
  bodyWeight: '#64748b',
};

// Colors for custom exercises, assigned in the order they were added.
const CUSTOM_CHART_COLORS = ['#0ea5e9', '#84cc16', '#ec4899', '#f97316', '#14b8a6', '#8b5cf6', '#eab308', '#06b6d4'];

const OUTCOME_LABELS = {
  success: 'Success',
  fail: 'Missed',
  deload: 'Deload',
};

let progressChart = null;
let progressRange = 'lifetime';
let visibleExercises = new Set(['squat']);

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
        <div class="history-exercise">
          <span>Body Weight</span>
          <span>${entry.bodyWeight} ${state.unit}</span>
        </div>
      `
      : '';

    const card = document.createElement('div');
    card.className = 'history-card';
    card.innerHTML = `<h4>${date} - Workout ${entry.workout}</h4>${rows}${bodyWeightRow}`;
    historyContainer.appendChild(card);
  });
}

function renderProgressScreen() {
  const history = getValidHistory();

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

  if (chartHistory.length === 0) {
    chartCanvas.classList.add('hidden');
    emptyMsg.classList.remove('hidden');
    return;
  }
  chartCanvas.classList.remove('hidden');
  emptyMsg.classList.add('hidden');

  const customKeys = Object.keys(state.customExercises || {});
  const chartKeys = [...ORDER, ...customKeys, 'bodyWeight'];

  const labels = chartHistory.map((entry) => new Date(entry.date).toLocaleDateString());
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
        return entry.results[key] ? entry.results[key].weight : null;
      }),
      borderColor: color,
      backgroundColor: color,
      spanGaps: true,
      tension: 0.2,
      hidden: !visibleExercises.has(key),
    };
  });

  progressChart = new Chart(chartCanvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      scales: {
        y: { title: { display: true, text: `Weight (${state.unit})` } },
        x: { title: { display: true, text: 'Date' } },
      },
      plugins: {
        legend: {
          onClick: (e, legendItem, legend) => {
            const chart = legend.chart;
            const index = legendItem.datasetIndex;
            const key = chartKeys[index];
            if (chart.isDatasetVisible(index)) {
              chart.hide(index);
              visibleExercises.delete(key);
            } else {
              chart.show(index);
              visibleExercises.add(key);
            }
          },
        },
      },
    },
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
    const workoutName = `Workout ${entry.workout}`;
    const bodyWeight = entry.bodyWeight !== undefined ? entry.bodyWeight : '';

    Object.keys(entry.results).forEach((key) => {
      const r = entry.results[key];
      if (!r) return;
      const meta = getExerciseMeta(key) || { name: r.name || key, sets: 5, reps: 5, deloadPct: 0.10 };
      const increment = (state.exercises[key] && state.exercises[key].increment) || 0;

      // Estimate the weight actually used in this session, since the history only
      // stores the weight to use *next* time for successes and deloads.
      let weightUsed;
      if (r.outcome === 'success') {
        weightUsed = roundTo2(r.weight - increment);
      } else if (r.outcome === 'deload') {
        weightUsed = roundTo2(r.weight / (1 - meta.deloadPct));
      } else {
        weightUsed = r.weight;
      }

      // Reps achieved isn't tracked per set, so approximate: full reps on success,
      // one rep short on the last set otherwise.
      const repsHit = r.outcome === 'success' ? meta.reps : Math.max(meta.reps - 1, 0);

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
      sessionsMap.set(sessionKey, {
        date,
        order: Number.isFinite(order) ? order : 0,
        workout: (row['Workout Name'] || '').trim().endsWith('B') ? 'B' : 'A',
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
    getWorkoutExercises(session.workout).forEach((key) => {
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
  const lastWorkout = sessions.length ? sessions[sessions.length - 1].workout : null;
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
    if (screen === 'home') {
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
  state = await loadState();
  if (state.setupComplete) {
    renderHomeScreen();
    showScreen('home');
  } else {
    renderSetupForm(false);
    showScreen('setup');
  }
}

init();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
