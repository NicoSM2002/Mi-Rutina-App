/* ══════════════════════════════════════════════════════════════════════
   GENERADOR DE PLANES

   Arma la primera rutina de una cuenta con IA a partir de la encuesta.
   Es la misma lógica con la que se armó a mano la de nicolassaravia,
   pasada a reglas:

     · Los días definen la división (torso/pierna, empuje/tirón/pierna, la de
       cinco días, empuje/tirón/pierna).
     · El tiempo define cuántos circuitos caben y la experiencia cuántas
       series. Cada circuito son tres ejercicios.
     · El objetivo define rangos de repeticiones, descansos y si hay cardio.
     · El lugar, la experiencia y las molestias filtran el catálogo ANTES
       de que nadie elija nada.

   La IA sólo elige entre candidatos válidos (y escribe la explicación); el
   código comprueba cada elección y, si algo no cuadra o la API no
   responde, elige él. Sin IA el plan sale igual de completo.
   ══════════════════════════════════════════════════════════════════════ */
import { CATALOGO, PorNombre } from './catalogo-ejercicios.js';

const sinTilde = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export const OBJETIVOS = ['hipertrofia', 'fuerza', 'recomposicion'];
export const NIVELES = ['principiante', 'intermedio', 'avanzado'];
export const MOLESTIAS = ['hombro', 'rodilla', 'lumbar', 'codo'];
const NOMBRE_DIA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

/* ── Qué tipo de ejercicio es ──────────────────────────────────────────
   C = compuesto. A = aislamiento. En hombro se distingue la porción,
   porque un día de hombro con tres press no es un día de hombro:
   L = lateral, P = posterior, F = frontal. */
export function tipoDe(ex) {
  const n = sinTilde(ex.name), m = ex.muscle;
  if (m === 'hombros') {
    if (/press/.test(n)) return 'C';
    if (/frontal/.test(n)) return 'F';
    if (/pajaro|face pull|invertido|inversa|cuban/.test(n)) return 'P';
    return 'L';
  }
  if (['biceps', 'triceps', 'pantorrilla', 'abdomen', 'trapecio', 'antebrazo'].includes(m)) {
    return /agarre cerrado|chin-up/.test(n) ? 'C' : 'A';
  }
  if (/brazos rectos|pull ?over|apertura|cruce|peck|patada|abduc|aductora|extension de cuadriceps|curl femoral|curl nordico|sissy|wall sit|estatica/.test(n)) return 'A';
  return 'C';
}

/* ── Filtros ──────────────────────────────────────────────────────── */

// En casa: mancuernas, un banco y el propio cuerpo
const CASA_TAMBIEN = new Set(['Elevación de talones unilateral de pie', 'Pullover con mancuerna']);
function sirveEnCasa(ex) {
  if (CASA_TAMBIEN.has(ex.name)) return true;
  const n = sinTilde(ex.name);
  if (!['mancuerna', 'corporal'].includes(ex.unit)) return false;
  return !/barra|polea|cable|maquina|multipower|smith|paralelas|colgado|silla romana|prensa|hack|landmine|declinado|disco|kettlebell|wheel|glute-ham|nordico|dominada|remo invertido|chin-up|asistid/.test(n);
}

// Lo que pide técnica o una base que un principiante todavía no tiene
const DIFICILES = /pendlay|pistol|nordico|glute-ham|wheel|rollout|dominadas pronas|colgado|peso muerto con barra|peso muerto sumo|sentadilla frontal|sentadilla trasera|buenos dias|jm press|zottman|cuban|waiter|tate|landmine|sissy|kettlebell|abiertas y cerradas|giros rusos|farmer|curl de muneca|piernas rigidas|box squat|fondos en paralelas|remo con barra inclinado|press militar con barra|press militar sentada|barra t/;

// Lo que suele cargar cada zona. Conservador a propósito: si hay duda, fuera.
const POR_MOLESTIA = {
  hombro: /press militar|press de hombro|press arnold|cuban|remo al menton|fondos|landmine|abiertas y cerradas|pull ?over|declinado|dominadas pronas|colgado|elevacion frontal con barra/,
  rodilla: /pistol|sissy|zancada|bulgara|step-up|wall sit|estatica|sentadilla frontal|sentadilla trasera|box squat|hack|pendulo|talones elevados|sumo en multipower/,
  lumbar: /peso muerto|buenos dias|remo con barra|pendlay|barra t|sentadilla trasera|sentadilla frontal|kettlebell|giros rusos|wheel|rollout|good/,
  codo: /skull|press frances|jm press|curl de biceps con barra|curl de muneca|curl inverso|barra plana|predicador barra|arana con barra|zottman|tate|flexion diamante|fondos en banco|waiter/,
};

/* Qué ejercicios valen para esta persona. Lo usan el generador, la
   rotación semanal y el chat: así ninguno de los tres propone algo que
   no puede hacer. Sin encuesta (cuentas anteriores) vale todo. */
