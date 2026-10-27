/* ── Rediseño semanal ────────────────────────────────────────────────
   Cada domingo el modelo actúa como entrenador: rearma cada sesión con
   ejercicios nuevos Y otra estructura cuando tiene sentido (superseries,
   triseries, 3 vueltas en lo pesado), con los pesos que ya se conocen.
   Aquí está lo que no se le deja al modelo: qué puede elegir (fichas) y
   qué se acepta (validar). Lo que no pase, se queda como estaba.

   Reglas fijas: cada sesión conserva sus grupos musculares (la división de
   la semana no se toca); los básicos "ancla" que aún progresan se quedan;
   el volumen de la sesión no se dispara; nada de lo que acaba de salir
   vuelve todavía. El calentamiento: en tren superior siempre hombro, y
   siempre el grupo del día — los ejercicios pueden variar. */

import { PorNombre, PorMusculo } from './catalogo-ejercicios.js';
import { tipoDe, cargaParaElAtleta, cargaSugerida, rangoDeRepsPara, filtroDelAtleta, perfilDeCarga } from './plan-ia.js';

const DIA = 86400000;
const SEMANAS_ANCLA = 6;          // un básico se queda hasta 6 semanas si progresa
const SEMANAS_FUERA = 2;          // lo que sale no vuelve antes de 2 semanas
export const CALENTAMIENTO_HOMBRO = [
  'Elevaciones laterales con mancuernas', 'Elevaciones frontales alternas con mancuernas',
  'Press de hombro de pie con mancuernas', 'Face Pull con cuerda en polea', 'Pájaros con mancuernas inclinado',
  'Cuban press con mancuernas', 'Elevación lateral en polea', 'Vuelos laterales sentada',
].filter(n => PorNombre[n]);
const NOMBRE_BLOQUE = { 1: 'Serie', 2: 'Superserie', 3: 'Triserie' };
const INFERIOR = new Set(['cuadriceps', 'isquio', 'gluteo', 'pantorrilla']);

const sesionesDe = r => Object.keys(r || {}).filter(k => /^sesion\d+$/.test(k) && r[k] && Array.isArray(r[k].circuits));
const ejerciciosDe = dia => (dia.circuits || []).flatMap(c => c.exercises || []).filter(e => e && e.name);
const semanas = (ex, hoy, inicio) => Math.floor((Date.parse(hoy) - Date.parse(ex.desde || inicio)) / (7 * DIA));
const seriesDe = dia => (dia.circuits || []).reduce((t, c) => t + (parseInt(c.series) || 4) * (c.exercises || []).length, 0);

/* Lo que el modelo necesita ver para decidir, por sesión */
export function fichasParaRediseno({ rutina, cargas, marcas, estancados = [], hoy, inicio, atleta, ficha }) {
  const vale = filtroDelAtleta(atleta && atleta.encuesta);
  const enRutina = new Set(sesionesDe(rutina).flatMap(k => ejerciciosDe(rutina[k]).map(e => e.name)));
  const reciente = nm => { const c = (cargas || {})[nm]; return !enRutina.has(nm) && !!(c && c.fecha && Date.parse(hoy) - Date.parse(c.fecha) < SEMANAS_FUERA * 7 * DIA); };
  const tend = nm => ficha && ficha.ejercicios && ficha.ejercicios[nm] ? ficha.ejercicios[nm].tendencia : null;
  const sesiones = sesionesDe(rutina).map(k => {
    const dia = rutina[k];
    const exs = ejerciciosDe(dia);
    const musculos = [...new Set(exs.map(e => e.muscle).filter(Boolean))];
    // Anclas: hasta 2 básicos que aún progresan (menos de 6 semanas, no estancados)
    const anclas = exs.filter(e => { const c = PorNombre[e.name]; return c && tipoDe(c) === 'C' && c.unit !== 'corporal'
      && semanas(e, hoy, inicio) < SEMANAS_ANCLA && !estancados.includes(e.name); }).slice(0, 2).map(e => e.name);
    const opciones = {};
    for (const m of musculos) {
      opciones[m] = (PorMusculo[m] || []).filter(e => vale(e) && !reciente(e.name)).map(e => {
        const c = (cargas || {})[e.name];
        return `${e.name} [${tipoDe(e) === 'C' ? 'básico' : 'accesorio'}${c && c.w1 ? ', ya lo hizo: ' + c.w1 : ''}]`;
      });
    }
    return {
      sesion: k, titulo: dia.title || '', musculos, anclas, seriesTotales: seriesDe(dia),
      bloques: (dia.circuits || []).map(c => ({
        nombre: c.label || '', series: parseInt(c.series) || 4, descanso: parseInt(c.rest) || 60,
        ejercicios: (c.exercises || []).map(e => ({
          nombre: e.name, musculo: e.muscle, carga: e.w1 || 'corporal', reps: e.repNow || null,
          semanas: semanas(e, hoy, inicio), marca: (marcas || {})[k + '|' + e.name] || null, tendencia: tend(e.name) || undefined,
        })),
      })),
      opciones,
    };
  });
  return { sesiones, calentamientoHombro: CALENTAMIENTO_HOMBRO };
}

