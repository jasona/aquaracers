// Shared constants and configuration for AquaRacers

export const WORLD_WIDTH = 1600;
export const WORLD_HEIGHT = 1000;

// Bottom shoreline / RC pier occupies y: 915..1000
export const SHORELINE_Y = 915;

// Safe navigable bay region inside the 1600x1000 world
export const BAY_BOUNDS = Object.freeze({
  minX: 90,
  maxX: 1510,
  minY: 85,
  maxY: 895,
});

// Core race settings
export const TOTAL_LAPS = 3;
export const COUNTDOWN_SECONDS = 3;
export const BOAT_COUNT = 5;

// Authentic water racing time penalties (in seconds)
export const PENALTY_JUMP_START = 2.0;
export const PENALTY_BUOY_HIT = 1.5;
export const PENALTY_COURSE_CUT = 3.0;
export const BUOY_HIT_COOLDOWN = 2.0;

// Persistent career storage key
export const CAREER_STORAGE_KEY = 'aquaracers_career_v1';

// 5 distinctive RC offshore racing boats (index 0 = player, indices 1..4 = AI)
export const BOAT_PRESETS = Object.freeze([
  Object.freeze({
    id: 'boat-1',
    number: '01',
    name: 'Apex Surge',
    isPlayer: true,
    primaryColor: '#FF4D2E',
    accentColor: '#FFD166',
    hullColor: '#F8FAFC',
    deckColor: '#0F172A',
    aiStyle: 'apex',
    skill: 1.0,
  }),
  Object.freeze({
    id: 'boat-2',
    number: '07',
    name: 'Cobalt Viper',
    isPlayer: false,
    primaryColor: '#0284C7',
    accentColor: '#38BDF8',
    hullColor: '#F1F5F9',
    deckColor: '#0C1E35',
    aiStyle: 'apex',
    skill: 1.02,
  }),
  Object.freeze({
    id: 'boat-3',
    number: '14',
    name: 'Solar Flare',
    isPlayer: false,
    primaryColor: '#F59E0B',
    accentColor: '#FEF08A',
    hullColor: '#FFFBEB',
    deckColor: '#1E293B',
    aiStyle: 'aggressive',
    skill: 0.99,
  }),
  Object.freeze({
    id: 'boat-4',
    number: '23',
    name: 'Emerald Wake',
    isPlayer: false,
    primaryColor: '#10B981',
    accentColor: '#A7F3D0',
    hullColor: '#F0FDF4',
    deckColor: '#064E3B',
    aiStyle: 'steady',
    skill: 0.96,
  }),
  Object.freeze({
    id: 'boat-5',
    number: '88',
    name: 'Riptide Rebel',
    isPlayer: false,
    primaryColor: '#D946EF',
    accentColor: '#F5D0FE',
    hullColor: '#FAF5FF',
    deckColor: '#2E1065',
    aiStyle: 'wild',
    skill: 0.93,
  }),
]);

// RC offshore boat hydrodynamics & collision tuning
export const PHYSICS = Object.freeze({
  maxSpeed: 295,
  reverseMaxSpeed: 95,
  thrustAccel: 390,
  reverseAccel: 210,
  forwardDrag: 0.42,
  forwardQuadDrag: 0.0029,
  lateralDrag: 3.15,
  turnRate: 2.95,
  minTurnFactor: 0.42,
  angularDrag: 5.4,
  throttleResponse: 7.5,
  steerResponse: 11.0,
  boatRadius: 15,
  boatLength: 38,
  boatWidth: 16,
  buoyRadius: 11,
  outerBuoyRadius: 7,
  wakeMaxAge: 1.45,
  wakeSampleInterval: 0.032,
  wakeTurbulenceDrag: 0.14,
  wakeChopRadius: 24,
  maxRollAngle: 0.48,
  maxRudderAngle: 0.55,
  collisionRestitution: 0.45,
  boundaryPush: 240,
  countdownCreepFactor: 0.42,
});
