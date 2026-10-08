import { CATALOGO, PorMusculo, PorNombre } from './catalogo-ejercicios.js';
import { armarRutina, fichasParaIA, validarEncuesta, explicacionDeRespaldo, resumenDelPlan,
         filtroDelAtleta, ordenaDias, calentamientoDelDia, perfilDeCarga, techoDe, cargaTotal,
         cargaDesproporcionada, cargaSugerida, convierteCarga } from './plan-ia.js';
// ── Shared constants ──
// Fallback destination for trainer notifications when the athlete's trainerId
// is missing or the trainer record has no email. Real routing uses
// resolveTrainerEmail(env, athlete) which looks up the trainer in KV.
const DEFAULT_TRAINER_EMAIL = 'juansaravia2002@gmail.com';

// ── Athletes: dynamic KV-backed store ──
// Schema:
//   KV `athlete-index`   → string[] of clientIds in display order
//   KV `athlete:${id}`   → { clientId, username, name, email, sessionsPerWeek,
//                            profile:{...}, preferredDays:[], photoUrl, pdfUrl,
//                            createdAt, archived }
// First call to listAthletes / getAthlete seeds Nicolás y María if the index
// doesn't exist yet — routines already in `routine:nicolas` / `routine:msaravia`
// are NOT touched.

const SEED_ATHLETES = [
  {
    clientId: 'nicolas',
    username: 'nsaravia',
    name: 'Nicolás Saravia',
    email: 'nicolas@drakeconstruction.com',
    sessionsPerWeek: 5,
    preferredDays: ['lun','mar','mie','jue','vie'],
    profile: {
      weight: 67.9, bodyFat: 11.3, muscleMass: 57.1, bmi: 21, bmr: 1723,
      goal: 'hipertrofia', level: 'intermedio', notes: '', injuries: ''
    }
  },
  {
    clientId: 'msaravia',
    username: 'msaravia',
    name: 'María Saravia',
    email: 'nicolas@drakeconstruction.com',
    sessionsPerWeek: 4,
    preferredDays: ['lun','mar','jue','vie'],
    profile: {
      weight: null, bodyFat: null, muscleMass: null, bmi: null, bmr: null,
      goal: 'hipertrofia', level: 'intermedio', notes: '', injuries: ''
    }
  },
];

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function bootstrapAthletesIfNeeded(env) {
  const existing = await env.DB.get('athlete-index', 'json');
  // Bootstrap only on the very first call (index never existed).
  // Respect an empty array — means trainer deleted everyone intentionally.
  if (existing !== null) return existing;
  const ids = [];
  for (const a of SEED_ATHLETES) {
    await env.DB.put(`athlete:${a.clientId}`, JSON.stringify({ ...a, createdAt: Date.now(), archived: false }));
    ids.push(a.clientId);
  }
  await env.DB.put('athlete-index', JSON.stringify(ids));
  return ids;
}

async function listAthletes(env, { includeArchived = false } = {}) {
  const ids = await bootstrapAthletesIfNeeded(env);
  // Las lecturas van en paralelo: en serie eran ~23 viajes encadenados a KV y
  // cada login los pagaba enteros. Se conserva el orden del índice.
  const records = await Promise.all(ids.map(id => env.DB.get(`athlete:${id}`, 'json')));
  return records.filter(a => a && (includeArchived || !a.archived));
}

async function getAthlete(env, clientId) {
  if (!clientId) return null;
  await bootstrapAthletesIfNeeded(env);
  return await env.DB.get(`athlete:${clientId}`, 'json');
}

// ── Trainers ──
const SEED_TRAINERS = [
  { username: 'entrenador', name: 'Entrenador Principal', email: 'juansaravia2002@gmail.com', phone: '', photoUrl: null }
];

async function bootstrapTrainersIfNeeded(env) {
  const existing = await env.DB.get('trainer-index', 'json');
  if (existing !== null) return existing;
  const ids = [];
  for (const t of SEED_TRAINERS) {
    await env.DB.put(`trainer:${t.username}`, JSON.stringify({ ...t, createdAt: Date.now() }));
    ids.push(t.username);
  }
  await env.DB.put('trainer-index', JSON.stringify(ids));
  return ids;
}

async function listTrainers(env) {
  const ids = await bootstrapTrainersIfNeeded(env);
  const out = [];
  for (const id of ids) {
    const t = await env.DB.get(`trainer:${id}`, 'json');
    if (t) out.push(t);
  }
  return out;
}

async function getTrainer(env, username) {
  if (!username) return null;
  return await env.DB.get(`trainer:${username}`, 'json');
}

// Resolve the trainer email to notify for an athlete's events. Returns
// DEFAULT_TRAINER_EMAIL if the athlete has no trainerId or the trainer has
// no email configured.
async function resolveTrainerEmail(env, athlete) {
  if (!athlete || !athlete.trainerId) return DEFAULT_TRAINER_EMAIL;
  const t = await getTrainer(env, athlete.trainerId);
  return (t && t.email) || DEFAULT_TRAINER_EMAIL;
}

// ── Self-token (athlete session auth) ──
// Atletas se loguean contra `athlete-login` y reciben `selfToken = sha256(clientId + ATHLETE_SECRET)`.
// Se adjunta en cada request que opere sobre data propia (meals, complete, reads).
async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function computeSelfToken(env, clientId) {
  const secret = env.ATHLETE_SECRET || 'fallback-dev-secret-change-me';
  return await sha256Hex(`${clientId}:${secret}`);
}

async function verifySelfToken(env, clientId, token) {
  if (!clientId || !token) return false;
  const expected = await computeSelfToken(env, clientId);
  return expected === token;
}


/* ══════════════════════════════════════════════════════════════════════
   MOTOR DE PROGRESIÓN

   Esquema de progresión doble: las repeticiones suben dentro del rango del
   ejercicio y, cuando tocan el techo, sube la carga un salto y las reps
   vuelven al suelo del rango. Es el estándar para hipertrofia y sobre todo
   es predecible.

   La única entrada son los tres botones que el atleta marca al cerrar cada
   circuito. Sin marca no se toca nada: inventar un incremento porque pasó
   una semana desincroniza la app del gimnasio en un mes.
   ══════════════════════════════════════════════════════════════════════ */

/* El texto de una respuesta de la API.

   No vale con content[0].text: los modelos con razonamiento devuelven
   primero un bloque de pensamiento y el texto va en uno posterior, así que
   leer el primero daba cadena vacía y la llamada parecía haber fallado
   sin ruido. */
function textoDeRespuesta(data) {
  const bloques = (data && Array.isArray(data.content)) ? data.content : [];
  const texto = bloques.filter(b => b && b.type === 'text' && typeof b.text === 'string')
                       .map(b => b.text).join('\n').trim();
  if (!texto && bloques.length) {
    console.log('[IA] respuesta sin bloque de texto; tipos: ' + bloques.map(b => b && b.type).join(','));
  }
  return texto;
}

/* Cuentas con IA. Las nuevas llevan `modo: 'ia'` en su registro; la lista
   es la de antes de que existiera el campo y se queda para no tocar el
   registro de quien ya estaba. El resto de atletas sigue dependiendo de su
   entrenador y a su rutina no la toca nadie automáticamente. */
const ATLETAS_IA = ['nicolassaravia'];
function esIA(atleta) {
  return !!atleta && (atleta.modo === 'ia' || ATLETAS_IA.includes(atleta.clientId));
}
// Cuenta con IA que nadie entrena: no hay a quién mandarle correos
function sinEntrenador(atleta) {
  return !!atleta && atleta.modo === 'ia' && !atleta.trainerId;
}

/* Cómo se le presenta el atleta al modelo. Sale de su perfil: para
   nicolassaravia da exactamente el texto que antes estaba escrito a mano. */
function perfilTexto(atleta) {
  const p = (atleta && atleta.profile) || {};
  const partes = [];
  if (p.weight) partes.push(`${p.weight} kg`);
  if (p.height) partes.push(`${(Number(p.height) / 100).toFixed(2).replace('.', ',')} m`);
  if (p.goal) partes.push(`objetivo ${p.goal}`);
  const quien = p.sex === 'f' ? 'Una atleta' : 'Un atleta';
  const nivel = p.level || 'intermedio';
  let txt = `${quien} ${p.sex === 'f' ? nivel.replace(/o$/, 'a') : nivel}` + (partes.length ? ` (${partes.join(', ')})` : '');
  const enc = atleta && atleta.encuesta;
  if (enc && enc.lugar === 'casa') txt += ', que entrena en casa con mancuernas y un banco';
  if (enc && enc.molestiaTexto) txt += `. Contó esta molestia: "${enc.molestiaTexto}"`;
  return txt;
}

/* Cómo se lee la carga de cada aparato. Lo trae el ejercicio desde el
   catálogo; el sufijo es para que el número de la app sea el mismo que el
   atleta ve en el hierro. */
const SUFIJO_CARGA = {
  lado: ' lbs/lado', mancuerna: ' lbs c/u', placa: ' lbs', total: ' lbs', corporal: ''
};

function numeroDePeso(txt) {
  const m = String(txt || '').match(/(\d+(?:[.,]\d+)?)/);
  return m ? parseFloat(m[1].replace(',', '.')) : 0;
}

function escribePeso(num, unidad) {
  if (!num || num <= 0) return '';
  return Math.round(num) + (SUFIJO_CARGA[unidad] !== undefined ? SUFIJO_CARGA[unidad] : ' lbs');
}

/* Un drop set no tiene una carga, tiene varias. Se mueve el primer escalón
   y los demás lo siguen en proporción, redondeando al salto del aparato.
   Devuelve el peso del primer escalón antes y después. */
function progresarDropset(ex, delta) {
  const pasos = Array.isArray(ex.steps1) ? ex.steps1 : [];
  const paso = parseInt(ex.step) || 5;
  const primero = numeroDePeso(pasos[0] && pasos[0].w);
  if (!primero) return null;
  const nuevoPrimero = Math.max(paso, primero + delta);
  const factor = nuevoPrimero / primero;
  for (const p of pasos) {
    const v = numeroDePeso(p.w);
    if (!v) continue;
    p.w = escribePeso(Math.max(paso, Math.round((v * factor) / paso) * paso), ex.unit);
  }
  // w1 refleja el escalón más alto, que es con el que se arranca
  ex.w1 = pasos[0].w;
  return { antes: primero, despues: numeroDePeso(pasos[0].w) };
}

/* Aplica una respuesta a un ejercicio. Devuelve qué cambió, o null si no
   había nada que marcar. Muta el ejercicio. */
function progresarEjercicio(ex, resp, perfil) {
  // Los drop sets y las pirámides llevan su carga en los escalones
  const esEscalonado = (ex.setType === 'dropset' || ex.setType === 'piramidal')
                    && Array.isArray(ex.steps1) && ex.steps1.length > 1;
  if (esEscalonado) {
    const paso = parseInt(ex.step) || 5;
    let fallos = parseInt(ex.fallos) || 0;
    let delta = 0, motivo = '';
    if (resp === 'facil')      { fallos = 0; delta = paso;  motivo = 'iba sobrado'; }
    else if (resp === 'justo') { fallos = 0; delta = 0;     motivo = 'se repite para consolidar'; }
    else if (resp === 'fallo') {
      fallos += 1;
      if (fallos >= 2) { fallos = 0; delta = -paso; motivo = 'dos semanas sin llegar'; }
      else { motivo = 'se repite la misma carga una semana más'; }
    } else return null;

    const r = delta ? progresarDropset(ex, delta) : null;
    ex.fallos = fallos;
    return {
      name: ex.name, resp, motivo,
      pesoAntes: r ? escribePeso(r.antes, ex.unit) : (ex.w1 || ''),
      pesoDespues: r ? escribePeso(r.despues, ex.unit) : (ex.w1 || ''),
      repsAntes: 0, repsDespues: 0,
      cambio: !r ? 'sin cambio' : (r.despues > r.antes ? 'sube carga' : 'baja carga'),
    };
  }

  const paso = parseInt(ex.step) || 0;
  const lo   = parseInt(ex.repMin) || 8;
  const hi   = parseInt(ex.repMax) || 12;
  const corporal = ex.unit === 'corporal' || !paso;

  const repsAntes = parseInt(ex.repNow) || lo;
  const pesoAntes = numeroDePeso(ex.w1);
  let reps = repsAntes, peso = pesoAntes;
  let fallos = parseInt(ex.fallos) || 0;
  let motivo = '';

  if (resp === 'facil') {
    // Fácil es por el peso: sube. Sólo cuando el escalón del aparato es
    // grande frente a la carga (más de un 10 %, como pasar de 15 a 20 lbs en
    // una mancuerna) van primero las repeticiones; en el tope del rango, el
    // peso igual. Las repeticiones se quedan donde estaban.
    fallos = 0;
    if (corporal) { reps = reps + 2; motivo = 'iba sobrado'; }
    else {
      const cat = PorNombre[ex.name] || ex;
      const total = cargaTotal(cat, ex.w1);
      const salto = total ? (ex.unit === 'lado' ? paso * 2 : paso) / total : 0;
      if (salto > 0.10 && reps < hi) { reps = Math.min(hi, reps + 2); motivo = 'iba sobrado; el salto de peso sería muy grande, primero repeticiones'; }
      else { peso = peso + paso; motivo = 'iba sobrado'; }
    }

  } else if (resp === 'justo') {
    // Justo nunca mueve el peso: una repetición más hasta el tope, y ahí se queda
    fallos = 0;
    if (reps < hi)       { reps = reps + 1; motivo = 'subiendo dentro del rango'; }
    else                 { motivo = 'en el tope del rango con esta carga'; }

  } else if (resp === 'fallo') {
    fallos = fallos + 1;
    if (fallos >= 2) {
      // Dos semanas sin llegar no es mala suerte: la carga está por encima
      fallos = 0;
      if (corporal)      { reps = Math.max(lo, reps - 2); }
      else               { peso = pesoAntes ? Math.max(paso, peso - paso) : 0; reps = lo; }
      motivo = 'dos semanas sin llegar';
    } else {
      motivo = 'se repite la misma carga una semana más';
    }

  } else {
    return null;   // sin marcar
  }

  // Tope de sentido común: si subir deja la carga fuera de lo razonable para
  // este ejercicio, se queda donde está. Mejor estancarse que lesionarse.
  if (perfil && !corporal && peso > pesoAntes) {
    const cat = PorNombre[ex.name] || ex;
    const techo = techoDe(cat, perfil);
    const total = cargaTotal(cat, escribePeso(peso, ex.unit));
    if (techo && total && total > techo) {
      peso = pesoAntes; reps = repsAntes;
      motivo = 'ya está en lo máximo razonable para este ejercicio';
    }
  }

  ex.repNow = reps;
  ex.reps = reps + ' reps';
  ex.fallos = fallos;
  // Con "barra sola" el número es cero: se deja el texto tal cual
  if (!corporal && peso > 0) ex.w1 = escribePeso(peso, ex.unit);

  const cambioPeso = Math.round(peso) !== Math.round(pesoAntes);
  const cambioReps = reps !== repsAntes;
  return {
    name: ex.name,
    resp,
    motivo,
    pesoAntes: escribePeso(pesoAntes, ex.unit),
    pesoDespues: escribePeso(peso, ex.unit),
    repsAntes, repsDespues: reps,
    cambio: cambioPeso ? (peso > pesoAntes ? 'sube carga' : 'baja carga')
          : cambioReps ? (reps > repsAntes ? 'sube reps' : 'baja reps')
          : 'sin cambio'
  };
}

/* Recorre la rutina aplicando las marcas de la semana.
   `marcas` viene indexado por "sesionN|Nombre del ejercicio". */
function progresarRutina(rutina, marcas, perfil, fijados) {
  const cambios = [];
  for (const clave of Object.keys(rutina || {})) {
    const dia = rutina[clave];
    if (!dia || !Array.isArray(dia.circuits)) continue;
    for (const c of dia.circuits) {
      const exs = Array.isArray(c.exercises) ? c.exercises : [];
      let fallosDelCircuito = 0;
      for (const ex of exs) {
        const resp = marcas[clave + '|' + ex.name];
        // Si anotó con qué carga lo hizo de verdad, esa ya es su progresión
        // de la semana: no se le suma nada encima.
        const r = fijados && fijados.has(ex.name) ? null : progresarEjercicio(ex, resp, perfil);
        if (r) { r.sesion = clave; r.circuito = c.label || ''; cambios.push(r); }
        if (resp === 'fallo') fallosDelCircuito++;
      }
      // Si el circuito entero se cae dos semanas seguidas, el problema no es
      // la carga sino el volumen: se le quita una serie (nunca por debajo de 3).
      if (exs.length && fallosDelCircuito === exs.length) {
        c.fallosSeguidos = (parseInt(c.fallosSeguidos) || 0) + 1;
        if (c.fallosSeguidos >= 2) {
          c.fallosSeguidos = 0;
          const antes = parseInt(c.series) || 4;
          if (antes > 3) {
            c.series = antes - 1;
            cambios.push({ sesion: clave, circuito: c.label || '', name: '(volumen)',
              cambio: 'baja series', motivo: 'el circuito entero se cayó dos semanas',
              repsAntes: antes, repsDespues: c.series });
          }
        }
      } else {
        c.fallosSeguidos = 0;
      }
    }
  }
  return cambios;
}

/* Las marcas de los últimos 7 días, la más reciente por ejercicio. */
function marcasDeLaSemana(completions, desdeTs) {
  const marcas = {};
  const orden = [...(completions || [])].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  for (const c of orden) {
    if (desdeTs && (c.ts || 0) < desdeTs) continue;
    for (const f of (Array.isArray(c.feedback) ? c.feedback : [])) {
      if (!f || !f.name || !f.resp || f.cal) continue;
      marcas[(c.sessionKey || '') + '|' + f.name] = f.resp;
    }
  }
  return marcas;
}

/* Las notas que escribió en cada ejercicio, la más reciente por ejercicio. */
function notasPorEjercicio(completions, desdeTs) {
  const out = [];
  const vistos = new Map();
  const orden = [...(completions || [])].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  for (const c of orden) {
    if (desdeTs && (c.ts || 0) < desdeTs) continue;
    for (const f of (Array.isArray(c.feedback) ? c.feedback : [])) {
      if (!f || !f.name || !String(f.nota || '').trim()) continue;
      vistos.set((c.sessionKey || '') + '|' + f.name,
        { sesion: c.sessionKey || '', name: f.name, resp: f.resp || null, nota: String(f.nota).trim() });
    }
  }
  for (const v of vistos.values()) out.push(v);
  return out;
}