function ejercicioNuevo(cat, cargas, perfil, hoy) {
  const [lo, hi] = rangoDeRepsPara(cat.name);
  const est = cargaParaElAtleta(cat, cargas, perfil);
  const w1 = est ? est.w1 : (cat.unit === 'corporal' ? '' : cargaSugerida(cat, perfil));
  let repNow = est && est.reps ? Math.min(hi, Math.max(lo, est.reps)) : lo;
  repNow += repNow % 2;
  if (repNow > hi) repNow = hi - (hi % 2);
  return {
    name: cat.name, muscle: cat.muscle, unit: cat.unit, step: cat.step, img: cat.img, tip: cat.tip,
    w1, reps: repNow + ' reps', repMin: lo, repMax: hi, repNow, fallos: 0,
    calibrar: cat.unit !== 'corporal' && !(est && est.origen === 'su último peso'),
    desde: hoy,
  };
}

/* Revisa la propuesta y arma la rutina nueva. Lo que no cumple, se rechaza
   por sesión (esa sesión queda como estaba). No toca `rutina`: devuelve
   una copia. */
export function validarRediseno(propuesta, { rutina, cargas, atleta, hoy, contexto }) {
  const perfil = perfilDeCarga(atleta);
  const vale = filtroDelAtleta(atleta && atleta.encuesta);
  const nueva = JSON.parse(JSON.stringify(rutina));
  const aceptadas = [], rechazadas = [];
  // El estado de cada ejercicio (peso, reps, fallos, desde…) viaja con él
  const actuales = new Map();
  for (const k of sesionesDe(rutina)) for (const e of ejerciciosDe(rutina[k])) if (!actuales.has(k + '|' + e.name)) actuales.set(k + '|' + e.name, e);
  const enCualquiera = new Map();
  for (const k of sesionesDe(rutina)) for (const e of ejerciciosDe(rutina[k])) if (!enCualquiera.has(e.name)) enCualquiera.set(e.name, e);

  for (const p of Array.isArray(propuesta) ? propuesta : []) {
    const ctx = contexto.sesiones.find(s => s.sesion === (p && p.sesion));
    const motivo = m => { rechazadas.push({ sesion: p && p.sesion, motivo: m }); };
    if (!ctx || !Array.isArray(p.bloques)) { motivo('sesión o bloques inválidos'); continue; }
    if (aceptadas.some(a => a.sesion === ctx.sesion)) { motivo('repetida'); continue; }
    const permitidos = new Set(ctx.musculos);
    const vistos = new Set();
    let error = null;
    const circuits = [];
    p.bloques.slice(0, 6).forEach((b, bi) => {
      if (error) return;
      const nombres = (Array.isArray(b && b.ejercicios) ? b.ejercicios : []).map(n => String(n || '').replace(/\s*\[.*\]\s*$/, '').trim());
      if (nombres.length < 1 || nombres.length > 4) { error = `bloque ${bi + 1} con ${nombres.length} ejercicios`; return; }
      const series = Math.round(Number(b.series));
      if (!(series >= 2 && series <= 5)) { error = `bloque ${bi + 1}: ${b.series} series`; return; }
      const descanso = Math.round(Number(b.descanso) || 60);
      const exs = [];
      for (const n of nombres) {
        const cat = PorNombre[n];
        if (!cat) { error = `"${n}" no está en el catálogo`; return; }
        if (!permitidos.has(cat.muscle)) { error = `"${n}" es de ${cat.muscle}, no de este día`; return; }
        if (vistos.has(n)) { error = `"${n}" repetido`; return; }
        if (!vale(cat)) { error = `"${n}" no le sirve (equipo o molestia)`; return; }
        vistos.add(n);
        const viejo = actuales.get(ctx.sesion + '|' + n) || enCualquiera.get(n);
        if (!viejo && !ctx.opciones[cat.muscle].some(o => o.startsWith(n + ' ['))) { error = `"${n}" salió hace poco`; return; }
        exs.push(viejo ? JSON.parse(JSON.stringify(viejo)) : ejercicioNuevo(cat, cargas, perfil, hoy));
      }
      const tipo = NOMBRE_BLOQUE[exs.length] || 'Circuito';
      const nota = String(b.nota || '').trim().slice(0, 140)
        || (exs.length === 2 ? 'Los dos seguidos, sin descanso entre ellos; descansa al terminar la vuelta.'
          : exs.length === 3 ? 'Los tres seguidos; descansa al terminar la vuelta.' : '');
      circuits.push({ label: `${tipo} ${bi + 1}`, cls: 'c' + ((bi % 3) + 1), rest: `${Math.min(120, Math.max(30, descanso))}s descanso`,
                      series, ...(nota ? { nota } : {}), exercises: exs });
    });
    if (error) { motivo(error); continue; }
    const total = circuits.reduce((t, c) => t + c.exercises.length, 0);
    if (total < 5 || total > 10) { motivo(`${total} ejercicios`); continue; }
    const faltan = ctx.anclas.filter(a => !vistos.has(a));
    if (faltan.length) { motivo('quitó los básicos ancla: ' + faltan.join(', ')); continue; }
    const series = circuits.reduce((t, c) => t + c.series * c.exercises.length, 0);
    if (series < ctx.seriesTotales * 0.7 || series > ctx.seriesTotales * 1.25) { motivo(`${series} series contra ${ctx.seriesTotales}`); continue; }
    // Cada grupo del día sigue teniendo trabajo
    const cubiertos = new Set(circuits.flatMap(c => c.exercises.map(e => e.muscle)));
    const sinTrabajo = ctx.musculos.filter(m => !cubiertos.has(m) && m !== 'abdomen');
    if (sinTrabajo.length) { motivo('dejó sin trabajo: ' + sinTrabajo.join(', ')); continue; }

    // Calentamiento: hombro (si es tren superior) + el grupo del día
    const superior = ctx.musculos.some(m => !INFERIOR.has(m) && m !== 'abdomen');
    const hombro = (Array.isArray(p.calentamientoHombro) ? p.calentamientoHombro : [])
      .map(n => String(n || '').trim()).filter(n => CALENTAMIENTO_HOMBRO.includes(n)).slice(0, 3);
    const antes = ejerciciosDe(rutina[ctx.sesion]).map(e => e.name);
    const ahora = circuits.flatMap(c => c.exercises.map(e => e.name));
    nueva[ctx.sesion].circuits = circuits;
    nueva[ctx.sesion].calentamientoPlan = superior && hombro.length >= 2 ? { hombro } : {};
    aceptadas.push({
      sesion: ctx.sesion,
      sale: antes.filter(n => !ahora.includes(n)),
      entra: ahora.filter(n => !antes.includes(n)),
      estructura: circuits.map(c => `${c.label} (${c.series}×)`).join(', '),
      porque: String(p.porque || '').trim().slice(0, 300),
    });
  }
  return { rutina: nueva, aceptadas, rechazadas };
}

/* Para la tarjeta del ajuste: qué entra y por qué sale (empareja por músculo) */
export function rotacionesDeRediseno(aceptadas, rutinaNueva) {
  const out = [];
  for (const a of aceptadas) {
    const libres = [...a.sale];
    for (const n of a.entra) {
      const m = (PorNombre[n] || {}).muscle;
      const i = libres.findIndex(s => (PorNombre[s] || {}).muscle === m);
      const de = i >= 0 ? libres.splice(i, 1)[0] : '';
      const ex = ejerciciosDe(rutinaNueva[a.sesion]).find(e => e.name === n) || {};
      const c = (rutinaNueva[a.sesion].circuits || []).find(c => (c.exercises || []).some(e => e.name === n)) || {};
      out.push({ sesion: a.sesion, circuito: c.label || '', de, a: n, peso: ex.w1 || '', porque: a.porque, rediseno: true });
    }
  }
  return out;
}
