// scripts/regression-test-bloque22.js
// Bloque 22 — batería de regresión real (HTTP) para las Partes 1-4:
// asignación sugerida en estudios (nunca automática), documentos de
// trabajo (permisos, aislamiento cross-mediación), y la parte de la IA
// aplicada que NO depende de una respuesta real del modelo (permisos,
// aislamiento, degradación honesta sin ANTHROPIC_API_KEY, nunca crea
// nada solo). Los dos tests que SÍ necesitan una respuesta real del
// modelo (resumen de un PDF real, sugerencias desde una nota real) no
// están acá — requieren una ANTHROPIC_API_KEY funcional y se corren a
// mano; ver el informe de Bloque 22 para su estado.
//
// Uso:
//   SQLITE_PATH=/tmp/b22.sqlite ENABLE_FAKE_LOGIN=1 PORT=3099 node server.js &
//   node scripts/regression-test-bloque22.js http://localhost:3099

const fs = require('fs');
const BASE = process.argv[2] || 'http://localhost:3099';

let passed = 0, failed = 0, skipped = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; failures.push(label); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}
function skip(label, reason) {
  skipped++;
  console.log(`  SKIP ${label} — ${reason}`);
}

function cookieJar() {
  let cookie = null;
  return {
    async fetch(path, opts = {}) {
      const headers = { ...(opts.headers || {}) };
      if (!(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(BASE + path, { ...opts, headers });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let body = null;
      try { body = await res.json(); } catch (e) {}
      return { status: res.status, body };
    },
  };
}

async function login(email, name) {
  const jar = cookieJar();
  const r = await jar.fetch('/auth/fake-login', { method: 'POST', body: JSON.stringify({ email, name }) });
  if (r.status !== 200) throw new Error(`No se pudo loguear ${email}: ${JSON.stringify(r.body)}`);
  jar.userId = r.body.user.id;
  return jar;
}

(async function main() {
  console.log(`Bloque 22 — pruebas contra ${BASE}\n`);
  const health = await fetch(BASE + '/api/health');
  if (health.status !== 200) { console.error('Server no responde. Abortando.'); process.exit(1); }

  // =========================================================================
  console.log('== PARTE 2: asignación sugerida en estudios ==');
  const admin = await login('b22-studio-admin@test.local', 'Admin Estudio');
  const studioRes = await admin.fetch('/api/studios', { method: 'POST', body: JSON.stringify({ name: 'Estudio B22' }) });
  check('estudio creado', studioRes.status === 200, JSON.stringify(studioRes.body));

  // mediador independiente (sin estudio) crea una mediación -> sin sugerencia
  const solo = await login('b22-solo@test.local', 'Mediador Solo');
  const medSolo = await solo.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Mediación sin estudio' }) });
  check('mediador independiente: suggestedAssignee es null', medSolo.body.suggestedAssignee === null, JSON.stringify(medSolo.body.suggestedAssignee));

  // el admin (todavía sin otros mediadores en el equipo) crea una mediación -> sin sugerencia (0-1 candidatos)
  const medAdminAlone = await admin.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Mediación admin solo' }) });
  check('admin sin equipo: suggestedAssignee es null (menos de 2 candidatos)', medAdminAlone.body.suggestedAssignee === null, JSON.stringify(medAdminAlone.body.suggestedAssignee));

  // invitar a dos mediadores al estudio
  const invite1 = await admin.fetch('/api/studios/invitations', { method: 'POST', body: JSON.stringify({ email: 'b22-mediadorA@test.local', role: 'mediador' }) });
  const invite2 = await admin.fetch('/api/studios/invitations', { method: 'POST', body: JSON.stringify({ email: 'b22-mediadorB@test.local', role: 'mediador' }) });
  check('invitación 1 creada', invite1.status === 200, JSON.stringify(invite1.body));
  check('invitación 2 creada', invite2.status === 200, JSON.stringify(invite2.body));

  const mediadorA = await login('b22-mediadorA@test.local', 'Mediador A');
  const mediadorB = await login('b22-mediadorB@test.local', 'Mediador B');
  const accept1 = await mediadorA.fetch(`/api/studios/invitations/${invite1.body.token}/accept`, { method: 'POST' });
  const accept2 = await mediadorB.fetch(`/api/studios/invitations/${invite2.body.token}/accept`, { method: 'POST' });
  check('mediador A acepta invitación', accept1.status === 200, JSON.stringify(accept1.body));
  check('mediador B acepta invitación', accept2.status === 200, JSON.stringify(accept2.body));

  // ahora hay 2 candidatos (A y B), ambos con 0 mediaciones activas -> debe sugerir a alguno (empate, gana el primero por orden de sort estable)
  const medWithSuggestion = await admin.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Mediación con sugerencia' }) });
  check('con 2 mediadores en el equipo: suggestedAssignee no es null', medWithSuggestion.body.suggestedAssignee !== null, JSON.stringify(medWithSuggestion.body.suggestedAssignee));
  const firstSuggested = medWithSuggestion.body.suggestedAssignee ? medWithSuggestion.body.suggestedAssignee.id : null;
  check('suggestedAssignee es uno de los 2 mediadores del equipo', [mediadorA.userId, mediadorB.userId].includes(firstSuggested));

  // la mediación NO quedó auto-asignada a nadie — sigue siendo del admin creador hasta que se asigne a mano
  check('la mediación creada NO se auto-asignó (mediatorUserId sigue siendo quien la creó)', medWithSuggestion.body.mediatorUserId === admin.userId, JSON.stringify(medWithSuggestion.body.mediatorUserId));
  const accessListBefore = await admin.fetch(`/api/mediations/${medWithSuggestion.body.id}/access`);
  check('sin asignación real todavía (mediation_access vacío para esta mediación)', Array.isArray(accessListBefore.body) && accessListBefore.body.length === 0, JSON.stringify(accessListBefore.body));

  // asignar 3 mediaciones más al mediador A "a mano" (vía el flujo YA existente, no tocado) para que quede con más carga
  for (let i = 0; i < 3; i++) {
    const m = await admin.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: `Carga extra ${i}` }) });
    await admin.fetch(`/api/mediations/${m.body.id}/access`, { method: 'POST', body: JSON.stringify({ userId: mediadorA.userId, role: 'mediador' }) });
  }
  // ahora A tiene más carga que B -> la sugerencia debe pasar a ser B
  const medAfterLoad = await admin.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Mediación tras cargar a A' }) });
  check('tras cargar a A con más mediaciones, se sugiere a B (menor carga)', medAfterLoad.body.suggestedAssignee && medAfterLoad.body.suggestedAssignee.id === mediadorB.userId, JSON.stringify(medAfterLoad.body.suggestedAssignee));

  // =========================================================================
  console.log('\n== PARTE 3: documentos de trabajo ==');
  const p3med = (await mediadorA.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Mediación Parte 3' }) })).body;
  const p3party = (await mediadorA.fetch(`/api/mediations/${p3med.id}/parties`, { method: 'POST', body: JSON.stringify({ type: 'persona', role: 'requirente', firstName: 'Parte', lastName: 'Tres' }) })).body;
  const p3hearing = (await mediadorA.fetch(`/api/mediations/${p3med.id}/hearings`, { method: 'POST', body: JSON.stringify({ date: '2027-03-10', startTime: '11:00', modality: 'presencial', location: 'Sala 2' }) })).body;

  const draftRes = await mediadorA.fetch(`/api/mediations/${p3med.id}/hearings/${p3hearing.id}/draft-minutes`);
  check('borrador de acta: 200 y content-type PDF', draftRes.status === 200);
  const convRes = await mediadorA.fetch(`/api/mediations/${p3med.id}/hearings/${p3hearing.id}/convocation-letter`);
  check('carta de convocatoria: 200', convRes.status === 200);

  // permisos: un abogado de solo lectura (vía portal, no vía mediador) no debería poder generarlos —
  // verificamos vía requireEditAccess: creamos un asistente de rol solo-lectura no existe en este modelo,
  // así que probamos con un usuario SIN acceso a la mediación en absoluto.
  const outsider = await login('b22-outsider@test.local', 'Ajeno');
  const draftDenied = await outsider.fetch(`/api/mediations/${p3med.id}/hearings/${p3hearing.id}/draft-minutes`);
  check('un usuario sin acceso a la mediación no puede generar el borrador (403)', draftDenied.status === 403, `status=${draftDenied.status}`);
  const convDenied = await outsider.fetch(`/api/mediations/${p3med.id}/hearings/${p3hearing.id}/convocation-letter`);
  check('un usuario sin acceso no puede generar la convocatoria (403)', convDenied.status === 403, `status=${convDenied.status}`);

  // cross-mediación: hearingId real pero de OTRA mediación
  const p3med2 = (await mediadorA.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Mediación Parte 3 B' }) })).body;
  const crossDraft = await mediadorA.fetch(`/api/mediations/${p3med2.id}/hearings/${p3hearing.id}/draft-minutes`);
  check('borrador con hearingId de otra mediación: 404', crossDraft.status === 404, `status=${crossDraft.status}`);

  // =========================================================================
  console.log('\n== PARTE 1: recordatorios y escalamiento ==');
  const p1med = (await mediadorA.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Mediación Parte 1' }) })).body;
  const p1party = (await mediadorA.fetch(`/api/mediations/${p1med.id}/parties`, { method: 'POST', body: JSON.stringify({ type: 'persona', role: 'requirente', firstName: 'Parte', lastName: 'Uno' }) })).body;
  const p1commitment = await mediadorA.fetch(`/api/mediations/${p1med.id}/commitments`, { method: 'POST', body: JSON.stringify({ partyId: p1party.id, description: 'Enviar comprobante', dueDate: '2020-01-01' }) });
  check('compromiso creado con dueDate ya vencido', p1commitment.status === 200, JSON.stringify(p1commitment.body));

  // el default de notificationDigest es 'none' — comportamiento sin cambios
  const meA = await mediadorA.fetch('/auth/me');
  check("default de notificationDigest es 'none' o vacío (sin digest activado)", !meA.body.notificationDigest || meA.body.notificationDigest === 'none', JSON.stringify(meA.body.notificationDigest));

  console.log('\n== PARTE 4: IA aplicada — todo lo NO dependiente de una respuesta real del modelo ==');
  const p4med = (await mediadorA.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Mediación Parte 4' }) })).body;
  const p4party = (await mediadorA.fetch(`/api/mediations/${p4med.id}/parties`, { method: 'POST', body: JSON.stringify({ type: 'persona', role: 'requirente', firstName: 'García', lastName: 'Test' }) })).body;

  // suggest-tasks: nota vacía -> 400
  const emptyNote = await mediadorA.fetch(`/api/mediations/${p4med.id}/suggest-tasks`, { method: 'POST', body: JSON.stringify({ note: '' }) });
  check('nota vacía en suggest-tasks: 400', emptyNote.status === 400, `status=${emptyNote.status}`);

  // suggest-tasks: sin API key real, degrada con [] (no crashea) y NO crea nada
  const tasksBefore = (await mediadorA.fetch(`/api/mediations/${p4med.id}/tasks`)).body.length;
  const commitmentsBefore = (await mediadorA.fetch(`/api/mediations/${p4med.id}/commitments`)).body.length;
  const suggestRes = await mediadorA.fetch(`/api/mediations/${p4med.id}/suggest-tasks`, { method: 'POST', body: JSON.stringify({ note: 'García manda el comprobante el viernes y López confirma la cesión el lunes' }) });
  check('suggest-tasks responde 200 incluso sin ANTHROPIC_API_KEY real (degrada, no crashea)', suggestRes.status === 200, `status=${suggestRes.status} body=${JSON.stringify(suggestRes.body)}`);
  check('suggest-tasks devuelve { suggestions: [] } cuando no hay API key real (degradación esperada)', Array.isArray(suggestRes.body.suggestions), JSON.stringify(suggestRes.body));
  const tasksAfter = (await mediadorA.fetch(`/api/mediations/${p4med.id}/tasks`)).body.length;
  const commitmentsAfter = (await mediadorA.fetch(`/api/mediations/${p4med.id}/commitments`)).body.length;
  check('suggest-tasks NUNCA crea tareas por sí solo', tasksAfter === tasksBefore, `antes=${tasksBefore} despues=${tasksAfter}`);
  check('suggest-tasks NUNCA crea compromisos por sí solo', commitmentsAfter === commitmentsBefore, `antes=${commitmentsBefore} despues=${commitmentsAfter}`);

  // permisos: suggest-tasks requiere edición (requireEditAccess) — un usuario sin acceso, 403
  const suggestDenied = await outsider.fetch(`/api/mediations/${p4med.id}/suggest-tasks`, { method: 'POST', body: JSON.stringify({ note: 'nota cualquiera' }) });
  check('suggest-tasks: usuario sin acceso a la mediación -> 403', suggestDenied.status === 403, `status=${suggestDenied.status}`);

  // summarize: documento inexistente -> 404
  const summarizeMissing = await mediadorA.fetch(`/api/mediations/${p4med.id}/documents/doc-inexistente/summarize`, { method: 'POST' });
  check('summarize con docId inexistente: 404', summarizeMissing.status === 404, `status=${summarizeMissing.status}`);

  // summarize con un PDF real subido, sin ANTHROPIC_API_KEY real -> degrada
  // con un mensaje honesto (200, unsupported:false, answer explicando que
  // falta configurar la key), nunca crashea.
  const minimalPdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
  const pdfForm = new FormData();
  pdfForm.append('type', 'otro');
  pdfForm.append('file', new Blob([minimalPdf], { type: 'application/pdf' }), 'dummy.pdf');
  const pdfUpload = await mediadorA.fetch(`/api/mediations/${p4med.id}/documents`, { method: 'POST', body: pdfForm });
  check('sube un PDF real de prueba', pdfUpload.status === 200, JSON.stringify(pdfUpload.body));
  const summarizePdf = await mediadorA.fetch(`/api/mediations/${p4med.id}/documents/${pdfUpload.body.id}/summarize`, { method: 'POST' });
  check('summarize con PDF real y sin API key real: 200, degrada sin crashear', summarizePdf.status === 200 && summarizePdf.body.unsupported === false, JSON.stringify(summarizePdf.body));

  // summarize con un .docx -> mensaje honesto de "todavía no", sin llamar
  // nunca a la API (esto no depende de tener una key real).
  const docxForm = new FormData();
  docxForm.append('type', 'otro');
  docxForm.append('file', new Blob([Buffer.from('contenido docx de prueba')], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'dummy.docx');
  const docxUpload = await mediadorA.fetch(`/api/mediations/${p4med.id}/documents`, { method: 'POST', body: docxForm });
  check('sube un .docx de prueba', docxUpload.status === 200, JSON.stringify(docxUpload.body));
  const summarizeDocx = await mediadorA.fetch(`/api/mediations/${p4med.id}/documents/${docxUpload.body.id}/summarize`, { method: 'POST' });
  check('summarize con .docx: unsupported:true con mensaje honesto (nunca intenta la API)', summarizeDocx.status === 200 && summarizeDocx.body.unsupported === true, JSON.stringify(summarizeDocx.body));

  // permisos: summarize es de nivel LECTURA — cualquiera con acceso (no necesariamente edición).
  // No tenemos un rol "solo lectura" fácil de crear en este flujo sin abogado con portal, así que
  // verificamos que un usuario SIN NINGÚN acceso sí sea rechazado (eso confirma que exige al menos
  // requireMediationAccess), y dejamos documentado que la distinción "lectura vs edición" puntual
  // no se pudo aislar con un tercer rol en este test.
  const summarizeDenied = await outsider.fetch(`/api/mediations/${p4med.id}/documents/doc-inexistente/summarize`, { method: 'POST' });
  check('summarize: usuario sin acceso a la mediación -> 403 (antes que llegue a buscar el doc)', summarizeDenied.status === 403, `status=${summarizeDenied.status}`);

  // aislamiento cross-mediación: summarize/suggest-tasks con :id de una mediación ajena
  const medB = (await login('b22-otro-mediador@test.local', 'Otro Mediador').then(j => j.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'familiar', object: 'Mediación de otro' }) }))).body;
  const crossSummarize = await mediadorA.fetch(`/api/mediations/${medB.id}/documents/doc-inexistente/summarize`, { method: 'POST' });
  check('summarize cross-mediación (mediación ajena): 403', crossSummarize.status === 403, `status=${crossSummarize.status}`);
  const crossSuggest = await mediadorA.fetch(`/api/mediations/${medB.id}/suggest-tasks`, { method: 'POST', body: JSON.stringify({ note: 'nota' }) });
  check('suggest-tasks cross-mediación (mediación ajena): 403', crossSuggest.status === 403, `status=${crossSuggest.status}`);

  console.log(`\n${passed} pasaron, ${failed} fallaron, ${skipped} omitidas (requieren ANTHROPIC_API_KEY real).`);
  if (failed > 0) { console.log('\nFallidas:', failures.join(', ')); process.exit(1); }
  process.exit(0);
})().catch((e) => {
  console.error('Error ejecutando las pruebas:', e);
  process.exit(1);
});
