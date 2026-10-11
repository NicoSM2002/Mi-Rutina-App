/* ── La ficha de cada atleta ─────────────────────────────────────────
   Todo lo que se sabe de una persona, ordenado en un solo lugar: quién es,
   cómo ha ido cada ejercicio (primera vez, última, mejor marca, tendencia),
   su fuerza por músculo, su constancia y lo que ha contado (molestias,
   preferencias, equipo que no hay). Se rehace cada domingo desde los datos
   crudos — sesiones, ajustes, cargas, chat — así que nunca se desordena ni
   pierde nada: si algo se borra de aquí, se vuelve a armar.

   Esta parte es puro cálculo. Lo que se entiende leyendo sus notas y el
   chat (`sabeDeTi`, `resumen`) lo pone el worker con el modelo. */

import { PorNombre } from './catalogo-ejercicios.js';
import { cargaTotal, tipoDe, fuerzaRelativa, perfilDeCarga } from './plan-ia.js';

const DIA = 86400000;

/* 1RM estimado (Epley): sirve para comparar 10 reps con 60 contra 8 con 65 */
function e1rm(ex, w1, reps) {
  const t = cargaTotal(PorNombre[ex] || { name: ex, unit: 'placa' }, w1);
  const r = parseInt(reps) || 0;
  return t && r ? Math.round(t * (1 + r / 30)) : null;
}