/* Las notas que escribió al cerrar cada sesión de la semana. */
function notasDeLaSemana(completions, desdeTs) {
  return [...(completions || [])]
    .filter(c => (!desdeTs || (c.ts || 0) >= desdeTs) && String(c.notes || '').trim())
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .map(c => ({ dia: c.dayLabel || c.sessionKey || '', texto: String(c.notes).trim().slice(0, 600) }));
}

/* Semana ISO, para no correr dos veces la misma. */
function claveSemana(d) {
  const f = new Date(d);
  const j = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate()));
  j.setUTCDate(j.getUTCDate() + 4 - (j.getUTCDay() || 7));
  const ini = new Date(Date.UTC(j.getUTCFullYear(), 0, 1));
  const sem = Math.ceil((((j - ini) / 86400000) + 1) / 7);
  return j.getUTCFullYear() + '-S' + String(sem).padStart(2, '0');
}


/* ── Rotación de ejercicios ───────────────────────────────────────────
   Cada 6 semanas se cambian hasta 3 ejercicios que llevan tiempo sin
   moverse. No es por variar porque sí: si un ejercicio no sube en tres
   semanas, cambiar el estímulo suele destrabarlo. Los que progresan se
   quedan — no se toca lo que funciona. */

const SEMANAS_ENTRE_ROTACIONES = 6;

/* Rango de repeticiones de un ejercicio nuevo, por tipo de movimiento */
function rangoDeReps(nombre) {
  const n = String(nombre || '').toLowerCase()
    .replace(/[áà]/g,'a').replace(/[éè]/g,'e').replace(/[íì]/g,'i')
    .replace(/[óò]/g,'o').replace(/[úùü]/g,'u');
  if (/talones|crunch|plancha|abdomen|piernas/.test(n)) return [12, 20];
  if (/press de banca|press inclinado|press militar|press de hombro|sentadilla|peso muerto|dominada|remo con barra|remo en barra|remo pendlay|hack|prensa|hip thrust|zancada/.test(n)) return [6, 10];
  if (/curl|extension|elevacion|apertura|cruce|cable|pajaro|vuelo|face ?pull|peck deck|patada|encogimiento|skull|jm press|press frances|fondos/.test(n)) return [10, 15];
  return [8, 12];
}

/* El chat queda guardado para el ajuste semanal: lo que pregunta y lo que
   cambia ahí también es información. Últimos 60 días, máximo 150. */
async function guardaEnChatLog(env, clientId, entrada) {
  try {
    const k = `chatlog:${clientId}`;
    const lista = await env.DB.get(k, 'json') || [];
    const corte = Date.now() - 60 * 86400000;
    lista.push({ ts: Date.now(), ...entrada });
    await env.DB.put(k, JSON.stringify(lista.filter(x => (x.ts || 0) >= corte).slice(-150)));
  } catch (e) { console.log('[CHATLOG] ' + e.message); }
}

/* Ejercicios que llevan varias semanas sin subir ni carga ni repeticiones */
function ejerciciosEstancados(historial, limite) {
  const ultimas = (historial || []).slice(0, 3);
  if (ultimas.length < 3) return [];
  const movio = new Set();
  const vistos = new Set();
  for (const h of ultimas) {
    for (const c of (h.cambios || [])) {
      vistos.add(c.name);
      if (c.cambio === 'sube carga' || c.cambio === 'sube reps') movio.add(c.name);
    }
  }
  return [...vistos].filter(nm => nm !== '(volumen)' && !movio.has(nm)).slice(0, limite || 3);
}

/* Busca en las notas ejercicios que dieron problema. Devuelve sólo nombres
   que estén de verdad en la rutina: el modelo señala, el código comprueba. */
async function ejerciciosSeñaladosEnNotas(env, rutina, notas) {
  if (!notas.length || !env.ANTHROPIC_API_KEY) return [];

  const enRutina = [];
  for (const k of Object.keys(rutina)) {
    for (const c of (rutina[k].circuits || [])) {
      for (const e of (c.exercises || [])) enRutina.push(e.name);
    }
  }

  const prompt = `Estas son las notas que un atleta escribió al terminar sus entrenamientos esta semana:

${notas.map(x => `- ${x.dia}: ${x.texto}`).join('\n')}

Ejercicios de su rutina:
${enRutina.join('\n')}

¿Menciona algún ejercicio que le diera problema — dolor, molestia, se sintió mal, no lo pudo hacer
bien? Si lo menciona de forma indirecta ("el press de hombro me dejó el hombro raro"), cuenta.
No incluyas un ejercicio sólo porque le costó o pesó mucho: eso ya lo cubren otros datos.

Responde SOLO un JSON array, vacío si no hay nada:
[{"nombre":"nombre EXACTO de la lista","detalle":"qué dijo, en pocas palabras","dolor":true|false}]
"dolor" es true sólo si habla de dolor o molestia física, no de cansancio ni de equipo ocupado.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY,
                 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 700,
                             messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      console.log(`[NOTAS] la API respondió ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
      return [];
    }
    const txt = textoDeRespuesta(data);
    const m = txt.match(/\[[\s\S]*\]/);
    if (!m) { console.log('[NOTAS] respuesta sin JSON: ' + txt.slice(0, 200)); return []; }
    return JSON.parse(m[0])
      .filter(x => x && x.nombre && enRutina.includes(x.nombre))
      .slice(0, 3)
      .map(x => ({ name: x.nombre, detalle: String(x.detalle || '').slice(0, 160), dolor: !!x.dolor }));
  } catch (e) {
    console.log('[NOTAS] no se pudieron leer: ' + e.message);
    return [];
  }
}

async function proponerRotacion(env, rutina, candidatos, atleta) {
  if (!candidatos.length || !env.ANTHROPIC_API_KEY) return [];
  const vale = filtroDelAtleta(atleta && atleta.encuesta);

  // Lo que ya está en la rutina no puede proponerse como reemplazo
  const yaEstan = new Set();
  for (const k of Object.keys(rutina)) {
    for (const c of (rutina[k].circuits || [])) {
      for (const e of (c.exercises || [])) yaEstan.add(e.name);
    }
  }

  const fichas = [];
  for (const c of candidatos) {
    const actual = PorNombre[c.name];
    if (!actual) continue;
    const alternativas = (PorMusculo[actual.muscle] || [])
      .filter(e => !yaEstan.has(e.name) && vale(e))
      .map(e => e.name);
    if (alternativas.length) {
      fichas.push({ actual: c.name, musculo: actual.muscle, motivo: c.razon,
                    detalle: c.detalle || '', alternativas });
    }
  }
  if (!fichas.length) return [];

  const prompt = `Eres un entrenador de fuerza. ${perfilTexto(atleta)}
necesita cambiar estos ejercicios. Para cada uno, elige UN reemplazo de su lista de alternativas que
entrene el mismo músculo con un estímulo distinto (otro ángulo, otro patrón, otro tipo de resistencia).
No elijas una variante casi idéntica a la que ya hace.

El campo "motivo" dice por qué se cambia:
 - "estancado": lleva tres semanas sin progresar. Busca un estímulo nuevo.
 - "molestia": le dio problema; lee el "detalle". Aquí evita además el patrón que se lo causó —
   si molestó un press por encima de la cabeza, no propongas otro press por encima de la cabeza.

${JSON.stringify(fichas, null, 1)}

Responde SOLO con un JSON array, sin texto alrededor:
[{"actual":"...","nuevo":"...","porque":"una frase corta en español de Colombia, tuteando (nunca voseo)"}]
El campo "nuevo" debe ser EXACTAMENTE uno de los strings de su lista de alternativas.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY,
                 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 900,
                             messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      console.log(`[ROTACION] la API respondió ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
      return [];
    }
    const txt = textoDeRespuesta(data);
    const m = txt.match(/\[[\s\S]*\]/);
    if (!m) { console.log('[ROTACION] respuesta sin JSON: ' + txt.slice(0, 200)); return []; }
    const propuestas = JSON.parse(m[0]);

    // El modelo propone; aquí se comprueba. Lo que no cuadre, se descarta.
    return propuestas.filter(p => {
      if (!p || !p.actual || !p.nuevo) return false;
      const viejo = PorNombre[p.actual], nuevo = PorNombre[p.nuevo];
      if (!viejo || !nuevo) return false;
      if (viejo.muscle !== nuevo.muscle) return false;
      if (yaEstan.has(p.nuevo)) return false;
      if (!vale(nuevo)) return false;
      return candidatos.some(c => c.name === p.actual);
    });
  } catch (e) {
    console.log('[ROTACION] falló la propuesta: ' + e.message);
    return [];
  }
}

/* Aplica las rotaciones validadas sobre la rutina */
function aplicarRotacion(rutina, propuestas, perfil) {
  const hechas = [];
  for (const p of propuestas) {
    const nuevo = PorNombre[p.nuevo];
    for (const k of Object.keys(rutina)) {
      for (const c of (rutina[k].circuits || [])) {
        const exs = c.exercises || [];
        for (let i = 0; i < exs.length; i++) {
          if (exs[i].name !== p.actual) continue;
          const anterior = exs[i];
          const [lo, hi] = rangoDeReps(nuevo.name);
          // La carga se pasa por proporción entre los dos ejercicios: el mismo
          // número en otro aparato puede ser un disparate. La primera marca la
          // calibra.
          const w1 = convierteCarga(PorNombre[anterior.name] || anterior, anterior.w1, nuevo, perfil);
          const heredaPeso = !!w1 && w1 === anterior.w1;
          exs[i] = {
            name: nuevo.name, muscle: nuevo.muscle, unit: nuevo.unit, step: nuevo.step,
            img: nuevo.img, tip: nuevo.tip,
            w1,
            reps: lo + ' reps', repMin: lo, repMax: hi, repNow: lo, fallos: 0,
            calibrar: nuevo.unit !== 'corporal',
          };
          hechas.push({ sesion: k, circuito: c.label || '', de: p.actual, a: nuevo.name,
                        porque: String(p.porque || '').slice(0, 200), heredaPeso });
        }
      }
    }
  }
  return hechas;
}

/* Si la nota dice qué peso usó de verdad, ese manda sobre lo prescrito.
   El modelo lo lee; el código comprueba que el ejercicio esté en la rutina
   y que el número no sea un disparate antes de tocarlo. */
async function declaracionesDeLaSemana(env, rutina, notasEj, notasGen, chat) {
  const hayAlgo = notasEj.some(x => /\d/.test(x.nota)) || notasGen.some(x => /\d/.test(x.texto)) || chat.length;
  if (!hayAlgo || !env.ANTHROPIC_API_KEY) return [];

  const enRutina = new Map();
  for (const k of Object.keys(rutina)) {
    for (const c of (rutina[k].circuits || [])) {
      for (const e of (c.exercises || [])) enRutina.set(e.name, e);
    }
  }
  const ejercicios = [...enRutina.values()].map(e =>
    `- ${e.name}: prescrito ${e.w1 || 'sin peso'} × ${parseInt(e.repNow) || parseInt(e.reps) || '?'} reps (rango ${e.repMin || '?'}-${e.repMax || '?'})`).join('\n');
  const deEjercicio = notasEj.map(x => `- [${x.name}] "${x.nota}"`).join('\n') || '(ninguna)';
  const generales = notasGen.map(x => `- (${x.dia}) "${x.texto}"`).join('\n') || '(ninguna)';
  const delChat = chat.map(x => x.tipo === 'peso'
      ? `- (cambio de peso hecho desde el chat) ${x.name}: ${x.de || '?'} → ${x.a}`
      : `- Atleta: "${x.q}"${x.a ? `\n  Asistente: "${String(x.a).slice(0, 300)}"` : ''}`).join('\n') || '(nada)';

  const prompt = `Un atleta registra cómo le fue en el gimnasio. Lee TODO lo que escribió esta semana y saca,
por ejercicio, lo que declara de forma clara: con qué carga lo hizo de verdad y cuántas repeticiones.

Ejercicios de su rutina (usa estos nombres exactos):
${ejercicios}

Notas en cada ejercicio:
${deEjercicio}

Notas generales al cerrar la sesión (pueden mencionar cualquier ejercicio, con otras palabras):
${generales}

Lo que habló con el asistente:
${delChat}

Reglas:
- "peso": el número que usó, en la misma unidad que el prescrito. "Le subí a 80" → 80. "Le subí 15 a
  cada lado" con prescrito 90 lbs/lado → 105. Si hizo varias series con cargas distintas, la más alta
  con la que completó una serie de trabajo. Si sólo dice que bajó, el número al que bajó.
- "reps": las repeticiones que hizo con esa carga, si las dice.
- "rango": sólo si se queja de las repeticiones ("6 es poco", "12 es poco para pantorrilla"): el rango
  nuevo que tiene sentido para lo que hace, p. ej. [10, 14]. Mínimo 3, máximo 30.
- Una máquina distinta para el mismo movimiento cuenta igual (seated leg curl = curl femoral sentado).
- No inventes: sensaciones, molestias o la máquina ocupada no son declaraciones.

Devuelve SOLO un JSON array, vacío si no hay nada:
[{"nombre":"nombre exacto","peso":110,"reps":10,"rango":[10,14]}]
Omite los campos que no declare.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY,
                 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 1200,
                             messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      console.log(`[DECLARA] la API respondió ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
      return [];
    }
    const txt = textoDeRespuesta(data);
    const m = txt.match(/\[[\s\S]*\]/);
    if (!m) return [];
    return JSON.parse(m[0]).map(p => {
      if (!p || !p.nombre) return null;
      const ex = enRutina.get(p.nombre);
      if (!ex) return null;
      const out = { nombre: p.nombre };
      if (typeof p.peso === 'number' && isFinite(p.peso) && p.peso > 0) {
        const actual = numeroDePeso(ex.w1);
        // Un salto fuera de la cuarta parte o el cuádruple es un error de lectura
        if (actual && (p.peso < actual * 0.25 || p.peso > actual * 4)) console.log(`[DECLARA] peso descartado ${p.nombre}: ${p.peso} contra ${actual}`);
        else out.peso = p.peso;
      }
      if (Number.isInteger(p.reps) && p.reps >= 1 && p.reps <= 50) out.reps = p.reps;
      if (Array.isArray(p.rango) && p.rango.length === 2) {
        const [r1, r2] = p.rango.map(n => parseInt(n));
        if (r1 >= 3 && r2 <= 30 && r2 - r1 >= 2 && r2 - r1 <= 10) out.rango = [r1, r2];
      }
      return (out.peso || out.reps || out.rango) ? out : null;
    }).filter(Boolean);
  } catch (e) {
    console.log('[DECLARA] falló: ' + e.message);
    return [];
  }
}

/* Aplica lo declarado. Devuelve lo que cambió (para el resumen y el
   registro de fuerza) y qué ejercicios ya no deben progresar solos. */
function aplicarDeclaraciones(rutina, declarados) {
  const corregidos = [], cambios = [], fijados = new Set();
  for (const d of declarados) {
    for (const k of Object.keys(rutina)) {
      for (const c of (rutina[k].circuits || [])) {
        for (const ex of (c.exercises || [])) {
          if (ex.name !== d.nombre) continue;
          const antes = ex.w1, pesoAntes = numeroDePeso(ex.w1), repsAntes = parseInt(ex.repNow) || parseInt(ex.reps) || 0;
          if (d.rango) { ex.repMin = d.rango[0]; ex.repMax = d.rango[1]; }
          if (d.reps) {
            ex.repNow = d.reps;
            // Lo que hace manda sobre el rango: si se sale, el rango lo sigue
            if (!d.rango && ex.repMax && d.reps > ex.repMax) ex.repMax = d.reps;
            if (!d.rango && ex.repMin && d.reps < ex.repMin) ex.repMin = d.reps;
          } else if (d.rango) {
            ex.repNow = Math.min(Math.max(repsAntes || d.rango[0], d.rango[0]), d.rango[1]);
          }
          ex.reps = (parseInt(ex.repNow) || repsAntes) + ' reps';
          if (d.peso && Math.round(d.peso) !== Math.round(pesoAntes || 0)) {
            ex.w1 = escribePeso(d.peso, ex.unit);
            ex.fallos = 0;
            fijados.add(ex.name);
          }
          const repsDespues = parseInt(ex.repNow) || repsAntes;
          corregidos.push({ name: ex.name, de: antes, a: ex.w1, repsDe: repsAntes, repsA: repsDespues,
                            rango: d.rango ? d.rango.join('-') : null });
          const pesoDespues = numeroDePeso(ex.w1);
          cambios.push({
            name: ex.name, resp: null, motivo: 'lo anotaste tú', sesion: k, circuito: c.label || '',
            pesoAntes: escribePeso(pesoAntes, ex.unit), pesoDespues: escribePeso(pesoDespues, ex.unit),
            repsAntes, repsDespues,
            cambio: Math.round(pesoDespues) !== Math.round(pesoAntes) ? (pesoDespues > pesoAntes ? 'sube carga' : 'baja carga')
                  : repsDespues !== repsAntes ? (repsDespues > repsAntes ? 'sube reps' : 'baja reps') : 'sin cambio',
          });
        }
      }
    }
  }
  return { corregidos, cambios, fijados };
}

/* ── Resumen de la semana ─────────────────────────────────────────────
   Aquí la IA sí aporta: convierte una lista de cambios en algo que se lee.
   Con respaldo determinista, porque el resumen no puede depender de que
   una API responda. */

function resumenDeRespaldo(cambios, rotaciones) {
  const sube = cambios.filter(c => c.cambio === 'sube carga').length;
  const reps = cambios.filter(c => c.cambio === 'sube reps').length;
  const baja = cambios.filter(c => c.cambio === 'baja carga').length;
  const vol  = cambios.filter(c => c.cambio === 'baja series').length;
  const partes = [];
  if (sube) partes.push(`sube la carga en ${sube} ejercicio${sube === 1 ? '' : 's'}`);
  if (reps) partes.push(`suben las repeticiones en ${reps}`);
  if (baja) partes.push(`baja la carga en ${baja} donde no llegaste dos semanas seguidas`);
  if (vol)  partes.push(`se quita una serie en ${vol} circuito${vol === 1 ? '' : 's'}`);
  if (rotaciones && rotaciones.length) partes.push(rotaciones.length === 1
    ? 'y cambia un ejercicio que llevaba semanas sin moverse'
    : `y cambian ${rotaciones.length} ejercicios que llevaban semanas sin moverse`);
  if (!partes.length) return 'Esta semana la rutina se queda igual.';
  return 'Para la semana que viene ' + partes.join(', ') + '.';
}