export function filtroDelAtleta(enc) {
  if (!enc) return () => true;
  const casa = enc.lugar === 'casa';
  const novato = enc.nivel === 'principiante';
  const zonas = (enc.molestias || []).filter(z => POR_MOLESTIA[z]);
  return ex => {
    const n = sinTilde(ex.name);
    if (casa && !sirveEnCasa(ex)) return false;
    if (novato && DIFICILES.test(n)) return false;
    for (const z of zonas) if (POR_MOLESTIA[z].test(n)) return false;
    return true;
  };
}

/* ── Preferencias ─────────────────────────────────────────────────────
   Los básicos de cada músculo van primero. Lo que no está en la lista
   queda detrás, en el orden del catálogo. */
const PREFERIDOS = [
  // pecho
  'Press de banca plano con barra', 'Press inclinado con mancuernas', 'Press de banca plano con mancuernas',
  'Press inclinado Smith', 'Press de pecho en máquina', 'Press inclinado en máquina', 'Fondos en paralelas para pecho',
  'Cruce de poleas', 'Peck deck', 'Aperturas inclinadas con mancuernas', 'Cruce de cables bajo a alto',
  'Aperturas con mancuernas en banco plano', 'Aperturas en máquina', 'Flexión estándar', 'Push-up inclinado',
  // espalda
  'Jalón al pecho agarre ancho', 'Remo con barra inclinado', 'Remo sentado en polea', 'Dominadas pronas',
  'Jalón al pecho agarre cerrado', 'Remo con mancuerna a una mano', 'Remo sentado en máquina', 'Remo en barra T',
  'Dominadas asistidas en máquina', 'Jalón con brazos rectos en polea', 'Pull over en cable', 'Pullover con mancuerna',
  // hombros
  'Press de hombro sentado con mancuernas', 'Press militar con barra', 'Press de hombro en máquina', 'Press Arnold con mancuernas',
  'Elevaciones laterales con mancuernas', 'Elevación lateral en polea', 'Vuelos laterales sentada',
  'Face Pull con cuerda en polea', 'Peck deck invertido', 'Pájaros con mancuernas inclinado', 'Pájaro en cables (pec deck inversa)',
  'Elevaciones frontales alternas con mancuernas', 'Elevación frontal con disco',
  // pierna
  'Sentadilla en multipower', 'Prensa de piernas 45', 'Sentadilla trasera con barra', 'Hack Squat',
  'Sentadilla Goblet con mancuerna', 'Sentadilla búlgara', 'Zancadas con mancuernas',
  'Extensión de cuádriceps', 'Extensión de cuádriceps unilateral',
  'Peso muerto rumano con barra', 'Peso muerto a piernas rígidas', 'Curl femoral tumbado', 'Curl femoral sentado',
  'Curl femoral unilateral de pie',
  'Hip Thrust con barra', 'Hip Thrust en máquina', 'Hip Thrust en multipower', 'Peso muerto rumano con mancuernas',
  'Hip thrust unilateral con mancuerna', 'Puente de glúteos con barra',
  'Patada de glúteo en polea', 'Abductora en máquina', 'Abducción de cadera en polea', 'Patada de glúteo en máquina',
  'Patada de glúteo con mancuerna',
  'Elevación de talones de pie', 'Elevación de talones sentado', 'Elevación de talones en prensa',
  'Elevación de talones unilateral de pie',
  // brazos
  'Curl de bíceps con barra', 'Curl inclinado con mancuernas', 'Curl martillo', 'Curl en polea con cuerda',
  'Curl de bíceps con mancuernas', 'Curl predicador barra EZ', 'Curl bayesiano en polea', 'Curl predicador en máquina',
  'Curl de concentración',
  'Extensiones de tríceps en polea con barra V', 'Extensiones de tríceps en polea con cuerda',
  'Extensión unilateral de tríceps sobre cabeza en polea', 'Press francés acostado con barra',
  'Extensión de tríceps sobre la cabeza', 'Patada de tríceps con mancuerna', 'Skull crusher con mancuernas',
  'Extensión de tríceps sentado con mancuerna',
  // core y trapecio
  'Crunch en polea arrodillado', 'Elevación de piernas en silla romana', 'Plancha estática', 'Crunch abdominal clásico',
  'Crunch inverso', 'Encogimientos con mancuernas', 'Encogimientos con barra', 'Encogimientos en polea',
];
const RANGO_PREF = new Map(PREFERIDOS.map((n, i) => [n, i]));
const rangoPref = ex => RANGO_PREF.has(ex.name) ? RANGO_PREF.get(ex.name) : 500 + CATALOGO.indexOf(ex);

/* ── Divisiones ───────────────────────────────────────────────────────
   Cada sesión son hasta tres circuitos de tres huecos, en orden de
   prioridad: con poco tiempo se quedan los dos primeros circuitos, que
   llevan los básicos. El patrón 2+1 / 1+2 es el de la rutina original. */
const S = (titulo, ...c) => ({ titulo, huecos: c.flat() });
/* Regla del usuario: pierna va siempre sola, sin otro grupo. Y no todos los
   días tienen que juntar dos grupos: depende de la división (hombro, por
   ejemplo, puede ir solo). Por eso no hay cuerpo completo. */