function lunesDe(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/* Cada vez que hizo cada ejercicio: de la foto de la sesión (lo que tenía
   puesto ese día), con su marca y su nota; y si anotó que usó otra carga,
   esa manda (sale de los ajustes semanales). */
function historiaPorEjercicio(completions, progresion) {
  const corregidoEn = [];   // [{ desde, hasta, name, w1, reps }]
  for (const h of progresion || []) {
    const hasta = Date.parse(h.fecha), desde = hasta - 7 * DIA;
    for (const c of (h.corregidos || [])) corregidoEn.push({ desde, hasta, name: c.name, w1: c.a, reps: c.repsA });
  }
  const hist = {};
  const orden = [...(completions || [])].filter(c => c && c.day).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  for (const c of orden) {
    const fb = new Map((Array.isArray(c.feedback) ? c.feedback : []).filter(f => f && f.name).map(f => [f.name, f]));
    for (const circ of ((c.snapshot && c.snapshot.circuits) || [])) {
      for (const e of (circ.exercises || [])) {
        if (!e || !e.name) continue;
        const f = fb.get(e.name);
        const cor = corregidoEn.find(x => x.name === e.name && (c.ts || 0) >= x.desde && (c.ts || 0) <= x.hasta);
        // En un drop set o una pirámide la carga va en los escalones: cuenta el más pesado
        const escalones = Array.isArray(e.steps1) ? e.steps1.filter(x => x && x.w) : [];
        const top = escalones.length && (e.setType === 'dropset' || e.setType === 'piramidal' || !e.w1)
          ? escalones.reduce((a, b) => (parseFloat(b.w) || 0) > (parseFloat(a.w) || 0) ? b : a) : null;
        const w1 = cor && cor.w1 ? cor.w1 : top ? top.w : (e.w1 || '');
        const reps = (cor && cor.reps) || (top && parseInt(top.reps)) || parseInt(e.repNow) || parseInt(e.reps) || null;
        (hist[e.name] = hist[e.name] || []).push({
          fecha: c.day, w1, reps, resp: (f && f.resp) || null, nota: String((f && f.nota) || '').trim(),
          // Una sesión completada se hizo: lo que tenía puesto es lo que levantó
          // (con su entrenador o con el plan), salvo que anotara otra cosa
          fuente: cor ? 'lo anotó' : f && f.resp ? 'marcado' : 'hecho sin marca',
          e1rm: e1rm(e.name, w1, reps),
        });
      }
    }
  }
  // Datos que no cuadran (un "4 lbs", un peso que dobla lo que hace hoy): se
  // marcan como dudosos y no cuentan. Se comparan con lo último que marcó o
  // anotó; si nunca marcó, con la mediana de lo demás.
  for (const puntos of Object.values(hist)) {
    const reales = puntos.filter(p => p.e1rm && p.fuente !== 'hecho sin marca');
    const ref = reales.length ? reales[reales.length - 1].e1rm : (() => {
      const xs = puntos.map(p => p.e1rm).filter(Boolean).sort((a, b) => a - b);
      return xs.length >= 3 ? xs[xs.length >> 1] : null; })();
    for (const p of puntos) {
      if (!p.e1rm || !ref || p.fuente !== 'hecho sin marca') continue;
      const r = p.e1rm / ref;
      if (r > 1.8 || r < 0.5) p.dudoso = true;
    }
  }
  return hist;
}

/* Con todo lo que hizo (también con su entrenador), menos lo dudoso */
function tendenciaDe(puntos) {
  const con = puntos.filter(p => p.e1rm && !p.dudoso);
  if (con.length < 2) return 'sin datos suficientes';
  const ult = con[con.length - 1];
  const antes = [...con].reverse().find(p => Date.parse(ult.fecha) - Date.parse(p.fecha) >= 14 * DIA) || con[0];
  if (antes === ult) return 'sin datos suficientes';
  const d = (ult.e1rm - antes.e1rm) / antes.e1rm;
  return d > 0.03 ? 'sube' : d < -0.03 ? 'baja' : 'estable';
}

export function armarFicha({ atleta, rutina, completions, progresion, cargas, previa }) {
  const enc = (atleta && atleta.encuesta) || {};
  const prof = (atleta && atleta.profile) || {};
  const perfil = perfilDeCarga(atleta);
  const dias = Array.isArray(atleta && atleta.trainingDays) && atleta.trainingDays.length ? atleta.trainingDays : [1, 2, 3, 4, 5];
  const meta = parseInt(atleta && atleta.sessionsPerWeek) || dias.length;

  // Lo que tiene ahora en la rutina
  const actuales = new Map();
  for (const k of Object.keys(rutina || {}).filter(k => /^sesion\d+$/.test(k))) {
    for (const c of ((rutina[k] && rutina[k].circuits) || [])) {
      for (const e of (c.exercises || [])) actuales.set(e.name, { sesion: k, series: parseInt(c.series) || 0, ex: e });
    }
  }

  const hist = historiaPorEjercicio(completions, progresion);
  const ejercicios = {};
  const nombres = new Set([...Object.keys(hist), ...actuales.keys(), ...Object.keys(cargas || {})]);
  for (const nm of nombres) {
    const cat = PorNombre[nm];
    const puntos = hist[nm] || [];
    const marcas = { facil: 0, justo: 0, fallo: 0 };
    for (const p of puntos) if (marcas[p.resp] !== undefined) marcas[p.resp]++;
    const validos = puntos.filter(p => !p.dudoso);
    const mejor = validos.filter(p => p.e1rm).sort((a, b) => b.e1rm - a.e1rm)[0] || null;
    const ultimoPeso = [...validos].reverse().find(p => p.w1) || null;
    const dudosos = puntos.filter(p => p.dudoso).map(p => ({ fecha: p.fecha, w1: p.w1, reps: p.reps }));
    const act = actuales.get(nm);
    const c = (cargas || {})[nm];
    ejercicios[nm] = {
      musculo: (cat && cat.muscle) || (act && act.ex.muscle) || (c && c.muscle) || '',
      tipo: cat ? (tipoDe(cat) === 'C' ? 'básico' : 'accesorio') : '',
      enRutina: !!act,
      ...(act ? { ahora: { sesion: act.sesion, w1: act.ex.w1 || '', reps: act.ex.repNow || null,
                          rango: act.ex.repMin && act.ex.repMax ? act.ex.repMin + '-' + act.ex.repMax : '',
                          desde: act.ex.desde || '' } } : {}),
      vecesHecho: puntos.length,
      ...(puntos.length ? {
        primera: { fecha: puntos[0].fecha, w1: puntos[0].w1, reps: puntos[0].reps },
        ultima: { fecha: puntos[puntos.length - 1].fecha, w1: puntos[puntos.length - 1].w1,
                  reps: puntos[puntos.length - 1].reps, resp: puntos[puntos.length - 1].resp },
      } : {}),
      ...(mejor ? { mejor: { fecha: mejor.fecha, w1: mejor.w1, reps: mejor.reps, e1rm: mejor.e1rm } } : {}),
      ...(ultimoPeso ? { ultimoPeso: { fecha: ultimoPeso.fecha, w1: ultimoPeso.w1, reps: ultimoPeso.reps } } : {}),
      ...(dudosos.length ? { dudosos } : {}),
      tendencia: tendenciaDe(puntos),
      marcas,
      notas: puntos.filter(p => p.nota).slice(-3).map(p => ({ fecha: p.fecha, nota: p.nota.slice(0, 200) })),
    };
  }

  // Por músculo: fuerza frente a un intermedio de su peso, series de la
  // semana y qué ha probado
  const musculos = {};
  for (const [nm, e] of Object.entries(ejercicios)) {
    if (!e.musculo) continue;
    const m = musculos[e.musculo] = musculos[e.musculo] || { seriesSemana: 0, actuales: [], probados: [] };
    if (e.enRutina) { m.actuales.push(nm); m.seriesSemana += (actuales.get(nm) || {}).series || 0; }
    else if (e.vecesHecho) m.probados.push(nm);
  }
  for (const [mu, m] of Object.entries(musculos)) {
    const fb = fuerzaRelativa(mu, true, cargas, perfil), fa = fuerzaRelativa(mu, false, cargas, perfil);
    if (fb !== null) m.fuerzaBasicos = Math.round(fb * 100) / 100;
    if (fa !== null) m.fuerzaAccesorios = Math.round(fa * 100) / 100;
  }

  // Constancia: sesiones por semana, las últimas 8
  const porSemana = {};
  for (const c of (completions || [])) if (c && c.day) porSemana[lunesDe(c.day)] = (porSemana[lunesDe(c.day)] || 0) + 1;
  const semanas = Object.keys(porSemana).sort().slice(-8).map(s => ({ semana: s, hechas: porSemana[s], meta }));

  // Molestias que el ajuste semanal detectó en sus notas, con su semana
  const molestiasDetectadas = [];
  for (const h of (progresion || [])) for (const nm of (h.molestias || [])) molestiasDetectadas.push({ semana: h.semana, ejercicio: nm });

  const fechas = (completions || []).map(c => c && c.day).filter(Boolean).sort();
  return {
    version: 1,
    actualizada: new Date().toISOString(),
    persona: {
      nombre: (atleta && atleta.name) || '',
      peso: Number(enc.peso) || Number(prof.weight) || null,
      estatura: Number(enc.estatura) || Number(prof.height) || null,
      sexo: enc.sexo || prof.sex || null,
      objetivo: enc.objetivo || prof.goal || null,
      nivel: enc.nivel || prof.level || null,
      dias, minutos: enc.minutos || null, lugar: enc.lugar || null,
      molestiasDeLaEncuesta: [...(enc.molestias || []), ...(enc.molestiaTexto ? [enc.molestiaTexto] : [])],
    },
    historia: {
      primeraSesion: fechas[0] || null, ultimaSesion: fechas[fechas.length - 1] || null,
      sesionesTotales: fechas.length, ajustesSemanales: (progresion || []).length,
      rotaciones: (progresion || []).flatMap(h => (h.rotaciones || []).map(r => ({ semana: h.semana, sale: r.de, entra: r.a }))),
    },
    constancia: semanas,
    ejercicios,
    musculos,
    molestiasDetectadas,
    // Lo que entiende el modelo de sus notas y el chat: se conserva de la
    // ficha anterior y el worker lo pone al día
    sabeDeTi: (previa && previa.sabeDeTi) || { molestias: [], preferencias: [], equipo: [], otros: [] },
    resumen: (previa && previa.resumen) || '',
    leidoHasta: (previa && previa.leidoHasta) || 0,
  };
}

/* La ficha en pocas líneas, para meterla en un prompt */
export function fichaParaPrompt(f, { ejercicios = true } = {}) {
  if (!f) return '';
  const s = f.sabeDeTi || {};
  const lineas = [];
  if (f.resumen) lineas.push('Lo que sabes de esta persona:\n' + f.resumen);
  const lista = (t, xs, fmt) => { if (xs && xs.length) lineas.push(t + ':\n' + xs.map(x => '- ' + fmt(x)).join('\n')); };
  lista('Molestias que ha contado', s.molestias, x => `${x.detalle || x.texto || ''}${x.fecha ? ' (' + x.fecha + ')' : ''}${x.vigente === false ? ' — ya pasó' : ''}`);
  lista('Preferencias', s.preferencias, x => x.texto || x);
  lista('Equipo que no tiene o no le sirve', s.equipo, x => x.texto || x);
  if (ejercicios) {
    const probados = Object.entries(f.ejercicios || {}).filter(([, e]) => e.vecesHecho && !e.enRutina)
      .map(([n, e]) => `${n}: ${e.vecesHecho} veces, último ${e.ultima ? e.ultima.w1 + ' × ' + (e.ultima.reps || '?') : '?'}`
        + (e.marcas.fallo ? `, ${e.marcas.fallo} "no llegué"` : '') + (e.notas.length ? `; dijo: "${e.notas[e.notas.length - 1].nota}"` : ''));
    lista('Ejercicios que ya hizo y no tiene ahora', probados.slice(0, 40), x => x);
  }
  return lineas.join('\n\n');
}
