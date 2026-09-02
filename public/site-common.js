// public/site-common.js
// Comportamiento compartido de las páginas legales estáticas (legal.html,
// terminos.html, privacidad.html) — NO se usa en index.html, que ya trae
// su propia copia de esto adentro de app.js (esas dos versiones deberían
// evolucionar juntas si algo cambia en una).
//
// Deliberadamente chico y sin dependencias: estas páginas no cargan
// socket.io ni el resto de app.js, así que este archivo solo trae lo que
// hace falta para que el header se vea y se sienta igual que el resto del
// sitio — logo animado, modo claro/oscuro y el menú hamburguesa.

// ==================================================================
// LOGO ANIMADO — igual que en app.js (ver ahí el comentario completo).
// ==================================================================
function initBridgeLogos(){
  const ns = 'http://www.w3.org/2000/svg';
  document.querySelectorAll('.bridge-logo').forEach(wrap => {
    if(wrap.dataset.bridgeInit) return;
    wrap.dataset.bridgeInit = '1';

    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'bridge-arc');
    svg.setAttribute('viewBox', '0 0 200 32');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');

    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M4 4 Q100 30 196 4');
    path.setAttribute('fill', 'none');
    path.style.stroke = 'var(--calm)';
    path.setAttribute('stroke-width', '3');
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);

    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('r', '4');
    dot.style.fill = 'var(--text)';
    svg.appendChild(dot);

    wrap.appendChild(svg);

    const totalLen = path.getTotalLength();
    path.setAttribute('stroke-dasharray', totalLen);

    let t = Math.random() * Math.PI * 2;
    (function frame(){
      t += 0.008;
      const p = Math.min(1, ((Math.sin(t) + 1) / 2) * 1.35);
      path.setAttribute('stroke-dashoffset', totalLen - totalLen * p);
      const pt = path.getPointAtLength(p * totalLen);
      dot.setAttribute('cx', pt.x);
      dot.setAttribute('cy', pt.y);
      requestAnimationFrame(frame);
    })();
  });
}

// ==================================================================
// MODO CLARO/OSCURO — mismo comportamiento que app.js: arranca siempre en
// oscuro salvo que se haya elegido claro antes (localStorage 'pd_theme',
// compartido entre esta página y la app — es el mismo origen).
// ==================================================================
function currentTheme(){ return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }

function applyTheme(theme, persist){
  if(theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  if(persist){ try{ localStorage.setItem('pd_theme', theme); }catch(e){ /* sin storage disponible */ } }
  const metaTheme = document.querySelector('meta[name=theme-color]');
  if(metaTheme) metaTheme.content = theme === 'light' ? '#F4F7F6' : '#12181A';
  document.querySelectorAll('.theme-btn').forEach(b => {
    b.textContent = theme === 'light' ? '🌙' : '☀️';
    b.title = theme === 'light' ? 'Cambiar a modo oscuro' : 'Cambiar a modo claro';
  });
}

function initTheme(){
  let saved = null;
  try{ saved = localStorage.getItem('pd_theme'); }catch(e){ /* sin storage disponible */ }
  const theme = saved === 'light' ? 'light' : 'dark';
  applyTheme(theme, false);
}

function toggleTheme(){
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  document.documentElement.classList.add('theme-anim');
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.add('animating'));
  applyTheme(next, true);
  setTimeout(() => {
    document.documentElement.classList.remove('theme-anim');
    document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('animating'));
  }, 520);
}

// ==================================================================
// MENÚ HAMBURGUESA — igual criterio que en index.html: por debajo de
// 640px los links se esconden atrás del ☰.
// ==================================================================
function toggleMobileNav(){
  const nav = document.getElementById('site-nav');
  const btn = document.getElementById('hamburger-btn');
  if(!nav) return;
  const open = nav.classList.toggle('open');
  if(btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
document.addEventListener('click', (e) => {
  const nav = document.getElementById('site-nav');
  if(!nav || !nav.classList.contains('open')) return;
  if(e.target.closest('#site-nav a') || (!e.target.closest('#site-nav') && !e.target.closest('#hamburger-btn'))){
    nav.classList.remove('open');
    const btn = document.getElementById('hamburger-btn');
    if(btn) btn.setAttribute('aria-expanded', 'false');
  }
});

initTheme();
initBridgeLogos();
