/**
 * Start screen: one card per community (built from data/projects.json, so a community added to the
 * data gets its card automatically). Picking a card opens that community's own map; the rest of Dubai
 * is not shown. Used by the 3D app (js/main.js) and the light map (js/lite.js).
 *
 * Address bar: '#the-valley' opens a community directly (shareable link); the browser's Back button
 * returns to this screen.
 */
import { escapeHtml as esc } from '../districts.js';
import { formatAED, bedRange } from '../projects-layer.js';

export function createCommunityPicker(communities, { onPick, homesIn3D = () => 0 } = {}) {
  const el = document.createElement('div');
  el.id = 'community-picker';
  el.className = 'cp hidden';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Choose a community');

  const photo = communityPhoto;
  const card = (c) => {
    const prices = c.projects.map((p) => p.priceFrom).filter((v) => v > 0);
    const beds = c.projects.flatMap((p) => bedRange(p));
    const homes = homesIn3D(c);
    const facts = [
      `<span><b>${c.projects.length}</b> projects</span>`,
      homes ? `<span><b>${homes.toLocaleString('en-US')}</b> homes in 3D</span>` : '',
      beds.length ? `<span><b>${Math.min(...beds)}–${Math.max(...beds)}</b> bedrooms</span>` : '',
    ].filter(Boolean).join('');
    return `
      <button type="button" class="cp-card" data-community="${esc(c.id)}">
        <span class="cp-photo" style="background-image:url('${encodeURI(photo(c))}')"></span>
        <span class="cp-body">
          <span class="cp-name">${esc(c.name)}</span>
          <span class="cp-tag">${esc(c.tagline || '')}</span>
          <span class="cp-facts">${facts}</span>
          <span class="cp-foot">
            <span class="cp-price">${prices.length ? `From ${formatAED(Math.min(...prices))}` : 'Prices on request'}</span>
            <span class="cp-go">Explore in 3D<svg class="icon"><use href="#i-chevron-right" /></svg></span>
          </span>
        </span>
      </button>`;
  };
  el.innerHTML = `
    <div class="cp-inner">
      <header class="cp-head">
        <span class="cp-brand">EMAAR</span>
        <h1>Choose a community</h1>
        <p>Every home, street and park in 3D, with prices, floor plans and brochures.</p>
      </header>
      <div class="cp-grid">${communities.map(card).join('')}</div>
    </div>`;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('.cp-card');
    if (b) onPick?.(b.dataset.community);
  });

  return {
    el,
    get visible() { return !el.classList.contains('hidden'); },
    show() {
      el.classList.remove('hidden');
      document.body.classList.add('picker-open');
      el.scrollTop = 0;
      el.querySelector('.cp-card')?.focus({ preventScroll: true });
    },
    hide() {
      el.classList.add('hidden');
      document.body.classList.remove('picker-open');
    },
  };
}

/** The community's own photo: its gallery, else its first project's photo, else the page banner (Emaar
 * uses one generic banner for several communities). */
export const communityPhoto = (c) => c.cardImage || c.gallery?.[0] || mainImage(c.projects.find((p) => mainImage(p))) || c.banner || '';

const mainImage = (p) => p && (p.images?.find((i) => i.kind === 'main') || p.images?.[0])?.src;

/**
 * Address-bar routing: '#<community id>' = inside that community, no hash = the start screen.
 * enter(id) / home() are the app's own handlers; returns go(id|null) for the app to call.
 */
export function startCommunityRouting(communities, { enter, home }) {
  const valid = (id) => communities.some((c) => c.id === id);
  const fromUrl = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    return valid(id) ? id : null;
  };
  window.addEventListener('popstate', () => {
    const id = fromUrl();
    if (id) enter(id, { push: false });
    else home({ push: false });
  });
  const go = (id) => {
    const url = id ? `#${id}` : location.pathname + location.search;
    if ((id || null) !== fromUrl()) history.pushState(null, '', url);
  };
  return { go, initial: fromUrl() };
}