async function resumenSemana(env, cambios, rotaciones, notas, señalados, corregidos, atleta) {
  const respaldo = resumenDeRespaldo(cambios, rotaciones);
  if (!env.ANTHROPIC_API_KEY || (!cambios.length && !(notas || []).length)) return respaldo;
  const p = (atleta && atleta.profile) || {};
  const nombre = String((atleta && atleta.name) || '').split(/\s+/)[0] || 'este atleta';
  const prompt = `Eres el entrenador de ${nombre} (${p.goal || 'hipertrofia'}, ${p.level || 'intermedio'}). Estos son los ajustes que el
sistema hizo a su rutina para la semana que viene, a partir de cómo marcó cada ejercicio:

${JSON.stringify(cambios.slice(0, 40), null, 1)}
${rotaciones && rotaciones.length ? 'Ejercicios cambiados:\n' + JSON.stringify(rotaciones, null, 1) : ''}
${(notas || []).length ? 'Lo que escribió al terminar cada sesión:\n' + notas.map(x => `- ${x.dia}: ${x.texto}`).join('\n') : ''}
${(señalados || []).some(x => x.dolor) ? 'Reportó molestia física en: ' + señalados.filter(x => x.dolor).map(x => x.name).join(', ') : ''}
${(corregidos || []).length ? 'Anotó que usó otra carga, y se tomó la suya como punto de partida:\n' + corregidos.map(c => `- ${c.name}: ${c.de} → ${c.a}`).join('\n') : ''}

Escríbele 2 o 3 frases diciéndole qué cambió y por qué. Directo y concreto, sin motivación de
cartel ni emojis. Si bajó carga en algo, dilo sin dramatizar: es parte del plan.

Si escribió notas, tenlas en cuenta y menciónalo cuando hayan cambiado algo — que vea que
sirvieron de algo. Si reportó una molestia física, dilo en una frase y dile que si sigue, lo mire
alguien; cambiar el ejercicio alivia el síntoma, no diagnostica. No alargues por eso.

Español de Colombia, tuteando: "subes", "sumas", "llegaste". NUNCA voseo rioplatense — nada de
"subís", "sumás", "tenés", "vos". No lo llames por su nombre, háblale directo.
Responde solo el texto.`;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY,
                 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 400,
                             messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      console.log(`[RESUMEN] la API respondió ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
      return respaldo;
    }
    const txt = textoDeRespuesta(data);
    return txt || respaldo;
  } catch (e) {
    console.log('[RESUMEN] falló, va el de respaldo: ' + e.message);
    return respaldo;
  }
}

/* Orquesta la semana: lee, progresa, guarda y deja registro.
   `motivo` sólo sirve para el log: 'viernes' o 'cron'. */
async function correrProgresion(env, clientId, motivo, completionsEnMano, rutinaEnMano, simular = false) {
  const atleta = await getAthlete(env, clientId);
  if (!esIA(atleta)) return { ok: false, razon: 'no tiene rutina autogestionada' };

  const semana = claveSemana(Date.now());
  const historial = await env.DB.get(`progresion:${clientId}`, 'json') || [];
  if (!simular && historial.some(h => h.semana === semana)) {
    return { ok: false, razon: 'ya se corrió esta semana', semana };
  }

  // KV es de consistencia eventual: al dispararse justo después de guardar la
  // sesión, releerla aquí devuelve la lista SIN la que se acaba de escribir y
  // el ajuste se salta en silencio. Quien ya las tiene en memoria las pasa.
  // Lo mismo con la rutina: si la sesión que la dispara acaba de calibrar
  // pesos, la versión buena es la que viene en mano.
  const [rutina, completionsLeidas] = await Promise.all([
    rutinaEnMano ? Promise.resolve(rutinaEnMano) : env.DB.get(`routine:${clientId}`, 'json'),
    completionsEnMano ? Promise.resolve(completionsEnMano) : env.DB.get(`completions:${clientId}`, 'json')
  ]);
  const completions = completionsEnMano || completionsLeidas;
  if (!rutina) return { ok: false, razon: 'sin rutina' };

  const hace7dias = Date.now() - 7 * 86400000;
  const marcas = marcasDeLaSemana(completions || [], hace7dias);
  const notas = notasDeLaSemana(completions || [], hace7dias);
  const notasEj = notasPorEjercicio(completions || [], hace7dias);
  if (!Object.keys(marcas).length) {
    return { ok: false, razon: 'ninguna sesión marcada esta semana', semana };
  }

  // Lo que habló con el asistente esta semana cuenta como sus notas
  const chatLog = await env.DB.get(`chatlog:${clientId}`, 'json') || [];
  const chat = chatLog.filter(x => (x.ts || 0) >= hace7dias);

  // Primero lo que de verdad hizo: si declaró otra carga o otras repeticiones
  // (en el ejercicio, en la nota general o en el chat), esa es la base.
  const declarados = await declaracionesDeLaSemana(env, rutina, notasEj, notas, chat);
  const { corregidos, cambios: cambiosDeclarados, fijados } = aplicarDeclaraciones(rutina, declarados);
  if (corregidos.length) {
    console.log(`[DECLARA] ${clientId}: ${corregidos.map(c => c.name + ' ' + c.de + '→' + c.a + ' ' + c.repsDe + '→' + c.repsA + 'r').join(', ')}`);
  }

  const perfil = perfilDeCarga(atleta);
  const cambios = [...cambiosDeclarados, ...progresarRutina(rutina, marcas, perfil, fijados)];

  // Lo que escribió esta semana puede pedir un cambio ya, sin esperar ciclo
  const notasYChat = [...notas, ...chat.filter(x => x.q).map(x => ({ dia: 'en el chat', texto: String(x.q).slice(0, 400) }))];
  const señalados = await ejerciciosSeñaladosEnNotas(env, rutina, notasYChat);
  const candidatos = señalados.map(x => ({ name: x.name, razon: 'molestia', detalle: x.detalle }));

  // Y cada 6 semanas, cambiar lo que lleva tiempo sin moverse
  const toca = historial.length > 0 && historial.length % SEMANAS_ENTRE_ROTACIONES === 0;
  if (toca) {
    for (const nm of ejerciciosEstancados(historial, 3)) {
      if (!candidatos.some(c => c.name === nm)) candidatos.push({ name: nm, razon: 'estancado' });
    }
  }

  let rotaciones = [];
  if (candidatos.length) {
    const propuestas = await proponerRotacion(env, rutina, candidatos.slice(0, 3), atleta);
    rotaciones = aplicarRotacion(rutina, propuestas, perfil);
    console.log(`[ROTACION] ${clientId}: ${candidatos.length} candidatos (${señalados.length} por notas), ${rotaciones.length} cambiados`);
  }

  // El calentamiento sale de los circuitos: si cambiaron, cambia con ellos
  for (const k of Object.keys(rutina)) {
    if (rutina[k] && Array.isArray(rutina[k].circuits)) Object.assign(rutina[k], calentamientoDelDia(rutina[k].circuits));
  }
  if (!simular) await env.DB.put(`routine:${clientId}`, JSON.stringify(rutina));

  const resumen = await resumenSemana(env, cambios, rotaciones, notasYChat, señalados, corregidos, atleta);
  const entrada = { semana, fecha: new Date().toISOString(), motivo, cambios, rotaciones, resumen,
                    notas: notas.length, corregidos,
                    molestias: señalados.filter(x => x.dolor).map(x => x.name) };
  historial.unshift(entrada);
  if (simular) return { ok: true, simulado: true, semana, declarados, cambios, rotaciones, resumen, chat: chat.length, rutina };
  await env.DB.put(`progresion:${clientId}`, JSON.stringify(historial.slice(0, 60)));

  console.log(`[PROGRESION] ${clientId} semana=${semana} motivo=${motivo} cambios=${cambios.length} rotaciones=${rotaciones.length}`);
  return { ok: true, semana, cambios, rotaciones, resumen };
}

/* ── Calibración ───────────────────────────────────────────────────────
   Los pesos de un plan nuevo son estimados. La primera vez que marca un
   ejercicio, si fue fácil o no llegó, el salto es doble y se aplica en el
   momento: esperar al sábado con una carga mal puesta es perder una
   semana. "Justo" confirma la carga y desde ahí sigue la progresión
   normal. Muta la rutina y marca el feedback usado (`cal`) para que el
   ajuste semanal no lo cuente dos veces. */
function calibrarConSesion(rutina, sessionKey, feedback) {
  const dia = rutina && rutina[sessionKey];
  if (!dia) return [];
  const hechos = [];
  for (const f of (feedback || [])) {
    if (!f || !f.resp) continue;
    let ex = null;
    for (const c of (dia.circuits || [])) for (const e of (c.exercises || [])) if (e.name === f.name) ex = e;
    if (!ex || !ex.calibrar) continue;
    const paso = parseInt(ex.step) || 5;
    const antes = numeroDePeso(ex.w1);
    // Sin peso escrito (un cambio de ejercicio que dejó la carga en blanco)
    // no hay de dónde saltar: eso lo fija su nota o el chat.
    if (!antes && !/barra sola/i.test(ex.w1 || '')) continue;
    let despues = antes;
    if (f.resp === 'facil') despues = antes + 2 * paso;
    else if (f.resp === 'fallo') despues = antes ? Math.max(paso, antes - 2 * paso) : 0;
    const nuevoW1 = despues > 0 ? escribePeso(despues, ex.unit) : ex.w1;
    // El mismo ejercicio en otros días (cuerpo completo) se calibra igual
    for (const k of Object.keys(rutina)) for (const c of (rutina[k].circuits || [])) for (const e of (c.exercises || [])) {
      if (e.name !== ex.name || !e.calibrar) continue;
      e.calibrar = false;
      e.fallos = 0;
      if (f.resp !== 'justo') e.w1 = nuevoW1;
    }
    if (f.resp !== 'justo') {
      f.cal = true;
      hechos.push({ name: ex.name, resp: f.resp, de: escribePeso(antes, ex.unit) || ex.w1, a: nuevoW1 });
    }
  }
  return hechos;
}

/* Formas de voseo que el modelo a veces cuela pese a pedirle tuteo */
const VOSEO = /(vos|tenés|podés|querés|sabés|hacés|sentís|sintás|llegás|llegués|marcás|entrenás|subís|bajás|necesitás|empezás|seguís|vas a poder vos|completás|ajustás|notás|descansás)/i;

/* La encuesta, en una frase para el modelo */
function describeEncuesta(enc) {
  const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const quien = enc.sexo === 'f' ? 'Mujer' : 'Hombre';
  return `${quien} de ${enc.edad} años, ${enc.peso} kg, ${(enc.estatura / 100).toFixed(2).replace('.', ',')} m. ` +
    `Experiencia: ${enc.nivel}. Objetivo: ${enc.objetivo}. ` +
    `${enc.dias.length} días (${ordenaDias(enc.dias).map(d => DIAS[d]).join(', ')}), sesiones de ${enc.minutos} min, ` +
    `${enc.lugar === 'casa' ? 'en casa con mancuernas y un banco' : 'en gimnasio'}.` +
    (enc.molestias.length ? ` Molestias: ${enc.molestias.join(', ')}.` : '') +
    (enc.molestiaTexto ? ` En sus palabras: "${enc.molestiaTexto}".` : '');
}

/* La IA elige un ejercicio por hueco entre candidatos ya filtrados y
   escribe la explicación. Si tarda o falla, el plan se arma igual con la
   elección del código y una explicación de respaldo. */
async function elegirConIA(env, enc) {
  if (!env.ANTHROPIC_API_KEY) return { elecciones: null, explicacion: null };
  const fichas = fichasParaIA(enc);
  const prompt = `Eres un entrenador de fuerza armando el primer plan de una persona nueva.

${describeEncuesta(enc)}

La estructura ya está decidida (días, circuitos, músculos). Para cada hueco elige UN ejercicio de su
lista "candidatos". Los candidatos ya están filtrados por su lugar, su experiencia y sus molestias, y
vienen ordenados de más básico a menos: prefiere los primeros salvo que haya una razón.
 - En un mismo día no repitas ejercicio.
 - Si un músculo se repite en la semana, varía el ángulo o el aparato entre días.
 - Si contó una molestia con sus palabras, evita lo que pueda cargarla.

${JSON.stringify(fichas)}

Responde SOLO un JSON, sin texto alrededor:
{"sesiones":[["ejercicio del hueco 0","ejercicio del hueco 1", ...], ...],
 "explicacion":"..."}
"sesiones" lleva una lista por sesión, en orden, con un nombre por hueco copiado letra por letra.
"explicacion": 3 o 4 frases para la persona. Qué tipo de plan es y por qué encaja con lo que contó, y
que la primera semana los pesos son un punto de partida que se corrige con lo que marque en cada
ejercicio (fácil, justo, no llegué). Español de Colombia, tuteando: "entrenas", "marcas", "llegas",
"sientes", "puedes". NUNCA voseo rioplatense: nada de "llegás", "sentís", "sintás", "podés", "tenés",
"vos". Sin emojis ni frases de cartel motivacional. No uses su nombre.`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY,
                 'anthropic-version': '2023-06-01' },
      // Elegir entre candidatos ya filtrados no necesita razonamiento largo:
      // con el modelo que piensa primero, el razonamiento se comía los
      // tokens y la respuesta llegaba vacía.
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 3000,
                             messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      console.log(`[PLAN] la API respondió ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
      return { elecciones: null, explicacion: null };
    }
    const txt = textoDeRespuesta(data);
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) { console.log(`[PLAN] respuesta sin JSON (stop=${data.stop_reason}): ` + txt.slice(0, 200)); return { elecciones: null, explicacion: null }; }
    const j = JSON.parse(m[0]);
    const elecciones = Array.isArray(j.sesiones) ? j.sesiones.map(x => Array.isArray(x) ? x.map(String) : []) : null;
    let explicacion = typeof j.explicacion === 'string' ? j.explicacion.trim().slice(0, 900) : null;
    // Si aun así se le escapa el voseo, va la explicación de respaldo
    if (explicacion && VOSEO.test(explicacion)) {
      console.log('[PLAN] explicación con voseo, va la de respaldo: ' + explicacion.slice(0, 120));
      explicacion = null;
    }
    return { elecciones, explicacion };
  } catch (e) {
    console.log('[PLAN] la IA no eligió, elige el código: ' + e.message);
    return { elecciones: null, explicacion: null };
  } finally {
    clearTimeout(t);
  }
}

// Authorize a read of a specific athlete's private data (routine, completions,
// meals, payment, etc.). Accepts: admin token, trainer-owner token, or self-token.
// Returns null if authorized, else a Response.
async function authorizeReadForClient(env, body, clientId, corsHeaders) {
  if (!clientId) {
    return new Response(JSON.stringify({ ok: false, error: 'Falta clientId' }), { headers: corsHeaders, status: 400 });
  }
  if (body.admin === 'admin2026') return null;
  if (body.selfToken) {
    const ok = await verifySelfToken(env, clientId, body.selfToken);
    if (ok) return null;
  }
  if (body.token === 'ent2026' && body.trainerUsername) {
    const athlete = await getAthlete(env, clientId);
    if (athlete && athlete.trainerId === body.trainerUsername) return null;
  }
  return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { headers: corsHeaders, status: 401 });
}

// Authorize a trainer operation on an athlete: caller must provide token +
// trainerUsername, and the athlete's trainerId must match trainerUsername.
// Returns null if authorized, else a Response with the appropriate error.
async function authorizeTrainerForAthlete(env, body, corsHeaders) {
  if (body.token !== 'ent2026') {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { headers: corsHeaders, status: 401 });
  }
  const trainerUsername = body.trainerUsername;
  if (!trainerUsername) {
    return new Response(JSON.stringify({ ok: false, error: 'Falta trainerUsername' }), { headers: corsHeaders, status: 400 });
  }
  const clientId = body.clientId || body.client;
  if (!clientId) {
    return new Response(JSON.stringify({ ok: false, error: 'Falta clientId' }), { headers: corsHeaders, status: 400 });
  }
  const athlete = await getAthlete(env, clientId);
  if (!athlete) {
    return new Response(JSON.stringify({ ok: false, error: 'Atleta no encontrado' }), { headers: corsHeaders, status: 404 });
  }
  if (athlete.trainerId && athlete.trainerId !== trainerUsername) {
    return new Response(JSON.stringify({ ok: false, error: 'Este atleta no te pertenece' }), { headers: corsHeaders, status: 403 });
  }
  // Sin trainerId pasaba cualquier entrenador: con las cuentas abiertas,
  // eso dejaría a cualquiera tocar la rutina de un desconocido.
  if (sinEntrenador(athlete)) {
    return new Response(JSON.stringify({ ok: false, error: 'Esta cuenta se gestiona con IA' }), { headers: corsHeaders, status: 403 });
  }
  return null;
}

// Authorize access to a support-chat thread. Threads are keyed by trainerId:
// admin can reach any thread; a trainer only their own. Returns null if
// authorized, else a Response.
function authorizeSupportChat(env, body, corsHeaders) {
  if (body.admin === 'admin2026') return null;
  const threadId = body.trainerId;
  if (body.token === 'ent2026' && body.trainerUsername && body.trainerUsername === threadId) return null;
  return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { headers: corsHeaders, status: 401 });
}

function slugifyUsername(name) {
  return (name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 20) || `user${Date.now().toString(36).slice(-5)}`;
}

function emptyRoutineTemplate(sessionsPerWeek) {
  const n = Math.max(1, Math.min(7, Number(sessionsPerWeek) || 4));
  const out = {};
  for (let i = 1; i <= n; i++) {
    out[`sesion${i}`] = {
      title: `Sesión ${i}`,
      sub: '',
      warmup: null,
      warmupHombro: null,
      cardio: '',
      circuits: []
    };
  }
  return out;
}

