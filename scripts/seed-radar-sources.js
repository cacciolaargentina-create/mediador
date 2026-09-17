// scripts/seed-radar-sources.js
// Bloque 25 §25 — carga inicial de fuentes del radar competitivo. SOLO
// fuentes públicas verificadas a mano (URL confirmada con WebSearch/WebFetch
// antes de escribir este archivo, ver informe final del bloque) — nada
// inventado. Idempotente: si una fuente con esa URL ya existe, no la
// duplica, así se puede correr de nuevo sin miedo (ej. después de un deploy).
//
// Uso: node scripts/seed-radar-sources.js
// (necesita SQLITE_PATH apuntando a la base real si se corre en producción —
// sin la variable, usa data.sqlite del directorio del proyecto, igual que el
// server.)

const { nanoid } = require('nanoid');
const { getDB, commit } = require('../db');

// category: 'competidor'|'oficial'|'regulatorio'|'mercado' — ver §1 de la
// spec. checkFrequency por defecto según §17: precios/competidores
// comerciales semanal, fuentes regulatorias/oficiales diaria.
const SEED_SOURCES = [
  {
    name: 'medi.ar',
    url: 'https://medi.ar/',
    category: 'competidor',
    checkFrequency: 'weekly',
    notes: 'Software comercial de gestión de mediaciones en Argentina — el único competidor comercial directo confirmado durante la investigación de este bloque (verificado con WebSearch, 2026-09-17).',
  },
  {
    name: 'Portal de Mediación (SIGIM)',
    url: 'https://mediacion.jus.gob.ar/solicitudes-mediacion',
    category: 'regulatorio',
    checkFrequency: 'daily',
    notes: 'Portal público del nuevo Sistema Informatizado de Gestión Integral de la Mediación (Resolución 277/2026, reemplaza a MEPRE desde el 29/06/2026). Solo se monitorea la página pública — nunca login (requiere reconocimiento biométrico, fuera de alcance por diseño, ver §19).',
  },
  {
    name: 'MEPRE — Ministerio de Justicia',
    url: 'https://www.argentina.gob.ar/justicia/mediacion/mepre',
    category: 'oficial',
    checkFrequency: 'daily',
    notes: 'Página oficial informativa sobre el sistema MEPRE (mediadores) y su transición a SIGIM. Benchmark oficial, no competidor comercial (§19).',
  },
  {
    name: 'Sistema Mediare (Provincia de Buenos Aires)',
    url: 'https://mediaciones.mjus.gba.gob.ar/',
    category: 'oficial',
    checkFrequency: 'daily',
    notes: 'Sistema oficial de mediación prejudicial obligatoria de la Provincia de Buenos Aires (Ley 13.951), nombrado explícitamente en la spec del bloque. Publica resoluciones y valores de matrícula con regularidad — buen candidato a detectar cambios regulatorios.',
  },
  {
    name: 'CPACF — Novedades sobre SIGIM',
    url: 'https://www.cpacf.org.ar/noticia/6786/nuevo-sistema-informatizado-de-gestion-integral-de-la-mediacion-prejudicial-obligatoria-sigim',
    category: 'mercado',
    checkFrequency: 'weekly',
    notes: 'Publicación del Colegio Público de la Abogacía de la Capital Federal sobre el nuevo sistema SIGIM — fuente de mercado/profesional, no oficial ni competidor.',
  },
];

(async function main() {
  const db = getDB();
  const now = Date.now();
  let created = 0, skipped = 0;
  for (const s of SEED_SOURCES) {
    if (db.competitorSources.some((existing) => existing.url === s.url)) {
      console.log(`ya existe, se omite: ${s.name} (${s.url})`);
      skipped++;
      continue;
    }
    db.competitorSources.push({
      id: nanoid(), name: s.name, url: s.url, category: s.category, active: true,
      checkFrequency: s.checkFrequency, lastCheckedAt: null, lastChangedAt: null, lastHash: null,
      notes: s.notes, createdAt: now, updatedAt: now,
    });
    console.log(`creada: ${s.name} (${s.url}) — categoría ${s.category}, frecuencia ${s.checkFrequency}`);
    created++;
  }
  if (created > 0) await commit();
  console.log(`\n${created} fuente(s) creada(s), ${skipped} ya existían.`);
})();
