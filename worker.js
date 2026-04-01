export default {
  async fetch(request, env) {
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
      nicolas:  { name: 'Nicolás Saravia' },
      msaravia: { name: 'María Saravia'   },
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
      const entry = {
        day: body.day,
        dayLabel: body.dayLabel,
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
            <td width="48%" bgcolor="#0f1117" style="background:#0f1117;border-radius:10px;padding:16px;text-align:center">
              <div style="font-size:22px;font-weight:800;color:#34d399">${body.dayLabel || body.day}</div>
              <div style="font-size:11px;color:#64748b;margin-top:4px;text-transform:uppercase;letter-spacing:.8px">Día</div>
            </td>
            <td width="4%"></td>
            <td width="48%" bgcolor="#0f1117" style="background:#0f1117;border-radius:10px;padding:16px;text-align:center">
              <div style="font-size:22px;font-weight:800;color:#34d399">S${body.week}</div>
              <div style="font-size:11px;color:#64748b;margin-top:4px;text-transform:uppercase;letter-spacing:.8px">Semana</div>
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
          subject: `✅ ${athleteName} completó: ${body.dayLabel || body.day} — Semana ${body.week}`,
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

      // Email for this slot
      const slotMeta = MEAL_SLOTS.find(s => s.key === slot);
      const slotText = body.meals?.[slot];
      const slotPhoto = body.photos?.[slot];
      const slotHtml = `
        <tr><td bgcolor="#1e2130" style="background:#1e2130;border:1px solid #2d3148;border-radius:12px;padding:20px">
          <div style="font-size:11px;font-weight:700;letter-spacing:1.2px;color:#94a3b8;text-transform:uppercase;margin-bottom:12px">${slotMeta?.icon || ''} ${slotMeta?.label || slot}</div>
          ${slotText  ? `<p style="margin:0 0 12px;font-size:14px;color:#e2e8f0;line-height:1.5">${slotText}</p>` : ''}
          ${slotPhoto ? `<img src="${slotPhoto}" style="width:100%;max-width:400px;border-radius:10px;display:block;margin-bottom:12px">` : ''}
          ${analysis  ? `<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#0f1117" style="background:#0f1117;border-left:3px solid #06b6d4;border-radius:0 8px 8px 0"><tr><td style="padding:14px 16px"><div style="font-size:11px;font-weight:700;color:#06b6d4;letter-spacing:1px;margin-bottom:10px">🤖 ANÁLISIS NUTRICIONAL</div><div style="font-size:13px;line-height:1.8;color:#cbd5e1;white-space:pre-line">${analysis}</div></td></tr></table>` : ''}
        </td></tr>`;

      const emailHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0" bgcolor="#0f1117">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#0f1117" style="background:#0f1117;font-family:-apple-system,Helvetica,sans-serif">
  <tr><td align="center" style="padding:24px 16px">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
      <tr><td style="background:linear-gradient(135deg,#06b6d4,#6366f1);border-radius:16px;padding:24px">
        <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:rgba(255,255,255,.7);text-transform:uppercase;margin-bottom:6px">Comida registrada</div>
        <div style="font-size:28px;font-weight:800;color:#fff">🍽️ ${slotMeta?.label || slot}</div>
        <div style="font-size:13px;color:rgba(255,255,255,.7);margin-top:4px">${body.dayLabel} · ${athleteName}</div>
      </td></tr>
      <tr><td height="20"></td></tr>
      ${slotHtml}
    </table>
  </td></tr>
</table></body></html>`;

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Mi Rutina <onboarding@resend.dev>',
          to: TRAINER_EMAIL,
          subject: `🍽️ ${athleteName} — ${slotMeta?.label || slot} (${body.dayLabel})`,
          html: emailHtml
        })
      });

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
      return new Response(JSON.stringify({ ok: true }), { headers: cors });
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
  }
};