const TORSO_A = [[['pecho','C'],['espalda','C'],['hombros','L']], [['pecho','C'],['espalda','C'],['biceps','A']], [['hombros','C'],['triceps','A'],['hombros','P']]];
const TORSO_B = [[['espalda','C'],['pecho','C'],['hombros','P']], [['espalda','C'],['pecho','A'],['triceps','A']], [['hombros','C'],['biceps','A'],['abdomen','A']]];
const PIERNA_A = [[['cuadriceps','C'],['isquio','C'],['pantorrilla','A']], [['cuadriceps','C'],['gluteo','C'],['isquio','A']], [['cuadriceps','A'],['gluteo','A'],['pantorrilla','A']]];
const PIERNA_B = [[['isquio','C'],['cuadriceps','C'],['gluteo','A']], [['gluteo','C'],['cuadriceps','C'],['pantorrilla','A']], [['isquio','A'],['gluteo','A'],['cuadriceps','A']]];
const EMPUJE = [[['pecho','C'],['pecho','C'],['hombros','L']], [['hombros','C'],['pecho','A'],['triceps','A']], [['triceps','A'],['hombros','L'],['triceps','A']]];
const TIRON = [[['espalda','C'],['espalda','C'],['biceps','A']], [['espalda','C'],['hombros','P'],['biceps','A']], [['espalda','A'],['biceps','A'],['abdomen','A']]];
const DIVISIONES = {
  2: [S('Torso', ...TORSO_A), S('Pierna', ...PIERNA_A)],
  3: [S('Empuje', ...EMPUJE), S('Tirón', ...TIRON), S('Pierna', ...PIERNA_A)],
  4: [S('Torso A', ...TORSO_A), S('Pierna A', ...PIERNA_A), S('Torso B', ...TORSO_B), S('Pierna B', ...PIERNA_B)],
  5: [
    S('Pecho + Bíceps', [['pecho','C'],['pecho','C'],['biceps','A']], [['pecho','A'],['biceps','A'],['biceps','A']], [['pecho','A'],['pecho','A'],['biceps','A']]),
    S('Espalda + Tríceps', [['espalda','C'],['espalda','C'],['triceps','A']], [['espalda','C'],['triceps','A'],['triceps','A']], [['espalda','C'],['espalda','A'],['triceps','A']]),
    S('Pierna', [['cuadriceps','C'],['isquio','C'],['pantorrilla','A']], [['cuadriceps','C'],['isquio','A'],['gluteo','C']], [['cuadriceps','A'],['isquio','A'],['pantorrilla','A']]),
    S('Hombros', [['hombros','C'],['hombros','L'],['hombros','P']], [['hombros','C'],['hombros','L'],['hombros','P']], [['hombros','F'],['hombros','P'],['trapecio','A']]),
    S('Espalda + Pecho', [['espalda','C'],['espalda','C'],['pecho','C']], [['pecho','C'],['pecho','A'],['espalda','C']], [['espalda','A'],['espalda','C'],['pecho','A']]),
  ],
  6: [
    S('Empuje A', ...EMPUJE), S('Tirón A', ...TIRON), S('Pierna A', ...PIERNA_A),
    S('Empuje B', [['pecho','C'],['hombros','C'],['triceps','A']], [['pecho','C'],['pecho','A'],['hombros','L']], [['hombros','L'],['triceps','A'],['pecho','A']]),
    S('Tirón B', [['espalda','C'],['espalda','C'],['hombros','P']], [['espalda','C'],['biceps','A'],['biceps','A']], [['espalda','A'],['hombros','P'],['trapecio','A']]),
    S('Pierna B', ...PIERNA_B),
  ],
};

/* ── Volumen y estímulo ───────────────────────────────────────────── */
function estructura(enc) {
  const circuitos = enc.minutos <= 45 ? 2 : 3;
  // Un principiante progresa con menos; cuatro vueltas sólo con tiempo de sobra
  const series = enc.nivel === 'principiante' ? 3 : (enc.minutos >= 90 || enc.nivel === 'avanzado') ? 4 : 3;
  const descanso = enc.objetivo === 'fuerza' ? 90 : enc.objetivo === 'recomposicion' ? 45 : 60;
  return { circuitos, series, descanso };
}

/* Rango de repeticiones por tipo de movimiento: el mismo criterio que la
   rotación semanal, con la fuerza bajando el rango de los compuestos. */