// ── Helper: week range (Mon–Sat) in Colombia timezone ──
function getWeekRange(dateStr) {
  // dateStr = 'YYYY-MM-DD' or null (defaults to today Colombia)
  let d;
  if (dateStr) {
    const [y, m, day] = dateStr.split('-').map(Number);
    d = new Date(y, m - 1, day);
  } else {
    const now = new Date();
    d = new Date(now.toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  }
  // Find Monday: getDay() 0=Sun,1=Mon...6=Sat
  const dow = d.getDay();
  const diffToMon = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(d);
  mon.setDate(d.getDate() + diffToMon);

  const dates = [];
  const fmt = (dt) => `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
  const fmtShort = (dt) => `${dt.getDate()} ${['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'][dt.getMonth()]}`;

  for (let i = 0; i < 6; i++) { // Mon-Sat
    const dd = new Date(mon);
    dd.setDate(mon.getDate() + i);
    dates.push(fmt(dd));
  }
  const sat = new Date(mon);
  sat.setDate(mon.getDate() + 5);

  return {
    monday: dates[0],
    saturday: dates[5],
    dates,
    label: `${fmtShort(mon)} – ${fmtShort(sat)} ${sat.getFullYear()}`
  };
}

function getMondayForDate(dateStr) {
  const [y, m, day] = dateStr.split('-').map(Number);
  const d = new Date(y, m - 1, day);
  const dow = d.getDay();
  const diffToMon = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diffToMon);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function parseMacros(analysisText) {
  if (!analysisText) return null;
  const cals = analysisText.match(/CALOR[ÍI]AS:\s*~?(\d+)/i);
  const prot = analysisText.match(/PROTE[ÍI]NA:\s*~?(\d+)/i);
  const carbs = analysisText.match(/CARBOS:\s*~?(\d+)/i);
  const fat = analysisText.match(/GRASAS:\s*~?(\d+)/i);
  if (!cals) return null;
  return {
    cals: parseInt(cals[1]),
    prot: prot ? parseInt(prot[1]) : 0,
    carbs: carbs ? parseInt(carbs[1]) : 0,
    fat: fat ? parseInt(fat[1]) : 0
  };
}

export default {
  async fetch(request, env, ctx) {
    // Serve static assets for non-POST requests
    if (request.method !== 'POST' && request.method !== 'OPTIONS') {
      return env.ASSETS.fetch(request);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json'
    };

    const MEAL_SLOTS = [
      { key: 'desayuno',     label: 'Desayuno',      icon: '☀️' },
      { key: 'mediasNueves', label: 'Medias nueves',  icon: '🍎' },
      { key: 'almuerzo',     label: 'Almuerzo',       icon: '🍽️' },
      { key: 'onces',        label: 'Onces',          icon: '☕' },
      { key: 'comida',       label: 'Cena',           icon: '🌙' }
    ];

    // ── UPLOAD PHOTO ──
    const url = new URL(request.url);
    if (url.pathname === '/upload-photo') {
      const formData = await request.formData();
      const file = formData.get('photo');
      const folder = (formData.get('folder') || 'meals').toString().replace(/[^a-z0-9_\-]/gi, '');
      const key = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
      await env.PHOTOS.put(key, file.stream(), {
        httpMetadata: { contentType: file.type || 'image/jpeg' }
      });
      const publicUrl = `https://pub-b674ba0042be4917ad022c23faf247d9.r2.dev/${key}`;
      return new Response(JSON.stringify({ ok: true, url: publicUrl }), { headers: cors });
    }

    // ── UPLOAD PDF (onboarding docs for new athletes) ──
    if (url.pathname === '/upload-pdf') {
      const formData = await request.formData();
      const file = formData.get('pdf');
      if (!file) return new Response(JSON.stringify({ ok:false, error:'missing file' }), { headers: cors });
      const key = `onboarding/${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`;
      await env.PHOTOS.put(key, file.stream(), {
        httpMetadata: { contentType: file.type || 'application/pdf' }
      });
      const publicUrl = `https://pub-b674ba0042be4917ad022c23faf247d9.r2.dev/${key}`;
      return new Response(JSON.stringify({ ok: true, url: publicUrl }), { headers: cors });
    }

    const body = await request.json();
    const client = body.client || '';
    const athleteRecord = client ? await getAthlete(env, client) : null;
    const athleteName = athleteRecord?.name || client;

    // ── ATHLETE LOGIN (issue a selfToken so the athlete can write own data) ──
    if (body.action === 'athlete-login') {
      const username = (body.username || '').trim().toLowerCase();
      if (!username) {
        return new Response(JSON.stringify({ ok: false, error: 'Falta username' }), { headers: cors });
      }
      // Atajo: en la mayoría de casos el username coincide con el clientId, así
      // que se intenta una única lectura antes de recorrer el índice completo.
      let match = await getAthlete(env, username);
      if (match && (match.archived || (match.username || match.clientId) !== username)) match = null;
      if (!match) {
        const all = await listAthletes(env);
        match = all.find(a => (a.username || a.clientId) === username);
      }
      if (!match) {
        return new Response(JSON.stringify({ ok: false, error: 'Usuario no encontrado' }), { headers: cors });
      }
      const selfToken = await computeSelfToken(env, match.clientId);
      return new Response(JSON.stringify({
        ok: true,
        athlete: {
          clientId: match.clientId, username: match.username, name: match.name,
          photoUrl: match.photoUrl || null, trainerId: match.trainerId || null,
          sessionsPerWeek: match.sessionsPerWeek || null,
          profile: match.profile || {},
          modo: esIA(match) ? 'ia' : 'entrenador',
          trainingDays: Array.isArray(match.trainingDays) ? match.trainingDays : null,
        },
        selfToken
      }), { headers: cors });
    }

    // ── COMPLETE ROUTINE ──
    if (body.action === 'complete') {
      // Solo el propio atleta (o su trainer / admin) puede marcar completado.
      const authErr = await authorizeReadForClient(env, body, client, cors);
      if (authErr) return authErr;
      const nowCO = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
      const isoDate = `${nowCO.getFullYear()}-${String(nowCO.getMonth()+1).padStart(2,'0')}-${String(nowCO.getDate()).padStart(2,'0')}`;

      // Snapshot de la sesión tal como está en KV al momento de completar.
      const routine = await env.DB.get(`routine:${client}`, 'json') || {};
      const raw = routine[body.day] || null;
      const snapshot = raw ? {
        title: raw.title || '',
        sub: raw.sub || '',
        warmup: Array.isArray(raw.warmup) ? raw.warmup : null,
        warmupHombro: Array.isArray(raw.warmupHombro) ? raw.warmupHombro : null,
        warmupSeries: raw.warmupSeries || null,
        cardio: raw.cardio || '',
        circuits: (raw.circuits || []).map(c => ({
          label: c.label || '',
          rest: c.rest || '',
          series: c.series || null,
          exercises: (c.exercises || []).map(e => ({
            name: e.name || '',
            muscle: e.muscle || '',
            reps: e.reps || '',
            w1: e.w1 || '',
            setType: e.setType || 'normal',
            steps1: Array.isArray(e.steps1) ? e.steps1 : [],
            trainerNote: e.trainerNote || ''
          }))
        }))
      } : null;

      const entry = {
        day: isoDate,
        dayLabel: body.dayLabel,
        sessionKey: body.day,
        week: body.week,
        notes: body.notes,
        // Cómo fue cada ejercicio: de aquí sale la progresión de la semana
        // Puede haber nota sin marca: la nota sola también es información
        feedback: Array.isArray(body.feedback)
          ? body.feedback
              .filter(f => f && f.name && (['facil','justo','fallo'].includes(f.resp) || String(f.nota || '').trim()))
              .map(f => ({
                ci: parseInt(f.ci) || 0,
                name: String(f.name).slice(0, 120),
                resp: ['facil','justo','fallo'].includes(f.resp) ? f.resp : null,
                nota: String(f.nota || '').trim().slice(0, 400),
              }))
          : [],
        date: new Date().toLocaleDateString('es-CO', { day:'2-digit', month:'2-digit', year:'numeric' }),
        ts: Date.now(),
        snapshot
      };

      const kvKey = `completions:${client}`;
      let records = await env.DB.get(kvKey, 'json') || [];
      // Dedup: si ya hay una completion hoy, no re-agregamos (evita doble-click).
      if (records.some(r => r.day === isoDate)) {
        return new Response(JSON.stringify({ ok: true, duplicate: true }), { headers: cors });
      }
      // Cuenta con IA: los pesos estimados se calibran con la primera marca.
      // Va antes de guardar la sesión para que quede anotado qué marcas ya
      // se usaron (f.cal) y el sábado no cuenten dos veces.
      const ia = esIA(athleteRecord);
      let calibrados = [];
      if (ia && entry.feedback.length) {
        calibrados = calibrarConSesion(routine, body.day, entry.feedback);
        if (calibrados.length) {
          await env.DB.put(`routine:${client}`, JSON.stringify(routine));
          console.log(`[CALIBRA] ${client}: ${calibrados.map(c => c.name + ' ' + c.de + '→' + c.a).join(', ')}`);
        }
      }

      records.unshift(entry);
      if (records.length > 200) records = records.slice(0, 200);
      await env.DB.put(kvKey, JSON.stringify(records));

      // Rutina autogestionada: al cerrar la última sesión de la semana se
      // recalcula la siguiente. Si esta semana no se llegó a la última, lo
      // recoge el cron del sábado.
      const ultimaSesion = 'sesion' + Object.keys(routine).filter(k => /^sesion\d+$/.test(k)).length;
      if (ia && body.day === ultimaSesion) {
        ctx.waitUntil(correrProgresion(env, client, 'ultima-sesion', records, calibrados.length ? routine : null).catch(e =>
          console.log('[PROGRESION] falló al cerrar la semana: ' + e.message)));
      }
      // Una cuenta con IA sin entrenador no le escribe a nadie
      if (sinEntrenador(athleteRecord)) {
        return new Response(JSON.stringify({ ok: true, calibrados }), { headers: cors });
      }

      // ── Email detallado ──
      const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const muscleLabel = m => {
        if (!m) return '';
        const map = { isquio:'Isquio', cuadriceps:'Cuádriceps', gluteo:'Glúteo', pantorrilla:'Pantorrilla',
          trapecio:'Trapecio', hombros:'Hombros', pecho:'Pecho', espalda:'Espalda',
          triceps:'Tríceps', biceps:'Bíceps', abdomen:'Abdomen' };
        return map[m] || m.charAt(0).toUpperCase() + m.slice(1);
      };
      const renderWarmupBlock = (snap) => {
        const hom = Array.isArray(snap.warmupHombro) ? snap.warmupHombro : [];
        const wu  = Array.isArray(snap.warmup) ? snap.warmup : [];
        const all = [...hom, ...wu];
        if (!all.length) return '';
        const n = parseInt(snap.warmupSeries) || 2;
        const rows = all.map(it => {
          const obj = (typeof it === 'object' && it) ? it : { text: String(it||'') };
          const name = obj.text || obj.name || '';
          const w = obj.w || '';
          const r = obj.reps || '';
          return `<tr>
            <td style="padding:6px 10px;border-bottom:1px solid #2d3148;color:#e2e8f0;font-size:13px">${esc(name)}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #2d3148;color:#94a3b8;font-size:12px;text-align:right;white-space:nowrap">${esc(w)} · ${esc(r)}</td>
          </tr>`;
        }).join('');
        return `<tr><td height="16"></td></tr>
        <tr><td bgcolor="#1e2130" style="background:#1e2130;border:1px solid #2d3148;border-radius:12px;padding:16px 18px">
          <div style="font-size:11px;font-weight:700;color:#fbbf24;letter-spacing:1px;margin-bottom:8px">🔥 CALENTAMIENTO · ${n} vuelta${n===1?'':'s'}</div>
          <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
        </td></tr>`;
      };
      // Cómo marcó cada ejercicio y qué anotó: es lo que el entrenador necesita
      // para ajustar, ahora que el atleta lo registra en la app
      const MARCA = { facil: ['Fácil', '#30D158'], justo: ['Justo', '#A996FF'], fallo: ['No llegué', '#FF6961'] };
      const fbDe = (idx, nombre) => (entry.feedback || []).find(f => f.name === nombre && f.ci === idx)
                                  || (entry.feedback || []).find(f => f.name === nombre);
      const renderCircuitBlock = (c, idx) => {
        const nSeries = parseInt(c.series) || 4;
        const restSec = parseInt(c.rest) || 60;
        const exRows = (c.exercises || []).map(ex => {
          const f = fbDe(idx, ex.name);
          const marcaHtml = f && MARCA[f.resp]
            ? `<span style="display:inline-block;font-size:11px;font-weight:700;color:${MARCA[f.resp][1]};border:1px solid ${MARCA[f.resp][1]};border-radius:10px;padding:2px 8px;margin-left:6px;vertical-align:middle">${MARCA[f.resp][0]}</span>` : '';
          const notaAtletaHtml = f && f.nota
            ? `<div style="margin-top:6px;padding:6px 10px;background:rgba(169,150,255,.10);border-left:2px solid #A996FF;border-radius:4px;font-size:12px;color:#ddd6fe;line-height:1.4">✍️ ${esc(f.nota)}</div>` : '';
          const st = ex.setType || 'normal';
          let wrHtml;
          if (st !== 'normal' && Array.isArray(ex.steps1) && ex.steps1.length) {
            const stepsText = ex.steps1.map(s => `${esc(s.w||'—')}·${esc(s.reps||'—')}`).join(' → ');
            wrHtml = `<div style="font-size:11px;color:#fbbf24;margin-top:2px">${st.toUpperCase()}: ${stepsText}</div>`;
          } else {
            wrHtml = `<div style="font-size:12px;color:#94a3b8;margin-top:2px">${esc(ex.w1||'—')} · ${esc(ex.reps||'—')}</div>`;
          }
          const noteHtml = ex.trainerNote
            ? `<div style="margin-top:6px;padding:6px 10px;background:rgba(251,191,36,.08);border-left:2px solid #fbbf24;border-radius:4px;font-size:12px;color:#fde68a;line-height:1.4">📌 ${esc(ex.trainerNote)}</div>`
            : '';
          const muscleChip = ex.muscle
            ? `<span style="display:inline-block;font-size:10px;color:#94a3b8;background:#0f1117;border:1px solid #2d3148;border-radius:10px;padding:2px 8px;margin-left:6px;vertical-align:middle">${esc(muscleLabel(ex.muscle))}</span>`
            : '';
          return `<tr><td style="padding:10px 0;border-bottom:1px solid #2d3148">
            <div style="font-size:14px;font-weight:600;color:#e2e8f0">${esc(ex.name)}${muscleChip}${marcaHtml}</div>
            ${wrHtml}
            ${notaAtletaHtml}
            ${noteHtml}
          </td></tr>`;
        }).join('');
        return `<tr><td height="12"></td></tr>
        <tr><td bgcolor="#1e2130" style="background:#1e2130;border:1px solid #2d3148;border-radius:12px;padding:16px 18px">
          <div style="font-size:11px;font-weight:700;color:#818cf8;letter-spacing:1px;margin-bottom:4px">CIRCUITO ${idx+1}${c.label && c.label !== `Circuito ${idx+1}` ? ` · ${esc(c.label)}` : ''}</div>
          <div style="font-size:11px;color:#94a3b8;margin-bottom:10px">${nSeries} serie${nSeries===1?'':'s'} · ${restSec}s descanso</div>
          <table width="100%" cellpadding="0" cellspacing="0">${exRows || '<tr><td style="font-size:12px;color:#64748b;padding:6px 0">Sin ejercicios cargados.</td></tr>'}</table>
        </td></tr>`;
      };
      const warmupHtml = snapshot ? renderWarmupBlock(snapshot) : '';
      const circuitsHtml = snapshot ? (snapshot.circuits || []).map(renderCircuitBlock).join('') : '';
      const cardioHtml = snapshot && snapshot.cardio
        ? `<tr><td height="12"></td></tr>
        <tr><td bgcolor="#1e2130" style="background:#1e2130;border:1px solid #2d3148;border-left:3px solid #34d399;border-radius:12px;padding:14px 18px">
          <div style="font-size:11px;font-weight:700;color:#34d399;letter-spacing:1px;margin-bottom:4px">🏃 CARDIO FINAL</div>
          <div style="font-size:13px;color:#cbd5e1">${esc(snapshot.cardio)}</div>
        </td></tr>` : '';
      const notesHtml = body.notes
        ? `<tr><td height="12"></td></tr>
        <tr><td bgcolor="#1e2130" style="background:#1e2130;border:1px solid #2d3148;border-left:3px solid #34d399;border-radius:12px;padding:14px 18px">
          <div style="font-size:11px;font-weight:700;color:#34d399;letter-spacing:1px;margin-bottom:6px">📝 NOTA DEL ATLETA</div>
          <div style="font-size:14px;color:#cbd5e1;line-height:1.5">${esc(body.notes)}</div>
        </td></tr>` : '';
      const sessionTitleHtml = snapshot && snapshot.title
        ? `<tr><td height="12"></td></tr>
        <tr><td style="padding:0 4px">
          <div style="font-size:18px;font-weight:700;color:#e2e8f0">${esc(snapshot.title)}</div>
          ${snapshot.sub ? `<div style="font-size:12px;color:#94a3b8;margin-top:2px">${esc(snapshot.sub)}</div>` : ''}
        </td></tr>` : '';

      const emailHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0" bgcolor="#0f1117">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#0f1117" style="background:#0f1117;font-family:-apple-system,Helvetica,sans-serif">
  <tr><td align="center" style="padding:24px 16px">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">

      <tr><td style="background:linear-gradient(135deg,#059669,#34d399);border-radius:16px;padding:24px">
        <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:rgba(255,255,255,.7);text-transform:uppercase;margin-bottom:6px">Rutina completada</div>
        <div style="font-size:26px;font-weight:800;color:#fff">✅ ${esc(body.dayLabel || body.day)}</div>
        <div style="font-size:13px;color:rgba(255,255,255,.8);margin-top:4px">${entry.date} · ${esc(athleteName)}</div>
      </td></tr>

      ${sessionTitleHtml}
      ${warmupHtml}
      ${circuitsHtml}
      ${cardioHtml}
      ${notesHtml}

    </table>
  </td></tr>
</table>
</body></html>`;

      if (env.RESEND_API_KEY) {
        const trainerEmail = await resolveTrainerEmail(env, athleteRecord);
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Mi Rutina <noreply@mirutinapp.com>',
            to: trainerEmail,
            subject: `✅ ${athleteName} completó: ${body.dayLabel || body.day}`,
            html: emailHtml
          })
        }).catch(err => console.error('complete email failed:', err?.message));
      }

      return new Response(JSON.stringify({ ok: true }), { headers: cors });
    }

    // ── MEALS ──
    if (body.action === 'meals') {
      const authErr = await authorizeReadForClient(env, body, client, cors);
      if (authErr) return authErr;
      const slot = body.slot; // single slot being submitted
      const photoUrl = body.photos?.[slot];
      let analysis = null;

      // Analyze photo if present
      if (photoUrl) {
        try {
          const imgRes = await fetch(photoUrl);
          const imgBuf = await imgRes.arrayBuffer();
          const bytes = new Uint8Array(imgBuf);
          let b64 = '';
          const chunkSize = 8192;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            b64 += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
          }
          const base64 = btoa(b64);
          const mediaType = imgRes.headers.get('content-type') || 'image/jpeg';

          const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 300,
              messages: [{
                role: 'user',
                content: [
                  { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
                  { type: 'text', text: `Analiza esta foto de comida para un atleta de hipertrofia muscular. Responde SOLO en texto plano, sin markdown, sin asteriscos, con este formato exacto:\nCALORÍAS: ~XXX kcal\nPROTEÍNA: ~XXg\nCARBOS: ~XXg\nGRASAS: ~XXg\nDETALLE: descripción breve de los alimentos y si es adecuado para el objetivo.` }
                ]
              }]
            })
          });

          const claudeData = await claudeRes.json();
          const rawText = claudeData.content?.[0]?.text || '';
          analysis = rawText.replace(/\*\*/g, '').replace(/^#+\s*/gm, '');
        } catch(e) {
          analysis = 'No se pudo analizar la foto.';
        }
      }

      // Upsert: find today's record or create new
      const kvKey = `meals:${client}`;
      let records = await env.DB.get(kvKey, 'json') || [];
      const todayIdx = records.findIndex(r => r.day === body.day);
      const dateStr = new Date().toLocaleDateString('es-CO', { day:'2-digit', month:'2-digit', year:'numeric' });

      if (todayIdx >= 0) {
        // Merge slot into existing record
        records[todayIdx].meals  = { ...records[todayIdx].meals,    [slot]: body.meals?.[slot] || '' };
        records[todayIdx].photos = { ...records[todayIdx].photos,   [slot]: body.photos?.[slot] || '' };
        records[todayIdx].analyses = { ...records[todayIdx].analyses, ...(analysis ? { [slot]: analysis } : {}) };
        records[todayIdx].dayLabel = body.dayLabel;
        records[todayIdx].ts = Date.now();
      } else {
        records.unshift({
          day: body.day,
          dayLabel: body.dayLabel,
          meals: { [slot]: body.meals?.[slot] || '' },
          photos: { [slot]: body.photos?.[slot] || '' },
          analyses: analysis ? { [slot]: analysis } : {},
          date: dateStr,
          ts: Date.now()
        });
      }
      if (records.length > 200) records = records.slice(0, 200);
      await env.DB.put(kvKey, JSON.stringify(records));

      // No email per meal — daily report sent at 10 PM via cron

      return new Response(JSON.stringify({ ok: true, analysis }), { headers: cors });
    }

    // ── GET DATA ──
    if (body.action === 'get-data') {
      const authErr = await authorizeReadForClient(env, body, client, cors);
      if (authErr) return authErr;
      const [completions, meals, athlete] = await Promise.all([
        env.DB.get(`completions:${client}`, 'json'),
        env.DB.get(`meals:${client}`, 'json'),
        env.DB.get(`athlete:${client}`, 'json')
      ]);
      return new Response(JSON.stringify({
        ok: true,
        completions: completions || [],
        meals: meals || [],
        sessionOffset: athlete?.sessionOffset || 0
      }), { headers: cors });
    }

    // ── GET WEEKLY SUMMARY ──
    if (body.action === 'get-weekly-summary') {
      const authErr = await authorizeReadForClient(env, body, client, cors);
      if (authErr) return authErr;
      const week = getWeekRange(body.weekOf || null);
      const dateSet = new Set(week.dates);

      const [completions, meals] = await Promise.all([
        env.DB.get(`completions:${client}`, 'json'),
        env.DB.get(`meals:${client}`, 'json')
      ]);
      const allCompletions = completions || [];
      const allMeals = meals || [];

      // Filter this week
      const weekCompletions = allCompletions.filter(r => dateSet.has(r.day));
      const weekMeals = allMeals.filter(r => dateSet.has(r.day));

      // Aggregate macros
      const totals = { cals: 0, prot: 0, carbs: 0, fat: 0, count: 0 };
      for (const meal of weekMeals) {
        if (!meal.analyses) continue;
        for (const slotKey of Object.keys(meal.analyses)) {
          const macros = parseMacros(meal.analyses[slotKey]);
          if (macros) {
            totals.cals += macros.cals;
            totals.prot += macros.prot;
            totals.carbs += macros.carbs;
            totals.fat += macros.fat;
            totals.count++;
          }
        }
      }

      // Available weeks (distinct Mondays from all data)
      const mondaySet = new Set();
      for (const r of allCompletions) { if (r.day) mondaySet.add(getMondayForDate(r.day)); }
      for (const r of allMeals) { if (r.day) mondaySet.add(getMondayForDate(r.day)); }
      // Always include the requested week and the current week so the
      // navigator buttons (◀ ▶) stay enabled even on weeks with no data
      mondaySet.add(week.monday);
      mondaySet.add(getWeekRange(null).monday);
      const availableWeeks = [...mondaySet].sort().reverse();

      return new Response(JSON.stringify({
        ok: true,
        weekLabel: week.label,
        monday: week.monday,
        completions: weekCompletions,
        meals: weekMeals,
        totals,
        availableWeeks
      }), { headers: cors });
    }

    // ── GET ROUTINE ──
    // ── AJUSTAR CARGA DE UN EJERCICIO ──
    // El chat propone; esto lo confirma. Va aparte porque la rama del chat
    // no tiene credencial y aquí sí se escribe la rutina.
    if (body.action === 'ajustar-peso') {
      const esElMismo = body.selfToken && await verifySelfToken(env, client, body.selfToken);
      if (!esElMismo) {
        return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { headers: cors, status: 401 });
      }
      const nombre = String(body.ejercicio || '').slice(0, 120);
      const peso = Number(body.peso);
      if (!nombre || !isFinite(peso) || peso <= 0 || peso > 2000) {
        return new Response(JSON.stringify({ ok: false, error: 'Datos inválidos' }), { headers: cors, status: 400 });
      }
      const rutina = await env.DB.get(`routine:${client}`, 'json');
      if (!rutina) return new Response(JSON.stringify({ ok: false, error: 'Sin rutina' }), { headers: cors });

      let tocado = null;
      for (const k of Object.keys(rutina)) {
        for (const c of (rutina[k].circuits || [])) {
          for (const ex of (c.exercises || [])) {
            if (ex.name !== nombre) continue;
            const actual = numeroDePeso(ex.w1);
            // Un salto fuera de la cuarta parte o el cuádruple es un error,
            // no una decisión de entrenamiento.
            if (actual && (peso < actual * 0.25 || peso > actual * 4)) {
              tocado = { rechazado: true, actual };
              continue;
            }
            const de = ex.w1;
            ex.w1 = escribePeso(peso, ex.unit);
            tocado = { name: ex.name, w1: ex.w1, de };
          }
        }
      }
      if (!tocado) {
        return new Response(JSON.stringify({ ok: false, error: 'Ese ejercicio no está en tu rutina' }), { headers: cors });
      }
      if (tocado.rechazado) {
        console.log(`[PESO] descartado ${nombre}: ${peso} contra ${tocado.actual}`);
        return new Response(JSON.stringify({ ok: false, error: 'Ese salto no cuadra con tu carga actual' }), { headers: cors });
      }
      await env.DB.put(`routine:${client}`, JSON.stringify(rutina));
      await guardaEnChatLog(env, client, { tipo: 'peso', name: nombre, de: tocado.de || '', a: tocado.w1 });
      console.log(`[PESO] ${client}: ${nombre} → ${tocado.w1}`);
      return new Response(JSON.stringify({ ok: true, w1: tocado.w1 }), { headers: cors });
    }

    // Último ajuste semanal, para que el atleta vea qué cambió y por qué
    // Ensayo del ajuste semanal con los datos reales: qué cambiaría, sin
    // guardar nada. Sólo el administrador.
    if (body.action === 'simular-progresion') {
      if (body.admin !== 'admin2026') return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { headers: cors, status: 401 });
      const r = await correrProgresion(env, client, 'simulacion', null, null, true);
      return new Response(JSON.stringify(r), { headers: cors });
    }

    if (body.action === 'get-progresion') {
      const authErr = await authorizeReadForClient(env, body, client, cors);
      if (authErr) return authErr;
      const historial = await env.DB.get(`progresion:${client}`, 'json') || [];
      // La app arma el registro de fuerza con el historial entero: cada ajuste
      // guarda el peso antes y después de cada ejercicio, así que de ahí sale
      // la serie de semanas sin tener que guardarla aparte.
      return new Response(JSON.stringify({
        ok: true,
        ultima: historial[0] || null,
        historial: historial.slice(0, 26).map(h => ({
          semana: h.semana, fecha: h.fecha,
          cambios: (h.cambios || []).map(c => ({
            name: c.name, pesoAntes: c.pesoAntes, pesoDespues: c.pesoDespues,
            repsAntes: c.repsAntes, repsDespues: c.repsDespues, cambio: c.cambio,
          })),
          rotaciones: (h.rotaciones || []).map(r => ({ de: r.de, a: r.a })),
        })),
      }), { headers: cors });
    }

    if (body.action === 'get-routine') {
      const authErr = await authorizeReadForClient(env, body, client, cors);
      if (authErr) return authErr;
      const routine = await env.DB.get(`routine:${client}`, 'json');
      return new Response(JSON.stringify({ ok: true, routine: routine || null }), { headers: cors });
    }

    // ── SAVE ROUTINE ──
    if (body.action === 'save-routine') {
      const authErr = await authorizeTrainerForAthlete(env, { ...body, clientId: client }, cors);
      if (authErr) return authErr;
      const routine = body.routine || {};
      // AI-generate title/sub for each session based on exercises
      try {
        const sessionKeys = Object.keys(routine).filter(k => /^sesion\d+$/.test(k));
        const summary = sessionKeys.map(k => {
          const s = routine[k] || {};
          const exs = [];
          for (const c of (s.circuits || [])) {
            for (const e of (c.exercises || [])) {
              if (e && e.name) exs.push(e.name);
            }
          }
          return { key: k, exercises: exs };
        }).filter(s => s.exercises.length > 0);
        if (summary.length && env.ANTHROPIC_API_KEY) {
          const prompt = `Analizá estas sesiones de entrenamiento y para cada una devolvé un JSON con el grupo muscular principal (title) y un subtítulo breve listando los ejercicios separados por " · " (sub). title debe ser corto (1-3 palabras, ej: "Cuádriceps", "Pecho + Tríceps", "Espalda + Bíceps", "Hombros", "Full Body"). sub es la lista de ejercicios principales tal cual.

Sesiones:
${summary.map(s => `${s.key}: ${s.exercises.join(', ')}`).join('\n')}

Devolvé SOLO un JSON así, sin texto extra:
{ "${summary[0].key}": { "title": "...", "sub": "..." }${summary.length>1?', ...':''} }`;
          const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 600,
              messages: [{ role: 'user', content: prompt }]
            })
          });
          const cd = await claudeRes.json();
          const raw = cd.content?.[0]?.text || '';
          const m = raw.match(/\{[\s\S]*\}/);
          if (m) {
            const parsed = JSON.parse(m[0]);
            for (const key of Object.keys(parsed)) {
              if (routine[key]) {
                if (parsed[key].title) routine[key].title = parsed[key].title;
                if (parsed[key].sub)   routine[key].sub   = parsed[key].sub;
              }
            }
          }
        }
      } catch (_) { /* falla silenciosa: guardamos igual */ }

      await env.DB.put(`routine:${client}`, JSON.stringify(routine));
      // Nota: se eliminó el email de "Rutina actualizada" al atleta — era spam.
      return new Response(JSON.stringify({ ok: true, routine }), { headers: cors });
    }

    // ── LIST ATHLETES (public read) ──
    if (body.action === 'list-athletes') {
      // Requiere credencial: sin ella cualquiera podía enumerar los nombres y
      // usernames de todos los atletas (y con eso entrar como cualquiera,
      // porque el login sólo pide username).
      const isPrivileged = body.token === 'ent2026' || body.admin === 'admin2026';
      if (!isPrivileged) {
        return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { headers: cors, status: 401 });
      }
      const athletes = await listAthletes(env, { includeArchived: !!body.includeArchived });
      return new Response(JSON.stringify({ ok: true, athletes }), { headers: cors });
    }

    // ── GET ATHLETE ──
    // Public path: solo safe fields. Privileged (trainer owner o admin o self con selfToken) → full record.
    if (body.action === 'get-athlete') {
      const targetId = body.clientId || client;
      const athlete = await getAthlete(env, targetId);
      if (!athlete) {
        return new Response(JSON.stringify({ ok: true, athlete: null }), { headers: cors });
      }
      const isTrainerOwner = body.token === 'ent2026' && athlete.trainerId && athlete.trainerId === body.trainerUsername;
      const isAdmin = body.admin === 'admin2026';
      const isSelf = body.selfToken && await verifySelfToken(env, targetId, body.selfToken);
      if (isTrainerOwner || isAdmin || isSelf) {
        return new Response(JSON.stringify({ ok: true, athlete }), { headers: cors });
      }
      // Fallback público — solo campos no sensibles
      const safe = {
        clientId: athlete.clientId, username: athlete.username, name: athlete.name,
        photoUrl: athlete.photoUrl || null, trainerId: athlete.trainerId || null,
        sessionsPerWeek: athlete.sessionsPerWeek || null,
        profile: { goal: athlete.profile?.goal || '' }
      };
      return new Response(JSON.stringify({ ok: true, athlete: safe }), { headers: cors });
    }

    // ── REGISTRO: ¿está libre este usuario? ──
    // No expone nada nuevo: el login ya dice si un usuario existe.
    if (body.action === 'usuario-disponible') {
      const username = slugifyUsername(String(body.username || '').trim());
      if (!username || username.length < 3) {
        return new Response(JSON.stringify({ ok: true, username, disponible: false, motivo: 'corto' }), { headers: cors });
      }
      const ids = await bootstrapAthletesIfNeeded(env);
      const libre = !ids.includes(username) && !(await env.DB.get(`athlete:${username}`));
      return new Response(JSON.stringify({ ok: true, username, disponible: libre }), { headers: cors });
    }

    // ── REGISTRO: cuenta con IA ──
    // Cualquiera puede crearla. Cada una cuesta llamadas a la IA, así que hay
    // un tope por conexión y otro por día.
    if (body.action === 'crear-cuenta-ia') {
      const ip = request.headers.get('CF-Connecting-IP') || 'sin-ip';
      const hoy = new Date().toISOString().slice(0, 10);
      const kIp = `registro-ip:${ip}:${hoy}`, kDia = `registro-dia:${hoy}`;
      const [nIp, nDia] = await Promise.all([env.DB.get(kIp), env.DB.get(kDia)]);
      // 15 por conexión: un gimnasio o una casa comparten la misma IP
      if ((parseInt(nIp) || 0) >= 15 || (parseInt(nDia) || 0) >= 200) {
        return new Response(JSON.stringify({ ok: false, error: 'Se crearon demasiadas cuentas hoy desde aquí. Intenta mañana.' }), { headers: cors, status: 429 });
      }

      const name = String(body.name || '').trim().slice(0, 60);
      const username = slugifyUsername(String(body.username || '').trim());
      if (name.length < 2) return new Response(JSON.stringify({ ok: false, error: 'Escribe tu nombre' }), { headers: cors });
      if (!username || username.length < 3) return new Response(JSON.stringify({ ok: false, error: 'El usuario necesita al menos 3 letras o números' }), { headers: cors });
      const { enc, error } = validarEncuesta(body.encuesta);
      if (error) return new Response(JSON.stringify({ ok: false, error }), { headers: cors });

      const existingIds = await bootstrapAthletesIfNeeded(env);
      if (existingIds.includes(username) || await env.DB.get(`athlete:${username}`)) {
        return new Response(JSON.stringify({ ok: false, error: 'Ese usuario ya existe. Prueba con otro.', campo: 'usuario' }), { headers: cors });
      }

      const { elecciones, explicacion } = await elegirConIA(env, enc);
      const rutina = armarRutina(enc, elecciones);

      const h = enc.estatura / 100;
      const bmi = Math.round((enc.peso / (h * h)) * 10) / 10;
      const bmr = Math.round(10 * enc.peso + 6.25 * enc.estatura - 5 * enc.edad + (enc.sexo === 'f' ? -161 : 5));
      const nowCO = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
      const fecha = `${nowCO.getFullYear()}-${String(nowCO.getMonth()+1).padStart(2,'0')}-${String(nowCO.getDate()).padStart(2,'0')}`;
      const DIA_CORTO = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];

      const record = {
        clientId: username, username, name,
        trainerId: null,
        modo: 'ia',
        origen: 'registro',
        email: null, phone: null, birthdate: null,
        sessionsPerWeek: enc.dias.length,
        trainingDays: enc.dias,
        preferredDays: enc.dias.map(d => DIA_CORTO[d]),
        profile: {
          weight: enc.peso, height: enc.estatura, sex: enc.sexo, age: enc.edad,
          bodyFat: null, muscleMass: null, bmi, bmr,
          goal: enc.objetivo, level: enc.nivel, experience: '',
          injuries: [enc.molestias.join(', '), enc.molestiaTexto].filter(Boolean).join('. '),
          notes: ''
        },
        encuesta: enc,
        planIA: { explicacion: explicacion || explicacionDeRespaldo(enc), creado: Date.now(), conIA: !!elecciones },
        measurements: [{ date: fecha, ts: Date.now(), weight: enc.peso, bmi, bmr }],
        photoUrl: null, pdfUrl: null,
        createdAt: Date.now(),
        archived: false
      };
      await env.DB.put(`routine:${username}`, JSON.stringify(rutina));
      await env.DB.put(`athlete:${username}`, JSON.stringify(record));
      // Se relee el índice justo antes de escribirlo: la IA tarda y en ese
      // rato pudo entrar otro registro.
      const idsAhora = await env.DB.get('athlete-index', 'json') || existingIds;
      if (!idsAhora.includes(username)) await env.DB.put('athlete-index', JSON.stringify([...idsAhora, username]));
      await Promise.all([
        env.DB.put(kIp, String((parseInt(nIp) || 0) + 1), { expirationTtl: 172800 }),
        env.DB.put(kDia, String((parseInt(nDia) || 0) + 1), { expirationTtl: 172800 }),
      ]);
      console.log(`[REGISTRO] ${username}: ${enc.dias.length} días, ${enc.objetivo}, ${enc.nivel}, ${enc.lugar}, IA=${!!elecciones}`);

      // Aviso al dueño de la app: una línea, para saber quién entra
      if (env.RESEND_API_KEY) {
        ctx.waitUntil(fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Mi Rutina <noreply@mirutinapp.com>',
            to: DEFAULT_TRAINER_EMAIL,
            subject: `Nueva cuenta con IA: ${name} (@${username})`,
            html: `<p style="font-family:-apple-system,Helvetica,sans-serif;font-size:15px">${escapeHtml(name)} (@${escapeHtml(username)}) creó una cuenta con IA.<br>` +
                  `${escapeHtml(describeEncuesta(enc))}</p>`
          })
        }).catch(() => {}));
      }

      const selfToken = await computeSelfToken(env, username);
      return new Response(JSON.stringify({
        ok: true,
        athlete: {
          clientId: username, username, name, photoUrl: null, trainerId: null,
          sessionsPerWeek: record.sessionsPerWeek, profile: record.profile,
          modo: 'ia', trainingDays: record.trainingDays,
        },
        selfToken,
        plan: { explicacion: record.planIA.explicacion, sesiones: resumenDelPlan(rutina) },
      }), { headers: cors });
    }

    // ── CREATE ATHLETE (trainer only) ──
    if (body.action === 'create-athlete') {
      if (body.token !== 'ent2026') {
        return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { headers: cors });
      }
      const input = body.athlete || {};
      const name = (input.name || '').trim();
      const username = slugifyUsername(input.username || input.name);
      const sessionsPerWeek = Math.max(1, Math.min(7, Number(input.sessionsPerWeek) || 0));
      if (!name || !username || !sessionsPerWeek) {
        return new Response(JSON.stringify({ ok: false, error: 'Nombre, username y sesiones son obligatorios' }), { headers: cors });
      }
      // Validar trainerId: si viene, debe existir en trainer-index
      const trainerIdRaw = (body.trainerId || '').trim() || null;
      if (trainerIdRaw) {
        const trainerIds = await bootstrapTrainersIfNeeded(env);
        if (!trainerIds.includes(trainerIdRaw)) {
          return new Response(JSON.stringify({ ok: false, error: 'trainerId no existe' }), { headers: cors, status: 400 });
        }
      }
      // Validar email formato si viene
      if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
        return new Response(JSON.stringify({ ok: false, error: 'Email inválido' }), { headers: cors, status: 400 });
      }
      // Ensure the index exists and username is unique (also used as clientId)
      const existingIds = await bootstrapAthletesIfNeeded(env);
      if (existingIds.includes(username)) {
        return new Response(JSON.stringify({ ok: false, error: 'Username ya existe' }), { headers: cors });
      }
      const record = {
        clientId: username,
        username,
        name,
        trainerId:       trainerIdRaw,
        email:           (input.email || '').trim() || null,
        phone:           (input.phone || '').trim() || null,
        birthdate:       input.birthdate || null,
        sessionsPerWeek,
        preferredDays:   Array.isArray(input.preferredDays) ? input.preferredDays : [],
        profile: {
          weight:      input.weight      ?? null,
          height:      input.height      ?? null,
          bodyFat:     input.bodyFat     ?? null,
          muscleMass:  input.muscleMass  ?? null,
          bmi:         input.bmi         ?? null,
          bmr:         input.bmr         ?? null,
          goal:        input.goal        || '',
          level:       input.level       || '',
          experience:  input.experience  || '',
          injuries:    input.injuries    || '',
          notes:       input.notes       || ''
        },
        photoUrl:        input.photoUrl || null,
        pdfUrl:          input.pdfUrl   || null,
        createdAt:       Date.now(),
        archived:        false
      };
      await env.DB.put(`athlete:${username}`, JSON.stringify(record));
      const newIndex = [...existingIds, username];
      await env.DB.put('athlete-index', JSON.stringify(newIndex));
      // Initialize an empty routine so the athlete can log in immediately.
      const routine = emptyRoutineTemplate(sessionsPerWeek);
      await env.DB.put(`routine:${username}`, JSON.stringify(routine));

      // Welcome email with login link + username
      if (record.email && env.RESEND_API_KEY) {
        const appUrl = `https://mirutinapp.com/?client=${username}`;
        const welcomeHtml = `<!DOCTYPE html><html><body style="margin:0;padding:0" bgcolor="#0f1117">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#0f1117" style="background:#0f1117;font-family:-apple-system,Helvetica,sans-serif">
  <tr><td align="center" style="padding:24px 16px">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
      <tr><td style="background:linear-gradient(135deg,#A68BFF,#6E4BFF);border-radius:16px;padding:24px">
        <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:rgba(255,255,255,.9);text-transform:uppercase;margin-bottom:6px">Bienvenido a Mi Rutina</div>
        <div style="font-size:28px;font-weight:800;color:#fff">👋 Hola ${name}</div>
      </td></tr>
      <tr><td height="16"></td></tr>
      <tr><td bgcolor="#1e2130" style="background:#1e2130;border:1px solid #2d3148;border-radius:12px;padding:20px">
        <p style="margin:0 0 14px;font-size:15px;color:#e2e8f0;line-height:1.6">Tu entrenador creó tu perfil. Ya puedes entrar a la app para ver tu rutina y registrar tus sesiones.</p>
        <div style="margin:14px 0;padding:14px;background:#0f1117;border:1px solid #2d3148;border-radius:10px">
          <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Tu usuario</div>
          <div style="font-size:20px;font-weight:800;color:#A996FF;font-family:ui-monospace,Menlo,monospace">${username}</div>
        </div>
        <p style="margin:0 0 14px;font-size:13px;color:#94a3b8;line-height:1.5">Entra con este usuario desde la pantalla "Atleta" la primera vez. Puedes agregar la app a la pantalla de inicio de tu celular para abrirla como app.</p>
        <a href="${appUrl}" style="display:inline-block;background:linear-gradient(135deg,#A68BFF,#6E4BFF);color:#fff;font-weight:700;font-size:14px;text-decoration:none;padding:12px 20px;border-radius:10px">Abrir Mi Rutina</a>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;
        ctx.waitUntil(fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Mi Rutina <noreply@mirutinapp.com>',
            to: record.email,
            subject: `👋 Bienvenido a Mi Rutina, ${name}`,
            html: welcomeHtml
          })
        }));
      }

      return new Response(JSON.stringify({ ok: true, athlete: record }), { headers: cors });
    }

    // ── UPDATE ATHLETE (trainer only) ──
    if (body.action === 'update-athlete') {
      const authErr = await authorizeTrainerForAthlete(env, body, cors);
      if (authErr) return authErr;
      const id = body.clientId;
      const existing = await getAthlete(env, id);
      const patch = body.fields || {};

      // Opcional: el trainer define cuál sesión debe salir próximo al atleta.
      // Guardamos sessionOffset tal que ((completions.length + offset) % total) + 1 === setNextSession.
      const desiredNext = Number.isFinite(+body.setNextSession) ? +body.setNextSession : null;
      if (desiredNext !== null) {
        const routine = await env.DB.get(`routine:${id}`, 'json') || {};
        const total = Object.keys(routine).filter(k => /^sesion\d+$/.test(k)).length || 2;
        if (desiredNext < 1 || desiredNext > total) {
          return new Response(JSON.stringify({ ok: false, error: `La sesión debe estar entre 1 y ${total}` }), { headers: cors, status: 400 });
        }
        const completions = await env.DB.get(`completions:${id}`, 'json') || [];
        const count = completions.length;
        patch.sessionOffset = (((desiredNext - 1 - count) % total) + total) % total;
      }

      // Username puede cambiarse: validar formato y unicidad contra otros atletas.
      let newUsername = existing.username;
      if (patch.username && patch.username !== existing.username) {
        const candidate = slugifyUsername(patch.username);
        if (!candidate) {
          return new Response(JSON.stringify({ ok: false, error: 'Username inválido' }), { headers: cors, status: 400 });
        }
        const all = await listAthletes(env, { includeArchived: true });
        const collision = all.find(a => a.clientId !== id && (a.username === candidate || a.clientId === candidate));
        if (collision) {
          return new Response(JSON.stringify({ ok: false, error: 'Ese username ya está en uso' }), { headers: cors, status: 409 });
        }
        newUsername = candidate;
      }
      const mergedProfile = { ...(existing.profile || {}), ...(patch.profile || {}) };

      // Historial de mediciones: hasta ahora sólo se guardaba el último valor,
      // sin fecha, así que no había forma de mostrar evolución. Cada vez que
      // cambia alguna medida se añade una entrada fechada.
      const METRICS = ['weight', 'bodyFat', 'muscleMass', 'bmi', 'bmr'];
      const prev = existing.profile || {};
      const changed = METRICS.some(k =>
        patch.profile && patch.profile[k] !== undefined &&
        patch.profile[k] !== null && patch.profile[k] !== '' &&
        String(patch.profile[k]) !== String(prev[k] ?? '')
      );
      let history = Array.isArray(existing.measurements) ? existing.measurements.slice() : [];
      if (changed) {
        const nowCO = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
        const date = `${nowCO.getFullYear()}-${String(nowCO.getMonth()+1).padStart(2,'0')}-${String(nowCO.getDate()).padStart(2,'0')}`;
        const entry = { date, ts: Date.now() };
        METRICS.forEach(k => {
          const v = mergedProfile[k];
          if (v !== null && v !== undefined && v !== '') entry[k] = v;
        });
        // Una entrada por día: si ya hay una de hoy, se reemplaza.
        history = history.filter(m => m.date !== date);
        history.push(entry);
        history.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        if (history.length > 120) history = history.slice(-120);
      }

      const updated = {
        ...existing,
        ...patch,
        clientId: existing.clientId,        // immutable (key del KV)
        username: newUsername,              // editable con validación
        trainerId: existing.trainerId,      // immutable desde update (solo hard-delete + create)
        profile: mergedProfile,
        measurements: history
      };
      await env.DB.put(`athlete:${id}`, JSON.stringify(updated));
      return new Response(JSON.stringify({ ok: true, athlete: updated }), { headers: cors });
    }

    // ── EXTRACT PROFILE FROM PDF (trainer only) ──
    if (body.action === 'extract-profile-from-pdf') {
      if (body.token !== 'ent2026') {
        return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { headers: cors });
      }
      if (!body.pdfUrl) {
        return new Response(JSON.stringify({ ok: false, error: 'Falta pdfUrl' }), { headers: cors });
      }
      try {
        const pdfRes = await fetch(body.pdfUrl);
        if (!pdfRes.ok) throw new Error('No se pudo descargar el PDF');
        const bytes = new Uint8Array(await pdfRes.arrayBuffer());
        // Chunked base64 to avoid call-stack issues on large PDFs.
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        const b64 = btoa(binary);

        const schemaPrompt = `Sos un asistente que extrae datos de un documento de onboarding de un atleta en español.
Devolvé UNICAMENTE un JSON válido (sin texto alrededor, sin backticks) con esta forma exacta:
{
  "name": string|null,
  "email": string|null,
  "phone": string|null,
  "birthdate": "YYYY-MM-DD"|null,
  "weight": number|null,
  "height": number|null,
  "bodyFat": number|null,
  "muscleMass": number|null,
  "goal": "hipertrofia"|"perdida-grasa"|"fuerza"|"recomposicion"|"rendimiento"|"otro"|null,
  "level": "principiante"|"intermedio"|"avanzado"|null,
  "experience": string|null,
  "injuries": string|null,
  "notes": string|null,
  "sessionsPerWeek": number|null
}
Si un campo no aparece claramente en el PDF, poné null. No inventes.`;

        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 800,
            messages: [{
              role: 'user',
              content: [
                { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
                { type: 'text', text: schemaPrompt }
              ]
            }]
          })
        });
        const claudeData = await claudeRes.json();
        const raw = claudeData.content?.[0]?.text || '';
        let parsed = null;
        try {
          const jsonMatch = raw.match(/\{[\s\S]*\}/);
          parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
        } catch (_) {}
        if (!parsed) {
          return new Response(JSON.stringify({ ok: false, error: 'La IA no devolvió JSON válido', raw }), { headers: cors });
        }
        return new Response(JSON.stringify({ ok: true, fields: parsed }), { headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: cors });
      }
    }

    // ── DELETE ATHLETE (trainer only) ──
    if (body.action === 'delete-athlete') {
      // Una cuenta con IA no tiene entrenador que la borre: la borra el admin
      const adminBorraIA = body.admin === 'admin2026' && sinEntrenador(await getAthlete(env, body.clientId));
      if (!adminBorraIA) {
        const authErr = await authorizeTrainerForAthlete(env, body, cors);
        if (authErr) return authErr;
      }
      const id = body.clientId;
      const existing = await getAthlete(env, id);
      const ids = (await env.DB.get('athlete-index', 'json')) || [];
      await env.DB.put('athlete-index', JSON.stringify(ids.filter(x => x !== id)));
      if (body.hard) {
        // Hard delete secuencial: si alguno falla, loggeamos y seguimos los
        // otros (sin Promise.all para que un error no deje huérfanos los otros).
        const keys = [`athlete:${id}`, `routine:${id}`, `completions:${id}`, `meals:${id}`, `payment:${id}`, `support-chat:${id}`, `progresion:${id}`, `chatlog:${id}`];
        for (const k of keys) {
          try { await env.DB.delete(k); }
          catch (err) { console.error(`[delete-athlete] failed to delete ${k}:`, err?.message); }
        }
      } else {
        // Soft delete: keep record archived for potential restore
        await env.DB.put(`athlete:${id}`, JSON.stringify({ ...existing, archived: true }));
      }
      return new Response(JSON.stringify({ ok: true }), { headers: cors });
    }

    // ── GET PAYMENT ──
    if (body.action === 'get-payment') {
      const authErr = await authorizeReadForClient(env, body, client, cors);
      if (authErr) return authErr;
      const payment = await env.DB.get(`payment:${client}`, 'json');
      return new Response(JSON.stringify({ ok: true, payment: payment || null }), { headers: cors });
    }

    // ── LIST TRAINERS (public: safe fields / admin: full) ──
    if (body.action === 'list-trainers') {
      const trainers = await listTrainers(env);
      if (body.admin === 'admin2026') {
        return new Response(JSON.stringify({ ok: true, trainers }), { headers: cors });
      }
      const safe = trainers.map(t => ({
        username: t.username, name: t.name, photoUrl: t.photoUrl,
        yearsExperience: t.yearsExperience || null,
        specialty: t.specialty || '',
        education: t.education || '',
        bio: t.bio || ''
      }));
      return new Response(JSON.stringify({ ok: true, trainers: safe }), { headers: cors });
    }

    // ── UPDATE TRAINER (self or admin) ──
    if (body.action === 'update-trainer') {
      const username = (body.username || '').trim().toLowerCase();
      if (!username) return new Response(JSON.stringify({ ok: false, error: 'Falta username' }), { headers: cors });
      const existing = await env.DB.get(`trainer:${username}`, 'json');
      if (!existing) return new Response(JSON.stringify({ ok: false, error: 'Entrenador no encontrado' }), { headers: cors });
      if (body.admin !== 'admin2026' && !body.self) {
        return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { headers: cors });
      }
      const patch = body.fields || {};
      if (patch.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.email)) {
        return new Response(JSON.stringify({ ok: false, error: 'Email inválido' }), { headers: cors, status: 400 });
      }

      // ── Opcional: rename de username (solo admin) ──
      const newUsernameRaw = (body.newUsername || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
      const isRename = newUsernameRaw && newUsernameRaw !== username;
      if (isRename && body.admin !== 'admin2026') {
        return new Response(JSON.stringify({ ok: false, error: 'Solo admin puede cambiar el usuario' }), { headers: cors, status: 403 });
      }

      if (isRename) {
        const ids = (await env.DB.get('trainer-index', 'json')) || [];
        if (ids.includes(newUsernameRaw)) {
          return new Response(JSON.stringify({ ok: false, error: 'Ese usuario ya existe' }), { headers: cors, status: 400 });
        }
        const renamed = {
          ...existing,
          ...patch,
          username: newUsernameRaw,
          createdAt: existing.createdAt
        };
        // 1. Escribir trainer con la nueva key
        await env.DB.put(`trainer:${newUsernameRaw}`, JSON.stringify(renamed));
        // 2. Actualizar trainer-index (reemplazar old por new)
        const nextIds = ids.filter(x => x !== username).concat(newUsernameRaw);
        await env.DB.put('trainer-index', JSON.stringify(nextIds));
        // 3. Repuntar atletas que apuntaban al trainer viejo
        const athleteIds = (await env.DB.get('athlete-index', 'json')) || [];
        for (const aid of athleteIds) {
          try {
            const athlete = await env.DB.get(`athlete:${aid}`, 'json');
            if (athlete && athlete.trainerId === username) {
              athlete.trainerId = newUsernameRaw;
              await env.DB.put(`athlete:${aid}`, JSON.stringify(athlete));
            }
          } catch (e) { console.error(`[update-trainer rename] athlete ${aid}:`, e); }
        }
        // 4. Mover support-chat (si existe)
        try {
          const chat = await env.DB.get(`support-chat:${username}`, 'json');
          if (chat) {
            await env.DB.put(`support-chat:${newUsernameRaw}`, JSON.stringify(chat));
            await env.DB.delete(`support-chat:${username}`);
          }
        } catch (e) { console.error('[update-trainer rename] support-chat:', e); }
        // 5. Borrar trainer con la key vieja
        await env.DB.delete(`trainer:${username}`);
        return new Response(JSON.stringify({ ok: true, trainer: renamed, renamed: true }), { headers: cors });
      }

      const updated = {
        ...existing,
        ...patch,
        username: existing.username,
        createdAt: existing.createdAt
      };
      await env.DB.put(`trainer:${username}`, JSON.stringify(updated));
      return new Response(JSON.stringify({ ok: true, trainer: updated }), { headers: cors });
    }

    // ── LIST ATHLETES BY TRAINER (admin only) ──
    if (body.action === 'list-athletes-by-trainer') {
      if (body.admin !== 'admin2026') {
        return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { headers: cors });
      }
      const all = await listAthletes(env, { includeArchived: false });
      const filtered = all.filter(a => a.trainerId === body.trainerUsername);
      return new Response(JSON.stringify({ ok: true, athletes: filtered }), { headers: cors });
    }

    // ── CREATE TRAINER (admin only) ──
    if (body.action === 'create-trainer') {
      if (body.admin !== 'admin2026') {
        return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { headers: cors });
      }
      const t = body.trainer || {};
      const username = (t.username || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
      const name = (t.name || '').trim();
      if (!username || !name) {
        return new Response(JSON.stringify({ ok: false, error: 'Nombre y usuario son obligatorios' }), { headers: cors });
      }
      const ids = await bootstrapTrainersIfNeeded(env);
      if (ids.includes(username)) {
        return new Response(JSON.stringify({ ok: false, error: 'Ese usuario ya existe' }), { headers: cors });
      }
      const record = {
        username, name,
        email: (t.email || '').trim() || null,
        phone: (t.phone || '').trim() || null,
        photoUrl: t.photoUrl || null,
        yearsExperience: t.yearsExperience || null,
        specialty: t.specialty || '',
        education: t.education || '',
        bio: t.bio || '',
        createdAt: Date.now()
      };
      await env.DB.put(`trainer:${username}`, JSON.stringify(record));
      await env.DB.put('trainer-index', JSON.stringify([...ids, username]));

      // Welcome email with login info
      if (record.email && env.RESEND_API_KEY) {
        const appUrl = `https://mirutinapp.com/`;
        const html = `<!DOCTYPE html><html><body style="margin:0;padding:0" bgcolor="#0f1117">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#0f1117" style="background:#0f1117;font-family:-apple-system,Helvetica,sans-serif">
  <tr><td align="center" style="padding:24px 16px">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
      <tr><td style="background:linear-gradient(135deg,#6366f1,#818cf8);border-radius:16px;padding:24px">
        <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:rgba(255,255,255,.9);text-transform:uppercase;margin-bottom:6px">Bienvenido a Mi Rutina</div>
        <div style="font-size:28px;font-weight:800;color:#fff">🏋️ ${name}</div>
      </td></tr>
      <tr><td height="16"></td></tr>
      <tr><td bgcolor="#1e2130" style="background:#1e2130;border:1px solid #2d3148;border-radius:12px;padding:20px">
        <p style="margin:0 0 14px;font-size:15px;color:#e2e8f0;line-height:1.6">Se creó tu perfil de entrenador en Mi Rutina. Ya puedes entrar al portal con tu usuario.</p>
        <div style="margin:14px 0;padding:14px;background:#0f1117;border:1px solid #2d3148;border-radius:10px">
          <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Tu usuario</div>
          <div style="font-size:20px;font-weight:800;color:#818cf8;font-family:ui-monospace,Menlo,monospace">${username}</div>
        </div>
        <p style="margin:0 0 14px;font-size:13px;color:#94a3b8;line-height:1.5">Desde el portal puedes crear atletas, armar sus rutinas, ver comidas, pagos y resúmenes semanales.</p>
        <a href="${appUrl}" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#818cf8);color:#fff;font-weight:700;font-size:14px;text-decoration:none;padding:12px 20px;border-radius:10px">Abrir Mi Rutina</a>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;
        ctx.waitUntil(fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Mi Rutina <noreply@mirutinapp.com>',
            to: record.email,
            subject: `🏋️ Bienvenido a Mi Rutina, ${name}`,
            html
          })
        }).catch(() => {}));
      }

      return new Response(JSON.stringify({ ok: true, trainer: record }), { headers: cors });
    }

    // ── DELETE TRAINER (admin only) ──
    if (body.action === 'delete-trainer') {
      if (body.admin !== 'admin2026') {
        return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { headers: cors });
      }
      const username = body.username;
      if (!username) return new Response(JSON.stringify({ ok: false, error: 'Falta username' }), { headers: cors });
      await env.DB.delete(`trainer:${username}`);
      const ids = (await env.DB.get('trainer-index', 'json')) || [];
      await env.DB.put('trainer-index', JSON.stringify(ids.filter(x => x !== username)));
      return new Response(JSON.stringify({ ok: true }), { headers: cors });
    }

    // ── SAVE PAYMENT (trainer only, ownership validado) ──
    if (body.action === 'save-payment') {
      const authErr = await authorizeTrainerForAthlete(env, { ...body, clientId: client }, cors);
      if (authErr) return authErr;
      const existing = await env.DB.get(`payment:${client}`, 'json') || {};
      const updated = { ...existing, ...body.fields };
      await env.DB.put(`payment:${client}`, JSON.stringify(updated));
      return new Response(JSON.stringify({ ok: true }), { headers: cors });
    }

    // ── SUPPORT CHAT ──
    if (body.action === 'get-support-chat') {
      const authErr = authorizeSupportChat(env, body, cors);
      if (authErr) return authErr;
      const msgs = await env.DB.get(`support-chat:${body.trainerId}`, 'json') || [];
      return new Response(JSON.stringify({ ok: true, messages: msgs }), { headers: cors });
    }

    if (body.action === 'send-support-msg') {
      // Sin esto cualquiera podía escribir en el hilo de soporte (y disparar
      // el email de notificación) sin credencial alguna.
      const authErr = authorizeSupportChat(env, body, cors);
      if (authErr) return authErr;
      const kvKey = `support-chat:${body.trainerId}`;
      let msgs = await env.DB.get(kvKey, 'json') || [];
      msgs.push({
        role: body.role,
        text: body.text,
        ts: Date.now(),
        clientId: body.clientId || null,    // quién escribió (si vino del atleta)
        senderName: body.senderName || null  // nombre display (cache para UI admin)
      });
      if (msgs.length > 500) msgs = msgs.slice(-500);
      await env.DB.put(kvKey, JSON.stringify(msgs));

      // Email notification when trainer sends a message to admin support.
      // Destination is always the admin inbox (DEFAULT_TRAINER_EMAIL).
      if (body.role === 'trainer' && env.RESEND_API_KEY) {
        const trainerRec = await getTrainer(env, body.trainerId);
        const trainerName = trainerRec?.name || body.trainerId;
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Mi Rutina <noreply@mirutinapp.com>',
            to: DEFAULT_TRAINER_EMAIL,
            subject: `💬 Nuevo mensaje de soporte — ${trainerName}`,
            html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0" bgcolor="#0f1117">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#0f1117" style="background:#0f1117;font-family:-apple-system,Helvetica,sans-serif">
  <tr><td align="center" style="padding:24px 16px">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
      <tr><td style="background:linear-gradient(135deg,#6366f1,#818cf8);border-radius:16px;padding:24px">
        <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:rgba(255,255,255,.7);text-transform:uppercase;margin-bottom:6px">Mensaje de soporte</div>
        <div style="font-size:22px;font-weight:800;color:#fff">💬 ${trainerName}</div>
      </td></tr>
      <tr><td height="16"></td></tr>
      <tr><td bgcolor="#1e2130" style="background:#1e2130;border:1px solid #2d3148;border-radius:12px;padding:20px">
        <div style="font-size:14px;color:#e2e8f0;line-height:1.6">${body.text}</div>
        <div style="font-size:11px;color:#64748b;margin-top:12px">${new Date().toLocaleString('es-CO', { dateStyle:'medium', timeStyle:'short' })}</div>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`
          })
        }).catch(() => {});
      }

      return new Response(JSON.stringify({ ok: true }), { headers: cors });
    }

    // ── LANDING LEAD CAPTURE (form de demo desde mirutinapp.com/landing) ──
    if (body.action === 'landing-lead') {
      const name = (body.name || '').toString().trim().slice(0, 80);
      const email = (body.email || '').toString().trim().slice(0, 120).toLowerCase();
      const type = (body.type || 'otro').toString().slice(0, 20);
      const whatsapp = (body.whatsapp || '').toString().trim().slice(0, 30);
      const message = (body.message || '').toString().trim().slice(0, 500);

      // Basic validation
      if (!name || !email || !email.includes('@') || !email.includes('.')) {
        return new Response(JSON.stringify({ ok: false, error: 'Datos incompletos' }), { headers: cors });
      }

      const leadId = `lead:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const lead = { name, email, type, whatsapp, message, ts: Date.now(), source: 'landing' };
      await env.DB.put(leadId, JSON.stringify(lead));

      if (env.RESEND_API_KEY) {
        const typeLabel = { entrenador: 'Entrenador', gimnasio: 'Dueño de gimnasio', atleta: 'Atleta' }[type] || 'Otro';
        const html = `
          <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
            <h2 style="margin:0 0 16px;color:#6E4BFF">🎯 Nuevo lead desde la landing</h2>
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:8px 0;color:#666;width:120px">Nombre</td><td style="font-weight:600">${escapeHtml(name)}</td></tr>
              <tr><td style="padding:8px 0;color:#666">Email</td><td><a href="mailto:${escapeHtml(email)}" style="color:#6E4BFF">${escapeHtml(email)}</a></td></tr>
              <tr><td style="padding:8px 0;color:#666">Tipo</td><td>${typeLabel}</td></tr>
              ${whatsapp ? `<tr><td style="padding:8px 0;color:#666">WhatsApp</td><td><a href="https://wa.me/${whatsapp.replace(/[^0-9]/g, '')}" style="color:#6E4BFF">${escapeHtml(whatsapp)}</a></td></tr>` : ''}
              ${message ? `<tr><td style="padding:8px 0;color:#666;vertical-align:top">Mensaje</td><td style="white-space:pre-wrap">${escapeHtml(message)}</td></tr>` : ''}
            </table>
            <p style="margin-top:24px;color:#888;font-size:13px">Recibido en ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })} (Colombia)</p>
          </div>`;

        ctx.waitUntil(fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Mi Rutina <noreply@mirutinapp.com>',
            to: 'juansaravia2002@gmail.com',
            reply_to: email,
            subject: `🎯 Nuevo lead landing — ${name} (${typeLabel})`,
            html
          })
        }));
      }

      return new Response(JSON.stringify({ ok: true }), { headers: cors });
    }

    // ── ADMIN: shift latest completion of a given day to the previous day ──
    // Used when the trainer/atleta envió una sesión por error y quiere que
    // siga contando pero NO bloquee la rutina de hoy.
    if (body.action === 'admin-shift-completion') {
      const adminEmail = (body.adminEmail || '').toString().toLowerCase().trim();
      const ADMIN = (env.ADMIN_EMAIL || 'juansaravia2002@gmail.com').toLowerCase();
      if (adminEmail !== ADMIN) {
        return new Response(JSON.stringify({ ok: false, error: 'No autorizado' }), { headers: cors });
      }
      const clientId = (body.client || '').toString();
      const day = (body.day || '').toString();
      if (!clientId || !day) {
        return new Response(JSON.stringify({ ok: false, error: 'Faltan client o day' }), { headers: cors });
      }
      const completions = await env.DB.get(`completions:${clientId}`, 'json') || [];
      // Buscar la completion más reciente con ese día
      let targetIdx = -1;
      for (let i = completions.length - 1; i >= 0; i--) {
        if (completions[i].day === day) { targetIdx = i; break; }
      }
      if (targetIdx === -1) {
        return new Response(JSON.stringify({ ok: false, error: `No hay completions con day=${day}` }), { headers: cors });
      }
      // Calcular el día anterior
      const [y, m, d] = day.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      dt.setUTCDate(dt.getUTCDate() - 1);
      const newDay = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
      const oldDay = completions[targetIdx].day;
      completions[targetIdx].day = newDay;
      await env.DB.put(`completions:${clientId}`, JSON.stringify(completions));
      console.log(`[ADMIN] Shifted completion of ${clientId}: ${oldDay} -> ${newDay}`);
      return new Response(JSON.stringify({
        ok: true,
        moved: { client: clientId, from: oldDay, to: newDay, sesion: completions[targetIdx].sesion || completions[targetIdx].sessionKey || null }
      }), { headers: cors });
    }

    if (body.action === 'list-support-chats') {
      // Sólo admin: expone el último mensaje de TODOS los entrenadores.
      if (body.admin !== 'admin2026') {
        return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { headers: cors, status: 401 });
      }
      const list = await env.DB.list({ prefix: 'support-chat:' });
      const chats = [];
      for (const key of list.keys) {
        const msgs = await env.DB.get(key.name, 'json') || [];
        const last = msgs[msgs.length - 1];
        const trainerId = key.name.replace('support-chat:', '');
        chats.push({ trainerId, lastMsg: last?.text || '', lastTs: last?.ts || 0, role: last?.role || '', count: msgs.length });
      }
      chats.sort((a, b) => b.lastTs - a.lastTs);
      return new Response(JSON.stringify({ ok: true, chats }), { headers: cors });
    }

    // ── CHAT ──
    // Si el atleta manda su sesión de hoy, el chat puede cambiarle un
    // ejercicio. Las alternativas salen del catálogo del worker, no del
    // modelo: así no puede proponer algo que no exista.
    const sesionHoy = Array.isArray(body.sesionHoy) ? body.sesionHoy.slice(0, 20) : [];
    let sistema = body.context || '';

    if (sesionHoy.length) {
      const yaEstan = new Set(sesionHoy.map(e => e.name));
      const valeChat = filtroDelAtleta(athleteRecord && athleteRecord.encuesta);
      const perfilChat = perfilDeCarga(athleteRecord);
      const fichas = sesionHoy.map(e => {
        const cat = PorNombre[e.name];
        if (!cat) return null;
        const alt = (PorMusculo[cat.muscle] || [])
          .filter(x => !yaEstan.has(x.name) && valeChat(x))
          .slice(0, 14)
          .map(x => x.name);
        const ficha = { actual: e.name, musculo: cat.muscle, carga: e.w1 || 'sin peso',
                        saltoDelAparato: cat.step || null, alternativas: alt };
        if (cargaDesproporcionada(cat, e.w1, perfilChat)) {
          ficha.cargaAlta = true;
          ficha.cargaRazonable = cargaSugerida(cat, perfilChat);
        }
        return ficha;
      }).filter(Boolean);

      if (fichas.length) {
        sistema += `

