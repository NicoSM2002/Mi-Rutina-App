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

    const ATHLETES = {
      nicolas:  { name: 'Nicolás Saravia', email: 'nicolas@drakeconstruction.com' },
      msaravia: { name: 'María Saravia',   email: 'nicolas@drakeconstruction.com' },
    };
    const TRAINER_EMAIL = 'nicolas@drakeconstruction.com';

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
      const key = `meals/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
      await env.PHOTOS.put(key, file.stream(), {
        httpMetadata: { contentType: file.type || 'image/jpeg' }
      });
      const publicUrl = `https://pub-b674ba0042be4917ad022c23faf247d9.r2.dev/${key}`;
      return new Response(JSON.stringify({ ok: true, url: publicUrl }), { headers: cors });
    }

    const body = await request.json();
    const client = body.client || 'nicolas';
    const athleteName = ATHLETES[client]?.name || client;

    // ── COMPLETE ROUTINE ──
    if (body.action === 'complete') {
      const nowCO = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
      const isoDate = `${nowCO.getFullYear()}-${String(nowCO.getMonth()+1).padStart(2,'0')}-${String(nowCO.getDate()).padStart(2,'0')}`;
      const entry = {
        day: isoDate,
        dayLabel: body.dayLabel,
        sessionKey: body.day,
        week: body.week,
        notes: body.notes,
        date: new Date().toLocaleDateString('es-CO', { day:'2-digit', month:'2-digit', year:'numeric' }),
        ts: Date.now()
      };

      const kvKey = `completions:${client}`;
      let records = await env.DB.get(kvKey, 'json') || [];
      records.unshift(entry);
      if (records.length > 200) records = records.slice(0, 200);
      await env.DB.put(kvKey, JSON.stringify(records));

      const emailHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0" bgcolor="#0f1117">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#0f1117" style="background:#0f1117;font-family:-apple-system,Helvetica,sans-serif">
  <tr><td align="center" style="padding:24px 16px">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">

      <!-- Header -->
      <tr><td style="background:linear-gradient(135deg,#059669,#34d399);border-radius:16px;padding:24px;margin-bottom:24px">
        <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:rgba(255,255,255,.7);text-transform:uppercase;margin-bottom:6px">Rutina completada</div>
        <div style="font-size:28px;font-weight:800;color:#fff">✅ ${body.dayLabel || body.day}</div>
        <div style="font-size:13px;color:rgba(255,255,255,.7);margin-top:4px">${entry.date} · ${athleteName}</div>
      </td></tr>

      <tr><td height="16"></td></tr>

      <!-- Stats card -->
      <tr><td bgcolor="#1e2130" style="background:#1e2130;border:1px solid #2d3148;border-radius:12px;padding:20px">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td bgcolor="#0f1117" style="background:#0f1117;border-radius:10px;padding:16px;text-align:center">
              <div style="font-size:22px;font-weight:800;color:#34d399">${body.dayLabel || body.day}</div>
              <div style="font-size:11px;color:#64748b;margin-top:4px;text-transform:uppercase;letter-spacing:.8px">Sesión completada</div>
            </td>
          </tr>
          ${body.notes ? `
          <tr><td colspan="3" height="16"></td></tr>
          <tr><td colspan="3" bgcolor="#0f1117" style="background:#0f1117;border-left:3px solid #34d399;border-radius:0 8px 8px 0;padding:14px 16px">
            <div style="font-size:11px;font-weight:700;color:#34d399;letter-spacing:1px;margin-bottom:6px">📝 NOTAS</div>
            <div style="font-size:14px;color:#cbd5e1;line-height:1.5">${body.notes}</div>
          </td></tr>` : ''}
        </table>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Mi Rutina <onboarding@resend.dev>',
          to: TRAINER_EMAIL,
          subject: `✅ ${athleteName} completó: ${body.dayLabel || body.day}`,
          html: emailHtml
        })
      });

      return new Response(JSON.stringify({ ok: true }), { headers: cors });
    }

    // ── MEALS ──
    if (body.action === 'meals') {
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
      const [completions, meals] = await Promise.all([
        env.DB.get(`completions:${client}`, 'json'),
        env.DB.get(`meals:${client}`, 'json')
      ]);
      return new Response(JSON.stringify({
        ok: true,
        completions: completions || [],
        meals: meals || []
      }), { headers: cors });
    }

    // ── GET WEEKLY SUMMARY ──
    if (body.action === 'get-weekly-summary') {
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
      const routine = await env.DB.get(`routine:${client}`, 'json');
      return new Response(JSON.stringify({ ok: true, routine: routine || null }), { headers: cors });
    }

    // ── SAVE ROUTINE ──
    if (body.action === 'save-routine') {
      if (body.token !== 'ent2026') {
        return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { headers: cors });
      }
      await env.DB.put(`routine:${client}`, JSON.stringify(body.routine));

      const athleteEmail = ATHLETES[client]?.email;
      if (athleteEmail) {
        const updatedAt = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'full', timeStyle: 'short' });
        const routineHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0" bgcolor="#0f1117">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#0f1117" style="background:#0f1117;font-family:-apple-system,Helvetica,sans-serif">
  <tr><td align="center" style="padding:24px 16px">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
      <tr><td style="background:linear-gradient(135deg,#f59e0b,#f97316);border-radius:16px;padding:24px">
        <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:rgba(255,255,255,.8);text-transform:uppercase;margin-bottom:6px">Rutina actualizada</div>
        <div style="font-size:28px;font-weight:800;color:#fff">🔄 ${athleteName}</div>
        <div style="font-size:13px;color:rgba(255,255,255,.85);margin-top:4px">${updatedAt}</div>
      </td></tr>
      <tr><td height="16"></td></tr>
      <tr><td bgcolor="#1e2130" style="background:#1e2130;border:1px solid #2d3148;border-radius:12px;padding:20px">
        <p style="margin:0 0 14px;font-size:15px;color:#e2e8f0;line-height:1.6">Tu entrenador actualizó tu rutina. Abre la app para revisar los cambios y arrancar tu próxima sesión.</p>
        <a href="https://mirutina.nicolas-f07.workers.dev/?client=${client}" style="display:inline-block;background:linear-gradient(135deg,#f59e0b,#f97316);color:#fff;font-weight:700;font-size:14px;text-decoration:none;padding:12px 20px;border-radius:10px">Abrir Mi Rutina</a>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;

        ctx.waitUntil(fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Mi Rutina <onboarding@resend.dev>',
            to: athleteEmail,
            subject: `🔄 Rutina actualizada — ${athleteName}`,
            html: routineHtml
          })
        }).catch(() => {}));
      }

      return new Response(JSON.stringify({ ok: true }), { headers: cors });
    }

    // ── GET PAYMENT ──
    if (body.action === 'get-payment') {
      const payment = await env.DB.get(`payment:${client}`, 'json');
      return new Response(JSON.stringify({ ok: true, payment: payment || null }), { headers: cors });
    }

    // ── SAVE PAYMENT ──
    if (body.action === 'save-payment') {
      if (body.token !== 'ent2026' && !body.fields) {
        return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { headers: cors });
      }
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
      msgs.push({ role: body.role, text: body.text, ts: Date.now() });
      if (msgs.length > 500) msgs = msgs.slice(-500);
      await env.DB.put(kvKey, JSON.stringify(msgs));

      // Email notification when trainer sends a message
      if (body.role === 'trainer') {
        const trainerName = ATHLETES[body.trainerId]?.name || body.trainerId;
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Mi Rutina <onboarding@resend.dev>',
            to: TRAINER_EMAIL,
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
    if (event.cron === '0 15 * * 6') {
      await sendWeeklyReport(env);
    } else if (event.cron === '0 18 * * *') {
      await sendWorkoutReminder(env);
    } else {
      await sendDailyMealReport(env);
    }
  }
};