export function rangoDeRepsPara(nombre, enc) {
  const n = sinTilde(nombre);
  let r = [8, 12];
  if (/talones|crunch|plancha|abdomen|piernas/.test(n)) r = [12, 20];
  else if (/press de banca|press inclinado|press militar|press de hombro|sentadilla|peso muerto|dominada|remo con barra|remo en barra|remo pendlay|hack|prensa|hip thrust|zancada/.test(n)) r = [6, 10];
  else if (/curl|extension|elevacion|apertura|cruce|cable|pajaro|vuelo|face ?pull|peck deck|patada|encogimiento|skull|jm press|press frances|fondos/.test(n)) r = [10, 15];
  const cat = PorNombre[nombre];
  const basico = cat && cat.unit !== 'corporal' && tipoDe(cat) === 'C';
  if (enc && enc.objetivo === 'fuerza' && r[0] === 6 && basico) r = enc.nivel === 'principiante' ? [6, 8] : [4, 6];
  // Un principiante aprende el movimiento con algo más de margen
  if (enc && enc.nivel === 'principiante' && r[0] === 6 && enc.objetivo !== 'fuerza') r = [8, 12];
  return r;
}

/* ── Cargas de partida ────────────────────────────────────────────────
   No hay forma de saber cuánto levanta alguien a quien no se ha visto
   entrenar. Se estima por peso corporal, nivel y sexo, a la baja, y se
   marca para calibrar: la primera vez que marque el ejercicio, el salto
   es doble. Si dio pesos de referencia, esos mandan sobre su grupo.

   Proporción de la carga TOTAL de trabajo (8-12 reps) respecto al peso
   corporal en un hombre intermedio. Mancuerna: por mancuerna. */
const PROPORCION = [
  // Las pantorrillas primero: "talones en prensa" no es una prensa de piernas
  [/talones en prensa/, 0.8],
  [/talones unilateral/, 0.2],
  [/talones (de pie|burro)/, 0.8],
  [/talones/, 0.5],
  [/press de banca (plano|declinado) con barra|press de banca agarre cerrado/, 0.8],
  [/press inclinado (con barra|smith)/, 0.6],
  [/press (de banca|inclinado).*mancuerna/, 0.22],
  [/press (de pecho|inclinado) en maquina/, 0.55],
  [/apertura.*mancuerna/, 0.1],
  [/peck deck invertido|pajaro en cables/, 0.3],
  [/apertura|peck|cruce/, 0.3],
  [/sentadilla frontal/, 0.65],
  [/sentadilla (en multipower|trasera|sumo en multipower|con talones)|box squat|hack|pendulo|zancadas (con barra|en multipower)/, 0.85],
  [/prensa/, 1.6],
  [/goblet|sentadilla sumo con mancuerna/, 0.25],
  [/bulgara|zancadas|step-up/, 0.13],
  [/extension de cuadriceps/, 0.45],
  [/curl femoral/, 0.35],
  [/aductora|abductora|abduccion/, 0.45],
  [/peso muerto con barra|peso muerto sumo/, 1.0],
  [/peso muerto (rumano con barra|a piernas)|buenos dias/, 0.7],
  [/peso muerto rumano con mancuernas/, 0.22],
  [/hip thrust (con barra|en multipower)|puente de gluteos/, 0.9],
  [/hip thrust en maquina/, 0.7],
  [/hip thrust unilateral/, 0.15],
  [/patada de gluteo/, 0.2],
  [/remo (con barra|pendlay|en barra t)/, 0.55],
  [/jalon con brazos rectos|pull ?over/, 0.3],
  [/jalon|remo (sentado|alto|unilateral en polea)/, 0.55],
  [/remo con mancuerna/, 0.22],
  [/press militar|press de hombro en multipower/, 0.45],
  [/press (de hombro sentado|arnold).*mancuerna/, 0.16],
  [/press de hombro en maquina/, 0.4],
  [/lateral.*mancuerna|vuelos|pajaros con mancuernas|frontal/, 0.06],
  [/lateral en polea|remo al menton cable/, 0.1],
  [/face pull/, 0.3],
  [/curl.*barra|curl predicador maquina discos|waiter/, 0.3],
  [/curl.*mancuerna|curl martillo|curl de concentracion|zottman/, 0.11],
  [/curl/, 0.25],
  [/extension.*(polea|maquina)|extensiones de triceps/, 0.28],
  [/press frances|jm press|barra plana/, 0.3],
  [/extension de triceps (sobre la cabeza|sentado)/, 0.2],
  [/patada de triceps/, 0.06],
  [/skull crusher|tate/, 0.09],
  [/encogimientos con mancuernas|encogimientos inclinados/, 0.28],
  [/encogimientos/, 0.8],
  [/crunch en (polea|maquina)/, 0.35],
];
const TREN_INFERIOR = new Set(['cuadriceps', 'isquio', 'gluteo', 'pantorrilla']);

function pesoBarra(n) {
  if (/multipower|smith/.test(n)) return 20;
  if (/barra|sentadilla trasera|sentadilla frontal|box squat|peso muerto|hip thrust con barra|puente de gluteos|buenos dias|pendlay|zancadas con barra/.test(n)) return 45;
  return 0;   // prensa, hack, péndulo, barra T: sólo cuentan los discos
}

function redondea(v, paso) {
  const p = paso || 5;
  return Math.round(v / p) * p;
}