PUEDES CAMBIARLE UN EJERCICIO DE HOY.
Si te pide cambiar uno — porque la máquina está ocupada, no hay material, le molesta algo —
elige un reemplazo de la lista de alternativas de ESE ejercicio y termina tu respuesta con una
línea exactamente así, sola y al final:
@@CAMBIAR: <nombre actual exacto> >> <nombre nuevo exacto>

Reglas: el nombre nuevo tiene que ser uno de los de su lista de alternativas, copiado letra por
letra. Un cambio por respuesta. Si no te está pidiendo cambiar nada, no escribas esa línea.
Avísale en el texto que el cambio es sólo para hoy y que la próxima semana vuelve el original.

TAMBIÉN PUEDES AJUSTARLE LA CARGA.
Si te dice que un ejercicio le quedó fácil o muy pesado y quiere otro peso, propón uno y termina
con una línea sola al final:
@@PESO: <nombre exacto> >> <número>

El número tiene que ser cargable en ese aparato: muévete en múltiplos de "saltoDelAparato" desde
la carga actual. Un salto de uno o dos escalones es lo normal; si te pide más, dilo pero no te
pases de ahí. A diferencia del cambio de ejercicio, ESTE SÍ SE QUEDA: avísale que a partir de
ahora esa es su carga y que de ahí sigue la progresión.
Una sola línea por respuesta, @@CAMBIAR o @@PESO, nunca las dos.