// ── Daily meal report (10 PM Colombia) ──
async function sendDailyMealReport(env) {
  const ATHLETES = { nicolas: { name: 'Nicolás Saravia' }, msaravia: { name: 'María Saravia' } };
  const TRAINER_EMAIL = 'nicolas@drakeconstruction.com';
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

  for (const [clientId, athlete] of Object.entries(ATHLETES)) {
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

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Mi Rutina <onboarding@resend.dev>',
        to: TRAINER_EMAIL,
        subject: `🍽️ Reporte diario — ${athlete.name} (${filledSlots.length}/${MEAL_SLOTS.length} comidas)`,
        html: emailHtml
      })
    });
  }
}

// ── Workout reminder (1 PM Colombia, only if no session completed today) ──
async function sendWorkoutReminder(env) {
  const ATHLETES = {
    nicolas:  { name: 'Nicolás Saravia', email: 'nicolas@drakeconstruction.com' },
    msaravia: { name: 'María Saravia',   email: 'nicolas@drakeconstruction.com' },
  };

  const coDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  const todayKey = `${coDate.getFullYear()}-${String(coDate.getMonth()+1).padStart(2,'0')}-${String(coDate.getDate()).padStart(2,'0')}`;
  const dayLabel = coDate.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
  if (coDate.getDay() === 0) return; // domingo libre

  for (const [clientId, athlete] of Object.entries(ATHLETES)) {
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
        <a href="https://mirutina.nicolas-f07.workers.dev/?client=${clientId}" style="display:inline-block;background:linear-gradient(135deg,#059669,#34d399);color:#fff;font-weight:700;font-size:14px;text-decoration:none;padding:12px 20px;border-radius:10px">Ir a mi rutina</a>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Mi Rutina <onboarding@resend.dev>',
        to: athlete.email,
        subject: `💪 Recordatorio de entrenamiento — ${athlete.name}`,
        html
      })
    }).catch(() => {});
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

// ── Weekly report (Saturday 10 AM Colombia) ──
async function sendWeeklyReport(env) {
  const ATHLETES = { nicolas: { name: 'Nicolás Saravia' }, msaravia: { name: 'María Saravia' } };
  const TRAINER_EMAIL = 'nicolas@drakeconstruction.com';
  const MEAL_SLOTS = [
    { key: 'desayuno', label: 'Desayuno', icon: '☀️' },
    { key: 'mediasNueves', label: 'Medias nueves', icon: '🍎' },
    { key: 'almuerzo', label: 'Almuerzo', icon: '🍽️' },
    { key: 'onces', label: 'Onces', icon: '☕' },
    { key: 'comida', label: 'Cena', icon: '🌙' }
  ];

  const week = getWeekRange(null);
  const dateSet = new Set(week.dates);

  for (const [clientId, athlete] of Object.entries(ATHLETES)) {
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

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Mi Rutina <onboarding@resend.dev>',
        to: TRAINER_EMAIL,
        subject: `📊 Resumen semanal — ${athlete.name} (${week.label})`,
        html: emailHtml
      })
    });
  }
}