/* Grupo al que afecta cada peso de referencia */
const REFERENCIA_DE = {
  pecho: 'banca', triceps: 'banca', hombros: 'banca',
  cuadriceps: 'sentadilla', isquio: 'sentadilla', gluteo: 'sentadilla', pantorrilla: 'sentadilla',
  espalda: 'jalon', biceps: 'jalon', trapecio: 'jalon',
};
// Contra qué ejercicio se compara cada referencia
const BASE_REFERENCIA = {
  banca: 'Press de banca plano con barra',
  sentadilla: 'Sentadilla en multipower',
  jalon: 'Jalón al pecho agarre ancho',
};

function proporcionDe(ex) {
  const n = sinTilde(ex.name);
  const regla = PROPORCION.find(([re]) => re.test(n));
  return regla ? regla[1] : ex.unit === 'mancuerna' ? 0.11 : ex.unit === 'lado' ? 0.6 : 0.3;
}

function cargaEstimada(ex, enc, factores) {
  if (ex.unit === 'corporal' || !ex.step) return '';
  const n = sinTilde(ex.name);
  const prop = proporcionDe(ex);
  const kgCuerpo = Number(enc.peso) || 70;
  const lbs = kgCuerpo * 2.2046;
  const nivel = { principiante: 0.6, intermedio: 0.9, avanzado: 1.2 }[enc.nivel] || 0.75;
  const mujer = enc.sexo === 'f' ? (TREN_INFERIOR.has(ex.muscle) ? 0.75 : 0.55) : 1;
  // La referencia dice mucho de los básicos y poco de un curl: en los
  // aislamientos se aplica amortiguada.
  const refBruto = factores[REFERENCIA_DE[ex.muscle]] || 1;
  const ref = tipoDe(ex) === 'C' ? refBruto : Math.sqrt(refBruto);
  let total = lbs * prop * nivel * mujer * ref;

  if (ex.unit === 'lado') {
    const lado = (total - pesoBarra(n)) / 2;
    if (lado < ex.step) return pesoBarra(n) ? 'barra sola' : `${ex.step} lbs/lado`;
    return `${redondea(lado, ex.step)} lbs/lado`;
  }
  const v = Math.max(ex.step, redondea(total, ex.step));
  return ex.unit === 'mancuerna' ? `${v} lbs c/u` : `${v} lbs`;
}

/* ── Cargas con sentido ───────────────────────────────────────────────
   Lo que pesa de verdad un "w1": total levantado (por mancuerna, en
   mancuernas). Con él se compara contra un techo razonable y se pasa una
   carga de un ejercicio a otro. */
export function cargaTotal(ex, w1) {
  if (!ex || ex.unit === 'corporal') return null;
  const t = sinTilde(w1);
  const barra = pesoBarra(sinTilde(ex.name));
  if (/barra sola/.test(t)) return barra || null;
  const m = t.match(/[\d.,]+/);
  if (!m) return null;
  const v = parseFloat(m[0].replace(',', '.'));
  if (!isFinite(v) || v <= 0) return null;
  return ex.unit === 'lado' ? v * 2 + barra : v;
}

/* Lo contrario: un total escrito como se carga en ese aparato */
function escribeCarga(ex, total) {
  const paso = ex.step || 5, barra = pesoBarra(sinTilde(ex.name));
  if (ex.unit === 'lado') {
    const lado = (total - barra) / 2;
    if (lado < paso) return barra ? 'barra sola' : `${paso} lbs/lado`;
    return `${redondea(lado, paso)} lbs/lado`;
  }
  const v = Math.max(paso, redondea(total, paso));
  return ex.unit === 'mancuerna' ? `${v} lbs c/u` : `${v} lbs`;
}

/* Peso corporal y sexo de quien entrena: de la encuesta, del perfil o de su
   última medición. Sin dato, un adulto promedio. */
export function perfilDeCarga(atleta) {
  const enc = (atleta && atleta.encuesta) || {};
  const prof = (atleta && atleta.profile) || {};
  const meds = Array.isArray(atleta && atleta.measurements) ? atleta.measurements : [];
  const med = meds.length ? meds[meds.length - 1] : null;
  const peso = Number(enc.peso) || Number(prof.weight) || Number(med && med.weight) || 75;
  const sexo = enc.sexo || prof.sex || 'm';
  return { peso, sexo };
}

/* Lo máximo razonable para ese ejercicio: más del doble de lo de un
   intermedio. Por encima, la carga es un error (un dato mal puesto, un
   ejercicio confundido con otro), no una marca, y quien la ve escrita se
   lesiona. Sólo en los compuestos con peso libre: es donde un número absurdo
   hace daño, y en máquinas y poleas el número cambia de un gimnasio a otro,
   así que ahí no hay proporción en la que confiar. */
export function techoDe(ex, perfil) {
  if (!ex || ex.unit === 'corporal' || ex.unit === 'placa' || !ex.step) return null;
  if (tipoDe(ex) !== 'C') return null;
  return cargaIntermedia(ex, perfil) * 2.2;
}
function cargaIntermedia(ex, perfil) {
  const lbs = (Number(perfil && perfil.peso) || 75) * 2.2046;
  const mujer = perfil && perfil.sexo === 'f' ? (TREN_INFERIOR.has(ex.muscle) ? 0.75 : 0.55) : 1;
  return lbs * proporcionDe(ex) * 0.9 * mujer;
}