CARGAS CON SENTIDO.
Antes de decir que una carga está bien, piensa si es lógica para ESE ejercicio y esa persona
(un press militar de pie con barra no se carga como una banca ni como una prensa). Si un ejercicio
trae "cargaAlta": true, esa carga es desproporcionada y peligrosa: NUNCA le digas que está bien.
Díselo claro, explícale el riesgo en una frase y propón bajarla con @@PESO a algo cercano a
"cargaRazonable" (puede ser un poco más si te cuenta que la maneja con buena técnica).

Ejercicios de hoy y sus alternativas:
${JSON.stringify(fichas, null, 1)}`;
      }
    }

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 900,   // con 500 la respuesta se cortaba antes de la línea final
        system: sistema,
        messages: body.messages || []
      })
    });

    const claudeData = await claudeRes.json();
    if (!claudeRes.ok || claudeData.error) {
      console.log(`[CHAT] la API respondió ${claudeRes.status}: ${JSON.stringify(claudeData).slice(0, 300)}`);
    }

    let content = textoDeRespuesta(claudeData);

    // El modelo propone el cambio; aquí se comprueba antes de devolverlo
    let accion = null;

    const mp = content.match(/@@PESO:\s*(.+?)\s*>>\s*([\d.,]+)\s*.*$/m);
    if (mp) {
      content = content.replace(mp[0], '').trim();
      const nombre = mp[1].trim();
      const peso = parseFloat(mp[2].replace(',', '.'));
      const enHoy = sesionHoy.find(e => e.name === nombre);
      const actual = enHoy ? numeroDePeso(enHoy.w1) : null;
      if (!enHoy)                     console.log(`[CHAT] "${nombre}" no está en la sesión de hoy`);
      else if (!isFinite(peso) || peso <= 0) console.log(`[CHAT] peso inválido para "${nombre}"`);
      else if (actual && (peso < actual * 0.25 || peso > actual * 4))
                                      console.log(`[CHAT] salto raro en "${nombre}": ${peso} contra ${actual}`);
      else {
        accion = { tipo: 'peso', ci: enHoy.ci, ei: enHoy.ei, name: nombre, peso };
        console.log(`[CHAT] propone carga: ${nombre} ${enHoy.w1} → ${peso}`);
      }
    }

    const m = !accion && content.match(/@@CAMBIAR:\s*(.+?)\s*>>\s*(.+?)\s*$/m);
    if (m) {
      content = content.replace(m[0], '').trim();
      const de = m[1].trim(), a = m[2].trim();
      const enHoy = sesionHoy.find(e => e.name === de);
      const viejo = PorNombre[de], nuevo = PorNombre[a];
      if (!enHoy)       console.log(`[CHAT] "${de}" no está en la sesión de hoy`);
      else if (!nuevo)  console.log(`[CHAT] "${a}" no existe en el catálogo`);
      else if (!viejo || viejo.muscle !== nuevo.muscle)
                        console.log(`[CHAT] "${a}" no es del mismo músculo que "${de}"`);
      else if (sesionHoy.some(e => e.name === a))
                        console.log(`[CHAT] "${a}" ya está en la sesión`);
      else {
        // La carga se pasa por proporción: el mismo número en otro aparato
        // puede ser un disparate
        const w1 = convierteCarga(viejo, enHoy.w1 || '', nuevo, perfilDeCarga(athleteRecord));
        accion = {
          tipo: 'sustituir', ci: enHoy.ci, ei: enHoy.ei, de,
          nuevo: {
            name: nuevo.name, muscle: nuevo.muscle, unit: nuevo.unit, step: nuevo.step,
            img: nuevo.img, tip: nuevo.tip,
            w1,
            reps: enHoy.reps || '', repMin: enHoy.repMin, repMax: enHoy.repMax,
            repNow: enHoy.repNow, calibrar: nuevo.unit !== 'corporal',
          },
        };
        console.log(`[CHAT] sustitución de hoy: ${de} → ${a}`);
      }
    }

    // Se guarda lo que preguntó y lo que se le respondió, sólo si es él
    if (content && client && body.selfToken && await verifySelfToken(env, client, body.selfToken)) {
      const ultima = [...(body.messages || [])].reverse().find(m => m && m.role === 'user');
      const q = ultima ? String(typeof ultima.content === 'string' ? ultima.content : '').slice(0, 600) : '';
      if (q) await guardaEnChatLog(env, client, { q, a: content.slice(0, 900),
        accion: accion ? { tipo: accion.tipo, name: accion.name || accion.de, a: accion.peso || (accion.nuevo && accion.nuevo.name) } : null });
    }

    return new Response(JSON.stringify({
      ok: true,
      content,
      accion,
      _error: !content ? (claudeData.error?.message || claudeData.type || 'empty') : null
    }), { headers: cors });
  },

  // ── CRON HANDLERS ──
  async scheduled(event, env, ctx) {
    const ts = new Date().toISOString();
    console.log(`[CRON] fired at ${ts} | cron=${event.cron} | scheduledTime=${event.scheduledTime}`);

    // Detect by hour (more robust than string match in case Cloudflare normalizes the cron)
    const utcHour = new Date(event.scheduledTime || Date.now()).getUTCHours();
    const utcDay = new Date(event.scheduledTime || Date.now()).getUTCDay(); // 0=Sun..6=Sat

    // Weekly report: Sunday 01:00 UTC = Saturday 20:00 Colombia
    if (utcHour === 1 && utcDay === 0) {
      console.log('[CRON] -> progresión semanal + sendWeeklyReport');
      // Primero la rutina de la semana que viene: si el viernes ya la corrió,
      // correrProgresion se sale sola al ver la semana en el historial.
      const cuentasIA = (await listAthletes(env)).filter(esIA).map(a => a.clientId);
      for (const id of cuentasIA) {
        try {
          const r = await correrProgresion(env, id, 'cron');
          console.log(`[CRON] progresión ${id}: ${r.ok ? r.cambios.length + ' cambios' : r.razon}`);
        } catch (e) { console.log(`[CRON] progresión ${id} falló: ${e.message}`); }
      }
      await sendWeeklyReport(env);
      return;
    }
    // Workout reminder: 18:00 UTC = 13:00 Colombia
    if (utcHour === 18) {
      console.log('[CRON] -> sendWorkoutReminder');
      await sendWorkoutReminder(env);
      return;
    }
    // Daily meal report: 03:00 UTC = 22:00 Colombia (previous day)
    if (utcHour === 3) {
      console.log('[CRON] -> sendDailyMealReport');
      await sendDailyMealReport(env);
      return;
    }
    console.log('[CRON] -> no handler matched, skipping');
  }
};

// ── Daily meal report (10 PM Colombia) ──
async function sendDailyMealReport(env) {
  const MEAL_SLOTS = [
    { key: 'desayuno', label: 'Desayuno', icon: '☀️' },
    { key: 'mediasNueves', label: 'Medias nueves', icon: '🍎' },
    { key: 'almuerzo', label: 'Almuerzo', icon: '🍽️' },
    { key: 'onces', label: 'Onces', icon: '☕' },
    { key: 'comida', label: 'Cena', icon: '🌙' }
  ];

  const now = new Date();
  const coDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  const todayKey = `${coDate.getFullYear()}-${String(coDate.getMonth()+1).padStart(2,'0')}-${String(coDate.getDate()).padStart(2,'0')}`;
  const dayLabel = coDate.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });

  for (const athlete of await listAthletes(env)) {
    if (sinEntrenador(athlete)) continue;
    try {
    const clientId = athlete.clientId;
    const records = await env.DB.get(`meals:${clientId}`, 'json') || [];
    const todayRecord = records.find(r => r.day === todayKey);
    if (!todayRecord) continue;

    const filledSlots = MEAL_SLOTS.filter(s => todayRecord.meals?.[s.key] || todayRecord.photos?.[s.key]);
    if (filledSlots.length === 0) continue;

    let slotsHtml = '';
    let totalSummary = { cals: 0, prot: 0, carbs: 0, fat: 0, count: 0 };

    for (const slot of filledSlots) {
      const text = todayRecord.meals?.[slot.key] || '';
      const photo = todayRecord.photos?.[slot.key] || '';
      const analysis = todayRecord.analyses?.[slot.key] || '';
      const macros = parseMacros(analysis);
      if (macros) { totalSummary.cals += macros.cals; totalSummary.prot += macros.prot; totalSummary.carbs += macros.carbs; totalSummary.fat += macros.fat; totalSummary.count++; }

      slotsHtml += `
        <tr><td height="16"></td></tr>
        <tr><td bgcolor="#1e2130" style="background:#1e2130;border:1px solid #2d3148;border-radius:12px;padding:20px">
          <div style="font-size:11px;font-weight:700;letter-spacing:1.2px;color:#94a3b8;text-transform:uppercase;margin-bottom:12px">${slot.icon} ${slot.label}</div>
          ${text ? `<p style="margin:0 0 12px;font-size:14px;color:#e2e8f0;line-height:1.5">${text}</p>` : ''}
          ${photo ? `<img src="${photo}" style="width:100%;max-width:400px;border-radius:10px;display:block;margin-bottom:12px">` : ''}
          ${analysis ? `<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#0f1117" style="background:#0f1117;border-left:3px solid #06b6d4;border-radius:0 8px 8px 0"><tr><td style="padding:14px 16px"><div style="font-size:11px;font-weight:700;color:#06b6d4;letter-spacing:1px;margin-bottom:10px">🤖 ANÁLISIS NUTRICIONAL</div><div style="font-size:13px;line-height:1.8;color:#cbd5e1;white-space:pre-line">${analysis}</div></td></tr></table>` : ''}
        </td></tr>`;
    }

    const totalsHtml = totalSummary.count > 0 ? buildMacrosTotalHtml(totalSummary, `TOTALES DEL DÍA (${totalSummary.count} comida${totalSummary.count > 1 ? 's' : ''} analizadas)`) : '';

    const emailHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0" bgcolor="#0f1117">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#0f1117" style="background:#0f1117;font-family:-apple-system,Helvetica,sans-serif">
  <tr><td align="center" style="padding:24px 16px">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
      <tr><td style="background:linear-gradient(135deg,#06b6d4,#6366f1);border-radius:16px;padding:24px">
        <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:rgba(255,255,255,.7);text-transform:uppercase;margin-bottom:6px">Reporte diario de comidas</div>
        <div style="font-size:28px;font-weight:800;color:#fff">🍽️ ${athlete.name}</div>
        <div style="font-size:13px;color:rgba(255,255,255,.7);margin-top:4px">${dayLabel} · ${filledSlots.length} de ${MEAL_SLOTS.length} comidas registradas</div>
      </td></tr>
      ${totalsHtml}
      ${slotsHtml}
    </table>
  </td></tr>
</table></body></html>`;

    if (env.RESEND_API_KEY) {
      const trainerEmail = await resolveTrainerEmail(env, athlete);
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Mi Rutina <noreply@mirutinapp.com>',
          to: trainerEmail,
          subject: `🍽️ Reporte diario — ${athlete.name} (${filledSlots.length}/${MEAL_SLOTS.length} comidas)`,
          html: emailHtml
        })
      }).catch(err => console.error('daily meal report failed for', athlete.clientId, err?.message));
    }
    } catch (err) {
      console.error('[sendDailyMealReport] error for', athlete.clientId, err?.message);
    }
  }
}

