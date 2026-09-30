// businessCalendar.js
const { nanoid } = require('nanoid');
// Bloque 43 — Calendario de días hábiles judiciales. Base de TODO cómputo de
// plazos legales del motor (ver legalDeadlines.js): ninguna regla de plazo
// debe sumar/restar días calendario a mano en ningún otro archivo — siempre
// a través de addBusinessDays/businessDaysBetween acá abajo.
//
// Un día es NO hábil si es sábado/domingo, o si figura en legal_holidays
// (feriado nacional, feria judicial, asueto, u "otro" cargado a mano). La
// tabla es cargable por un admin sin tocar código (ver seedDefaultHolidays
// más abajo y docs/PLAZOS_LEGALES.md) — si el año en curso no tiene ninguna
// fila, el sistema lo advierte (ver automationEngine.js) en vez de asumir
// que "no hay feriados ese año".
//
// Fechas como string 'YYYY-MM-DD' en todo este módulo — evita bugs de huso
// horario de comparar Date con hora/zona (el mismo tipo de bug ya detectado
// y documentado en "Control de vencimientos", Bloque 40).

function pad2(n) { return String(n).padStart(2, '0'); }

function dateToStr(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
function strToDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function isValidDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(strToDate(s).getTime());
}

function isWeekend(date) {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function isHoliday(db, dateStr) {
  return db.legalHolidays.some((h) => h.date === dateStr);
}

function isBusinessDay(db, dateStr) {
  return !isWeekend(strToDate(dateStr)) && !isHoliday(db, dateStr);
}

// suma `cantidad` días HÁBILES a `fechaStr` (cantidad puede ser 0, devuelve
// el mismo día si ya es hábil, o el próximo hábil si no lo es — igual
// criterio que "a partir de" en la práctica forense).
function addBusinessDays(db, fechaStr, cantidad) {
  if (!isValidDateStr(fechaStr)) throw new Error(`Fecha inválida: ${fechaStr}`);
  let date = strToDate(fechaStr);
  let remaining = cantidad;
  // si la fecha de partida no es hábil, se posiciona en el próximo hábil
  // antes de empezar a contar — evita ambigüedad ("¿arranca antes o
  // después del feriado?").
  while (!isBusinessDay(db, dateToStr(date))) {
    date = new Date(date.getTime() + 86400000);
  }
  while (remaining > 0) {
    date = new Date(date.getTime() + 86400000);
    if (isBusinessDay(db, dateToStr(date))) remaining--;
  }
  return dateToStr(date);
}

// cuenta los días HÁBILES estrictamente entre `aStr` (exclusivo) y `bStr`
// (inclusivo). Si bStr es anterior a aStr, devuelve un número negativo (días
// hábiles de más allá del plazo — útil para "vencido hace N días hábiles").
function businessDaysBetween(db, aStr, bStr) {
  if (!isValidDateStr(aStr) || !isValidDateStr(bStr)) throw new Error('Fechas inválidas');
  const a = strToDate(aStr), b = strToDate(bStr);
  const sign = b.getTime() >= a.getTime() ? 1 : -1;
  let [start, end] = sign === 1 ? [a, b] : [b, a];
  let count = 0;
  let cursor = new Date(start.getTime() + 86400000);
  while (cursor.getTime() <= end.getTime()) {
    if (isBusinessDay(db, dateToStr(cursor))) count++;
    cursor = new Date(cursor.getTime() + 86400000);
  }
  return count * sign;
}

function yearHasHolidaysLoaded(db, year) {
  return db.legalHolidays.some((h) => h.year === year);
}

// Pascua (algoritmo de Gauss/Meeus), usado solo para derivar Carnaval y
// Viernes Santo — ambos feriados nacionales fijados POR LEY en relación a
// la Pascua (no son "trasladables a fines de turismo"), así que se pueden
// calcular con certeza para cualquier año, a diferencia de los trasladables.
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

// Feriados NACIONALES con fecha cierta y verificable (fuente: Ley 27.399 y
// el calendario de feriados del Ministerio de Justicia, feriados
// INAMOVIBLES — es decir, no sujetos a decreto de traslado año a año) más
// Carnaval/Viernes Santo (derivados de Pascua). Los feriados TRASLADABLES
// "con fines turísticos" (17 de agosto, 12 de octubre, 20 de noviembre) NO
// se siembran acá: su fecha exacta depende de un decreto del Poder Ejecutivo
// que se dicta cada año y no puede anticiparse con certeza — quedan
// PENDIENTES DE CARGA MANUAL por un admin (ver docs/PLAZOS_LEGALES.md).
// Misma reserva para la feria judicial de invierno: la feria de ENERO
// completo está fijada por el reglamento y se siembra entera; la de JULIO
// se siembra con las fechas HABITUALES de la Acordada de la CSJN de los
// últimos años, marcadas explícitamente como "estimadas, confirmar" en la
// descripción — no se inventa como si fueran definitivas.
function nationalFixedHolidays(year) {
  const easter = easterSunday(year);
  const minus = (days) => dateToStr(new Date(easter.getTime() - days * 86400000));
  const list = [
    { date: `${year}-01-01`, type: 'feriado_nacional', description: 'Año Nuevo' },
    { date: minus(48), type: 'feriado_nacional', description: 'Carnaval (lunes)' },
    { date: minus(47), type: 'feriado_nacional', description: 'Carnaval (martes)' },
    { date: `${year}-03-24`, type: 'feriado_nacional', description: 'Día Nacional de la Memoria por la Verdad y la Justicia' },
    { date: `${year}-04-02`, type: 'feriado_nacional', description: 'Día del Veterano y de los Caídos en la Guerra de Malvinas' },
    { date: minus(2), type: 'feriado_nacional', description: 'Viernes Santo' },
    { date: `${year}-05-01`, type: 'feriado_nacional', description: 'Día del Trabajador' },
    { date: `${year}-05-25`, type: 'feriado_nacional', description: 'Día de la Revolución de Mayo' },
    { date: `${year}-06-20`, type: 'feriado_nacional', description: 'Paso a la Inmortalidad del General Manuel Belgrano' },
    { date: `${year}-07-09`, type: 'feriado_nacional', description: 'Día de la Independencia' },
    { date: `${year}-12-08`, type: 'feriado_nacional', description: 'Inmaculada Concepción de María' },
    { date: `${year}-12-25`, type: 'feriado_nacional', description: 'Navidad' },
  ];
  for (let d = 1; d <= 31; d++) {
    list.push({ date: `${year}-01-${pad2(d)}`, type: 'feria_judicial', description: 'Feria judicial de enero' });
  }
  for (let d = 1; d <= 15; d++) {
    list.push({ date: `${year}-07-${pad2(d)}`, type: 'feria_judicial', description: 'Feria judicial de invierno (fechas estimadas según patrón habitual — PENDIENTE DE CONFIRMAR con la Acordada de la CSJN del año en curso)' });
  }
  return list;
}

// siembra idempotente (por year+date, ver índice único legal_holidays) para
// el año en curso y el siguiente — nunca pisa una fila ya existente, así
// que un admin puede corregir/borrar una fecha estimada sin que el próximo
// arranque del servidor la vuelva a poner.
function seedDefaultHolidays(db) {
  const now = Date.now();
  const currentYear = new Date().getUTCFullYear();
  const existing = new Set(db.legalHolidays.map((h) => `${h.year}:${h.date}`));
  let added = 0;
  for (const year of [currentYear, currentYear + 1]) {
    for (const h of nationalFixedHolidays(year)) {
      const key = `${year}:${h.date}`;
      if (existing.has(key)) continue;
      existing.add(key);
      db.legalHolidays.push({
        id: nanoid(),
        year, date: h.date, type: h.type, description: h.description, createdAt: now,
      });
      added++;
    }
  }
  return added;
}

module.exports = {
  addBusinessDays, businessDaysBetween, isBusinessDay, isHoliday, isWeekend,
  yearHasHolidaysLoaded, seedDefaultHolidays, dateToStr, strToDate, isValidDateStr,
};