export function cargaDesproporcionada(ex, w1, perfil) {
  const t = cargaTotal(ex, w1), techo = techoDe(ex, perfil);
  return t !== null && techo !== null && t > techo;
}

/* Una carga razonable de arranque para ese ejercicio y esa persona */
export function cargaSugerida(ex, perfil) {
  return ex && ex.unit !== 'corporal' && ex.step ? escribeCarga(ex, cargaIntermedia(ex, perfil)) : '';
}

/* Pasa la carga de un ejercicio a otro por su proporción. Heredar el número
   tal cual es lo que convierte 70 lbs/lado de una máquina en 70 lbs/lado de
   press militar con barra. Nunca arranca cerca del techo. */
export function convierteCarga(de, w1, a, perfil) {
  if (!a || a.unit === 'corporal' || !de) return '';
  const t = cargaTotal(de, w1);
  if (t === null) return '';
  let total = t * proporcionDe(a) / proporcionDe(de);
  const techo = techoDe(a, perfil);
  if (techo && total > techo * 0.6) total = techo * 0.6;
  return escribeCarga(a, total);
}

/* Si dio pesos de referencia, cuánto se separa de lo estimado. Acotado:
   un dato raro no puede triplicar todo un grupo. */
function factoresDeReferencia(enc) {
  const out = {};
  const refs = enc.referencias || {};
  for (const clave of Object.keys(BASE_REFERENCIA)) {
    const dado = Number(refs[clave]);
    if (!dado || !isFinite(dado) || dado <= 0) continue;
    const ex = PorNombre[BASE_REFERENCIA[clave]];
    if (!ex) continue;
    // Lo estimado sin factor, en carga total
    const txt = cargaEstimada(ex, enc, {});
    let estimado = parseFloat(txt) || 0;
    if (ex.unit === 'lado') estimado = estimado * 2 + pesoBarra(sinTilde(ex.name));
    if (txt === 'barra sola') estimado = pesoBarra(sinTilde(ex.name));
    if (!estimado) continue;
    out[clave] = Math.min(2, Math.max(0.5, dado / estimado));
  }
  return out;
}

/* ── Candidatos por hueco ─────────────────────────────────────────── */
const VECINO = { isquio: 'gluteo', gluteo: 'isquio', trapecio: 'hombros', pantorrilla: 'cuadriceps' };
export function huecosDelPlan(enc) {
  const n = Math.max(2, Math.min(6, (enc.dias || []).length));
  const division = DIVISIONES[n];
  const { circuitos } = estructura(enc);
  const vale = filtroDelAtleta(enc);
  const novato = enc.nivel === 'principiante';

  const orden = (a, b) => {
    if (novato) {
      // Primero lo guiado: máquina y mancuerna antes que barra libre
      const u = e => e.unit === 'placa' ? 0 : e.unit === 'mancuerna' ? 1 : 2;
      if (u(a) !== u(b)) return u(a) - u(b);
    }
    return rangoPref(a) - rangoPref(b);
  };

  return division.map((ses, si) => {
    const huecos = ses.huecos.slice(0, circuitos * 3).map(([musculo, tipo]) => {
      let cands = CATALOGO.filter(e => e.muscle === musculo && vale(e) && tipoDe(e) === tipo);
      // Si el filtro deja el hueco vacío, se acepta el otro tipo del mismo
      // músculo, y si tampoco hay, el músculo vecino (en casa no hay curl
      // femoral, pero sí peso muerto rumano con mancuernas).
      if (!cands.length) cands = CATALOGO.filter(e => e.muscle === musculo && vale(e));
      if (!cands.length && VECINO[musculo]) cands = CATALOGO.filter(e => e.muscle === VECINO[musculo] && vale(e));
      return { musculo, tipo, candidatos: cands.sort(orden).map(e => e.name) };
    });
    return { titulo: ses.titulo, huecos };
  });
}

/* Elige un ejercicio por hueco. Usa la elección de la IA si existe y es
   válida; si no, el más preferido que no esté ya en la sesión y que se
   haya usado menos en la semana (así el segundo día de pecho no repite). */
function elegirTodo(sesiones, eleccionesIA) {
  const usosSemana = new Map();
  return sesiones.map((ses, si) => {
    const enSesion = new Set();
    const elegidos = ses.huecos.map((h, hi) => {
      const ia = eleccionesIA && eleccionesIA[si] && eleccionesIA[si][hi];
      let nombre = (ia && h.candidatos.includes(ia) && !enSesion.has(ia)) ? ia : null;
      if (!nombre) {
        const libres = h.candidatos.filter(c => !enSesion.has(c));
        libres.sort((a, b) => (usosSemana.get(a) || 0) - (usosSemana.get(b) || 0));
        nombre = libres[0] || null;
      }
      if (nombre) {
        enSesion.add(nombre);
        usosSemana.set(nombre, (usosSemana.get(nombre) || 0) + 1);
      }
      return nombre;
    });
    return elegidos;
  });
}