// ── Workout reminder (1 PM Colombia, only if no session completed today) ──
async function sendWorkoutReminder(env) {
  const coDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  const todayKey = `${coDate.getFullYear()}-${String(coDate.getMonth()+1).padStart(2,'0')}-${String(coDate.getDate()).padStart(2,'0')}`;
  const dayLabel = coDate.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
  if (coDate.getDay() === 0) return; // domingo libre

  for (const athlete of await listAthletes(env)) {
    try {
    const clientId = athlete.clientId;
    if (!athlete.email) continue;
    const routine = await env.DB.get(`routine:${clientId}`, 'json');
    if (!routine) continue;

    const completions = await env.DB.get(`completions:${clientId}`, 'json') || [];
    if (completions.some(c => c.day === todayKey)) continue;

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0" bgcolor="#0f1117">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#0f1117" style="background:#0f1117;font-family:-apple-system,Helvetica,sans-serif">
  <tr><td align="center" style="padding:24px 16px">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
      <tr><td style="background:linear-gradient(135deg,#059669,#34d399);border-radius:16px;padding:24px">
        <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:rgba(255,255,255,.8);text-transform:uppercase;margin-bottom:6px">Recordatorio de entrenamiento</div>
        <div style="font-size:28px;font-weight:800;color:#fff">💪 ${athlete.name}</div>
        <div style="font-size:13px;color:rgba(255,255,255,.85);margin-top:4px;text-transform:capitalize">${dayLabel}</div>
      </td></tr>
      <tr><td height="16"></td></tr>
      <tr><td bgcolor="#1e2130" style="background:#1e2130;border:1px solid #2d3148;border-radius:12px;padding:20px">
        <p style="margin:0 0 14px;font-size:15px;color:#e2e8f0;line-height:1.6">¡Buenos días! Hoy toca entrenar. Abre la app, revisa tu sesión y dale con todo.</p>
        <a href="https://mirutinapp.com/?client=${clientId}" style="display:inline-block;background:linear-gradient(135deg,#059669,#34d399);color:#fff;font-weight:700;font-size:14px;text-decoration:none;padding:12px 20px;border-radius:10px">Ir a mi rutina</a>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;

    if (env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Mi Rutina <noreply@mirutinapp.com>',
          to: athlete.email,
          subject: `💪 Recordatorio de entrenamiento — ${athlete.name}`,
          html
        })
      }).catch(err => console.error('workout reminder failed for', clientId, err?.message));
    }
    } catch (err) {
      console.error('[sendWorkoutReminder] error for', athlete.clientId, err?.message);
    }
  }
}

