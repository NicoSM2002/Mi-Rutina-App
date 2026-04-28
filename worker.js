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
  const records = [];
  for (const id of ids) {
    const a = await env.DB.get(`athlete:${id}`, 'json');
    if (!a) continue;
    if (!includeArchived && a.archived) continue;
    records.push(a);
  }
  return records;
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
  return null;
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
      const all = await listAthletes(env);
      const match = all.find(a => (a.username || a.clientId) === username);
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
          profile: match.profile || {}
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
      records.unshift(entry);
      if (records.length > 200) records = records.slice(0, 200);
      await env.DB.put(kvKey, JSON.stringify(records));

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
      const renderCircuitBlock = (c, idx) => {
        const nSeries = parseInt(c.series) || 4;
        const restSec = parseInt(c.rest) || 60;
        const exRows = (c.exercises || []).map(ex => {
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
            <div style="font-size:14px;font-weight:600;color:#e2e8f0">${esc(ex.name)}${muscleChip}</div>
            ${wrHtml}
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
      const athletes = await listAthletes(env, { includeArchived: !!body.includeArchived });
      // Full record solo con token de trainer o admin. Público → solo campos mínimos
      // necesarios para login y para que el portal muestre cards.
      const isPrivileged = body.token === 'ent2026' || body.admin === 'admin2026';
      if (isPrivileged) {
        return new Response(JSON.stringify({ ok: true, athletes }), { headers: cors });
      }
      const safe = athletes.map(a => ({
        clientId: a.clientId, username: a.username, name: a.name,
        photoUrl: a.photoUrl || null, trainerId: a.trainerId || null,
        sessionsPerWeek: a.sessionsPerWeek || null
      }));
      return new Response(JSON.stringify({ ok: true, athletes: safe }), { headers: cors });
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
      <tr><td style="background:linear-gradient(135deg,#FF6B2C,#FFB547);border-radius:16px;padding:24px">
        <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:rgba(255,255,255,.9);text-transform:uppercase;margin-bottom:6px">Bienvenido a Mi Rutina</div>
        <div style="font-size:28px;font-weight:800;color:#fff">👋 Hola ${name}</div>
      </td></tr>
      <tr><td height="16"></td></tr>
      <tr><td bgcolor="#1e2130" style="background:#1e2130;border:1px solid #2d3148;border-radius:12px;padding:20px">
        <p style="margin:0 0 14px;font-size:15px;color:#e2e8f0;line-height:1.6">Tu entrenador creó tu perfil. Ya podés entrar a la app para ver tu rutina y registrar tus sesiones.</p>
        <div style="margin:14px 0;padding:14px;background:#0f1117;border:1px solid #2d3148;border-radius:10px">
          <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Tu usuario</div>
          <div style="font-size:20px;font-weight:800;color:#FFB547;font-family:ui-monospace,Menlo,monospace">${username}</div>
        </div>
        <p style="margin:0 0 14px;font-size:13px;color:#94a3b8;line-height:1.5">Entrá con este usuario desde la pantalla "Atleta" la primera vez. Podés agregar la app a la pantalla de inicio de tu celular para abrirla como app.</p>
        <a href="${appUrl}" style="display:inline-block;background:linear-gradient(135deg,#FF6B2C,#FFB547);color:#fff;font-weight:700;font-size:14px;text-decoration:none;padding:12px 20px;border-radius:10px">Abrir Mi Rutina</a>
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
      const updated = {
        ...existing,
        ...patch,
        clientId: existing.clientId,        // immutable (key del KV)
        username: newUsername,              // editable con validación
        trainerId: existing.trainerId,      // immutable desde update (solo hard-delete + create)
        profile: { ...(existing.profile || {}), ...(patch.profile || {}) }
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
      const authErr = await authorizeTrainerForAthlete(env, body, cors);
      if (authErr) return authErr;
      const id = body.clientId;
      const existing = await getAthlete(env, id);
      const ids = (await env.DB.get('athlete-index', 'json')) || [];
      await env.DB.put('athlete-index', JSON.stringify(ids.filter(x => x !== id)));
      if (body.hard) {
        // Hard delete secuencial: si alguno falla, loggeamos y seguimos los
        // otros (sin Promise.all para que un error no deje huérfanos los otros).
        const keys = [`athlete:${id}`, `routine:${id}`, `completions:${id}`, `meals:${id}`, `payment:${id}`, `support-chat:${id}`];
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
        <p style="margin:0 0 14px;font-size:15px;color:#e2e8f0;line-height:1.6">Se creó tu perfil de entrenador en Mi Rutina. Ya podés entrar al portal con tu usuario.</p>
        <div style="margin:14px 0;padding:14px;background:#0f1117;border:1px solid #2d3148;border-radius:10px">
          <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Tu usuario</div>
          <div style="font-size:20px;font-weight:800;color:#818cf8;font-family:ui-monospace,Menlo,monospace">${username}</div>
        </div>
        <p style="margin:0 0 14px;font-size:13px;color:#94a3b8;line-height:1.5">Desde el portal podés crear atletas, armar sus rutinas, ver comidas, pagos y resúmenes semanales.</p>
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
      const msgs = await env.DB.get(`support-chat:${body.trainerId}`, 'json') || [];
      return new Response(JSON.stringify({ ok: true, messages: msgs }), { headers: cors });
    }

    if (body.action === 'send-support-msg') {
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
            <h2 style="margin:0 0 16px;color:#FF6B2C">🎯 Nuevo lead desde la landing</h2>
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:8px 0;color:#666;width:120px">Nombre</td><td style="font-weight:600">${escapeHtml(name)}</td></tr>
              <tr><td style="padding:8px 0;color:#666">Email</td><td><a href="mailto:${escapeHtml(email)}" style="color:#FF6B2C">${escapeHtml(email)}</a></td></tr>
              <tr><td style="padding:8px 0;color:#666">Tipo</td><td>${typeLabel}</td></tr>
              ${whatsapp ? `<tr><td style="padding:8px 0;color:#666">WhatsApp</td><td><a href="https://wa.me/${whatsapp.replace(/[^0-9]/g, '')}" style="color:#FF6B2C">${escapeHtml(whatsapp)}</a></td></tr>` : ''}
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

    if (body.action === 'list-support-chats') {
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
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: body.context || '',
        messages: body.messages || []
      })
    });

    const claudeData = await claudeRes.json();
    console.log('Claude status:', claudeRes.status);
    console.log('Claude response:', JSON.stringify(claudeData).slice(0, 500));

    const content = claudeData.content?.[0]?.text || '';
    return new Response(JSON.stringify({
      ok: true,
      content,
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
      console.log('[CRON] -> sendWeeklyReport');
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