/* ── Calentamiento ────────────────────────────────────────────────────
   La regla de siempre, dos vueltas:
     · Tren superior: bloque de hombro (laterales, frontales y press de pie
       con 5 lbs, 15 reps). En día de hombro ya lo cubre: no se repite.
     · Del día: un ejercicio por cada grupo que se va a trabajar, el mismo de
       la rutina y con poco peso. La segunda vuelta, un poco más ("a → b").
   Sale de los circuitos, así que se rehace cada vez que la rutina cambia. */
const img = n => (PorNombre[n] && PorNombre[n].img) || undefined;
function pasoDeCalentamiento(ex) {
  const paso = { text: ex.name, reps: '15 reps' };
  if (ex.img) paso.img = ex.img;
  if (ex.unit === 'corporal') return { ...paso, w: 'sin peso', reps: '8 reps' };
  const t = cargaTotal(ex, ex.w1);
  if (!t) return { ...paso, w: 'muy ligero' };
  const barra = ex.unit === 'lado' ? pesoBarra(sinTilde(ex.name)) : 0;
  const v1 = barra ? 'barra sola' : escribeCarga(ex, t * 0.4);
  const v2 = escribeCarga(ex, Math.max(barra, t * (barra ? 0.5 : 0.6)));
  return { ...paso, w: v1 === v2 ? v1 : `${v1} → ${v2}` };
}

export function calentamientoDelDia(circuits) {
  const exs = (circuits || []).flatMap(c => c.exercises || []).filter(e => e && e.name);
  const musculos = [...new Set(exs.map(e => e.muscle))];
  const superior = musculos.some(m => !TREN_INFERIOR.has(m) && m !== 'abdomen');
  const warmupHombro = superior ? [
    { text: 'Elevaciones laterales', w: '5 lbs', reps: '15 reps', img: img('Elevaciones laterales con mancuernas') },
    { text: 'Elevaciones frontales', w: '5 lbs', reps: '15 reps', img: img('Elevaciones frontales alternas con mancuernas') },
    { text: 'Press de hombro con mancuernas, de pie', w: '5 lbs', reps: '15 reps', img: img('Press de hombro sentado con mancuernas') },
  ].map(p => { if (!p.img) delete p.img; return p; }) : [];
  // Lo que el bloque de hombro ya calienta, y el abdomen, no llevan paso propio
  const cubiertos = new Set(['abdomen', ...(superior ? ['hombros', 'trapecio'] : [])]);
  const warmup = [];
  for (const m of musculos) {
    if (cubiertos.has(m)) continue;
    const delGrupo = exs.filter(e => e.muscle === m);
    // Mejor uno con carga: una dominada no se calienta "con poco peso"
    const ex = delGrupo.find(e => e.unit !== 'corporal' && cargaTotal(e, e.w1) !== null) || delGrupo[0];
    if (ex) warmup.push(pasoDeCalentamiento(ex));
  }
  return { warmupHombro, warmup, warmupSeries: 2 };
}

/* Días de entreno en orden de la semana: lunes primero, domingo al final */
export function ordenaDias(dias) {
  return [...new Set((dias || []).map(Number).filter(d => d >= 0 && d <= 6))]
    .sort((a, b) => (a || 7) - (b || 7));
}

/* ── Ensamblar la rutina ──────────────────────────────────────────── */
export function armarRutina(enc, eleccionesIA) {
  const dias = ordenaDias(enc.dias);
  const sesiones = huecosDelPlan(enc);
  const elegidos = elegirTodo(sesiones, eleccionesIA);
  const { series, descanso } = estructura(enc);
  const factores = factoresDeReferencia(enc);
  const rutina = {};

  sesiones.forEach((ses, si) => {
    const ejercicios = elegidos[si].map((nombre, hi) => {
      if (!nombre) return null;
      const cat = PorNombre[nombre];
      const [lo, hi2] = rangoDeRepsPara(nombre, enc);
      const w1 = cargaEstimada(cat, enc, factores);
      return {
        name: cat.name, muscle: cat.muscle, unit: cat.unit, step: cat.step,
        img: cat.img, tip: cat.tip,
        w1, reps: lo + ' reps', repMin: lo, repMax: hi2, repNow: lo, fallos: 0,
        calibrar: cat.unit !== 'corporal',
        _hueco: hi,
      };
    });

    const circuits = [];
    for (let c = 0; c * 3 < ejercicios.length; c++) {
      const exs = ejercicios.slice(c * 3, c * 3 + 3).filter(Boolean).map(e => { delete e._hueco; return e; });
      if (exs.length) circuits.push({ label: `Circuito ${circuits.length + 1}`, series, rest: `${descanso}s descanso`, exercises: exs });
    }

    // Drop en la última serie: sólo avanzados, sólo el último aislamiento
    // del día y sólo donde la carga se cambia en segundos.
    if (enc.nivel === 'avanzado' && enc.objetivo !== 'fuerza' && circuits.length) {
      const ult = circuits[circuits.length - 1].exercises;
      const ex = ult[ult.length - 1];
      if (ex && ['placa', 'mancuerna'].includes(ex.unit) && tipoDe(ex) !== 'C' && parseFloat(ex.w1)) {
        ex.dropFinal = { pasos: 2, reps: [10, 8] };
      }
    }

    const diaSemana = dias[si];
    rutina['sesion' + (si + 1)] = {
      title: ses.titulo,
      dia: diaSemana !== undefined ? NOMBRE_DIA[diaSemana] : '',
      sub: '',
      ...calentamientoDelDia(circuits),
      cardio: enc.objetivo === 'recomposicion'
        ? 'Cardio al final: 15 min a ritmo moderado (caminadora inclinada o bicicleta)' : '',
      circuits,
    };
  });
  return rutina;
}