// ── Shared: macros totals HTML block ──
function buildMacrosTotalHtml(totals, title) {
  return `
    <tr><td height="16"></td></tr>
    <tr><td bgcolor="#0f1117" style="background:#0f1117;border:2px solid #06b6d4;border-radius:12px;padding:20px">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#06b6d4;text-transform:uppercase;margin-bottom:16px">📊 ${title}</div>
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td width="25%" style="text-align:center;padding:8px"><div style="font-size:24px;font-weight:800;color:#f59e0b">~${totals.cals}</div><div style="font-size:10px;color:#64748b;margin-top:4px;text-transform:uppercase;letter-spacing:.8px">kcal</div></td>
        <td width="25%" style="text-align:center;padding:8px"><div style="font-size:24px;font-weight:800;color:#34d399">~${totals.prot}g</div><div style="font-size:10px;color:#64748b;margin-top:4px;text-transform:uppercase;letter-spacing:.8px">proteína</div></td>
        <td width="25%" style="text-align:center;padding:8px"><div style="font-size:24px;font-weight:800;color:#818cf8">~${totals.carbs}g</div><div style="font-size:10px;color:#64748b;margin-top:4px;text-transform:uppercase;letter-spacing:.8px">carbos</div></td>
        <td width="25%" style="text-align:center;padding:8px"><div style="font-size:24px;font-weight:800;color:#f87171">~${totals.fat}g</div><div style="font-size:10px;color:#64748b;margin-top:4px;text-transform:uppercase;letter-spacing:.8px">grasas</div></td>
      </tr></table>
    </td></tr>`;
}

// ── Weekly report (Saturday 8 PM Colombia = Sunday 01:00 UTC) ──
async function sendWeeklyReport(env) {
  const MEAL_SLOTS = [
    { key: 'desayuno', label: 'Desayuno', icon: '☀️' },
    { key: 'mediasNueves', label: 'Medias nueves', icon: '🍎' },
    { key: 'almuerzo', label: 'Almuerzo', icon: '🍽️' },
    { key: 'onces', label: 'Onces', icon: '☕' },
    { key: 'comida', label: 'Cena', icon: '🌙' }
  ];

  const week = getWeekRange(null);
  const dateSet = new Set(week.dates);

  for (const athlete of await listAthletes(env)) {
    if (sinEntrenador(athlete)) continue;
    try {
    const clientId = athlete.clientId;
    const [completions, meals] = await Promise.all([
      env.DB.get(`completions:${clientId}`, 'json'),
      env.DB.get(`meals:${clientId}`, 'json')
    ]);
    const weekCompletions = (completions || []).filter(r => dateSet.has(r.day));
    const weekMeals = (meals || []).filter(r => dateSet.has(r.day)).sort((a, b) => a.day.localeCompare(b.day));

    if (weekCompletions.length === 0 && weekMeals.length === 0) continue;

    // Aggregate weekly macros
    const totals = { cals: 0, prot: 0, carbs: 0, fat: 0, count: 0 };
    for (const meal of weekMeals) {
      if (!meal.analyses) continue;
      for (const sk of Object.keys(meal.analyses)) {
        const m = parseMacros(meal.analyses[sk]);
        if (m) { totals.cals += m.cals; totals.prot += m.prot; totals.carbs += m.carbs; totals.fat += m.fat; totals.count++; }
      }
    }

    // Build sessions section
    let sessionsHtml = '';
    if (weekCompletions.length > 0) {
      sessionsHtml = `
        <tr><td height="20"></td></tr>
        <tr><td><div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#34d399;text-transform:uppercase;margin-bottom:12px">✅ SESIONES COMPLETADAS (${weekCompletions.length})</div></td></tr>`;
      for (const c of weekCompletions) {
        sessionsHtml += `
        <tr><td bgcolor="#1e2130" style="background:#1e2130;border:1px solid #2d3148;border-radius:12px;padding:16px;margin-bottom:8px">
          <div style="font-size:16px;font-weight:700;color:#e2e8f0">${c.dayLabel || c.day}</div>
          <div style="font-size:11px;color:#64748b;margin-top:4px">${c.date || ''}</div>
          ${c.notes ? `<div style="font-size:13px;color:#94a3b8;margin-top:8px;border-left:2px solid #34d399;padding-left:10px">${c.notes}</div>` : ''}
        </td></tr>
        <tr><td height="8"></td></tr>`;
      }
    }

    // Build meals section by day
    let mealsHtml = '';
    if (weekMeals.length > 0) {
      mealsHtml = `
        <tr><td height="20"></td></tr>
        <tr><td><div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#06b6d4;text-transform:uppercase;margin-bottom:12px">🍽️ COMIDAS POR DÍA</div></td></tr>`;
      for (const dayRec of weekMeals) {
        const filledSlots = MEAL_SLOTS.filter(s => dayRec.meals?.[s.key] || dayRec.photos?.[s.key]);
        if (filledSlots.length === 0) continue;
        mealsHtml += `
        <tr><td bgcolor="#1e2130" style="background:#1e2130;border:1px solid #2d3148;border-radius:12px;padding:16px">
          <div style="font-size:14px;font-weight:700;color:#e2e8f0;margin-bottom:12px">${dayRec.dayLabel || dayRec.day} <span style="color:#64748b;font-weight:400">· ${filledSlots.length} comidas</span></div>`;
        for (const slot of filledSlots) {
          const text = dayRec.meals?.[slot.key] || '';
          const photo = dayRec.photos?.[slot.key] || '';
          const analysis = dayRec.analyses?.[slot.key] || '';
          mealsHtml += `
            <div style="margin-bottom:12px;padding:12px;background:#0f1117;border-radius:8px">
              <div style="font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">${slot.icon} ${slot.label}</div>
              ${text ? `<div style="font-size:13px;color:#cbd5e1;margin-bottom:6px">${text}</div>` : ''}
              ${photo ? `<img src="${photo}" style="width:100%;max-width:300px;border-radius:8px;display:block;margin-bottom:6px">` : ''}
              ${analysis ? `<div style="font-size:12px;color:#94a3b8;border-left:2px solid #06b6d4;padding-left:8px;white-space:pre-line">${analysis}</div>` : ''}
            </div>`;
        }
        mealsHtml += `</td></tr><tr><td height="8"></td></tr>`;
      }
    }

    const totalsHtml = totals.count > 0 ? buildMacrosTotalHtml(totals, `TOTALES DE LA SEMANA (${totals.count} comidas analizadas)`) : '';

    const emailHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0" bgcolor="#0f1117">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#0f1117" style="background:#0f1117;font-family:-apple-system,Helvetica,sans-serif">
  <tr><td align="center" style="padding:24px 16px">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
      <tr><td style="background:linear-gradient(135deg,#6366f1,#06b6d4);border-radius:16px;padding:24px">
        <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:rgba(255,255,255,.7);text-transform:uppercase;margin-bottom:6px">Resumen semanal</div>
        <div style="font-size:28px;font-weight:800;color:#fff">📊 ${athlete.name}</div>
        <div style="font-size:13px;color:rgba(255,255,255,.7);margin-top:4px">${week.label} · ${weekCompletions.length} sesiones · ${weekMeals.length} días con comidas</div>
      </td></tr>
      ${totalsHtml}
      ${sessionsHtml}
      ${mealsHtml}
    </table>
  </td></tr>
</table></body></html>`;

    if (env.RESEND_API_KEY) {
      const trainerEmail = await resolveTrainerEmail(env, athlete);
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Mi Rutina <noreply@mirutinapp.com>',
          to: trainerEmail,
          subject: `📊 Resumen semanal — ${athlete.name} (${week.label})`,
          html: emailHtml
        })
      }).catch(err => console.error('weekly report failed for', athlete.clientId, err?.message));
    }
    } catch (err) {
      console.error('[sendWeeklyReport] error for', athlete.clientId, err?.message);
    }
  }
}