/* Lo que se le manda a la IA para que elija: los huecos con sus mejores
   candidatos. Ocho por hueco bastan y mantienen el mensaje corto. */
export function fichasParaIA(enc) {
  return huecosDelPlan(enc).map((s, si) => ({
    sesion: si + 1, titulo: s.titulo,
    huecos: s.huecos.map((h, hi) => ({ hueco: hi, musculo: h.musculo, tipo: h.tipo, candidatos: h.candidatos.slice(0, 8) })),
  }));
}

/* La explicación del plan cuando la IA no está */
export function explicacionDeRespaldo(enc) {
  const n = ordenaDias(enc.dias).length;
  const division = n === 2 ? 'un día de torso y otro de pierna' : n === 3 ? 'empuje, tirón y pierna' : n === 4 ? 'torso y pierna alternados'
    : n === 5 ? 'un grupo grande por día, con pecho y espalda dos veces' : 'empuje, tirón y pierna, dos veces por semana';
  const obj = { hipertrofia: 'ganar músculo', fuerza: 'ganar fuerza', recomposicion: 'ganar músculo y perder grasa a la vez' }[enc.objetivo] || 'progresar';
  return `Tu plan es de ${n} días con ${division}, pensado para ${obj}. ` +
    `Los pesos son un punto de partida estimado: la primera semana marca cada ejercicio como fácil, justo o no llegué y ` +
    `se corrige solo. Desde ahí, cada sábado se ajusta según cómo te fue.`;
}

/* Resumen corto para enseñar el plan recién hecho */
export function resumenDelPlan(rutina) {
  return Object.keys(rutina).sort().map(k => {
    const s = rutina[k];
    const exs = (s.circuits || []).flatMap(c => c.exercises || []);
    return { key: k, title: s.title, dia: s.dia, ejercicios: exs.length, circuitos: (s.circuits || []).length,
             series: (s.circuits[0] && s.circuits[0].series) || 0, nombres: exs.slice(0, 4).map(e => e.name),
             // La app titula cada sesión por sus músculos: con esto el resumen
             // dice lo mismo que verá después en Rutina
             musculos: exs.map(e => e.muscle) };
  });
}

/* Valida y normaliza la encuesta. Devuelve { enc } o { error } */
export function validarEncuesta(e) {
  if (!e || typeof e !== 'object') return { error: 'Faltan las respuestas' };
  const enc = {
    objetivo: OBJETIVOS.includes(e.objetivo) ? e.objetivo : null,
    nivel: NIVELES.includes(e.nivel) ? e.nivel : null,
    dias: ordenaDias(e.dias),
    minutos: [45, 60, 90].includes(Number(e.minutos)) ? Number(e.minutos) : 60,
    lugar: e.lugar === 'casa' ? 'casa' : 'gimnasio',
    sexo: e.sexo === 'f' ? 'f' : e.sexo === 'm' ? 'm' : null,
    edad: Math.round(Number(e.edad)) || null,
    peso: Number(e.peso) || null,
    estatura: Number(e.estatura) || null,
    molestias: Array.isArray(e.molestias) ? e.molestias.filter(z => MOLESTIAS.includes(z)) : [],
    molestiaTexto: String(e.molestiaTexto || '').trim().slice(0, 300),
    referencias: {},
  };
  for (const k of Object.keys(BASE_REFERENCIA)) {
    const v = Number(e.referencias && e.referencias[k]);
    if (v > 0 && v < 1500) enc.referencias[k] = Math.round(v);
  }
  if (!enc.objetivo) return { error: 'Elige un objetivo' };
  if (!enc.nivel) return { error: 'Elige tu experiencia' };
  if (enc.dias.length < 2 || enc.dias.length > 6) return { error: 'Elige entre 2 y 6 días' };
  if (!enc.sexo) return { error: 'Falta el sexo' };
  if (!enc.edad || enc.edad < 14 || enc.edad > 90) return { error: 'Revisa la edad' };
  if (!enc.peso || enc.peso < 30 || enc.peso > 250) return { error: 'Revisa el peso (en kg)' };
  if (!enc.estatura || enc.estatura < 120 || enc.estatura > 230) return { error: 'Revisa la estatura (en cm)' };
  return { enc };
}
