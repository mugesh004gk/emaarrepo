import * as THREE from 'three';

/**
 * Screen-space labels for the map (communities, districts, project pins).
 * One DOM node per label, positioned with transforms only when the view changes. Labels
 * outside the view, behind the camera, outside their zoom range or overlapping a more
 * important label are hidden (fade, never a hard pop).
 */
export function createLabelLayer(container) {
  const root = document.createElement('div');
  root.className = 'map-labels';
  container.appendChild(root);
  const items = [];
  const v = new THREE.Vector3();

  function add({ x, y = 0, z, html, className = '', priority = 0, minDist = 0, maxDist = Infinity, onClick = null, data = null }) {
    const el = document.createElement('div');
    el.className = `map-label ${className}`;
    el.innerHTML = html;
    if (onClick) {
      el.classList.add('clickable');
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick(data);
      });
    }
    root.appendChild(el);
    const it = { el, pos: new THREE.Vector3(x, y, z), priority, minDist, maxDist, shown: false, w: 0, h: 0, enabled: true, data };
    items.push(it);
    return it;
  }

  function measure() {
    for (const it of items) {
      it.w = it.el.offsetWidth;
      it.h = it.el.offsetHeight;
    }
  }

  function update(camera, width, height) {
    const placed = [];
    const camPos = camera.position;
    const sorted = items.slice().sort((a, b) => b.priority - a.priority);
    for (const it of sorted) {
      let show = it.enabled;
      let sx = 0, sy = 0;
      if (show) {
        const d = camPos.distanceTo(it.pos);
        if (d < it.minDist || d > it.maxDist) show = false;
        else {
          v.copy(it.pos).applyMatrix4(camera.matrixWorldInverse);
          const behind = v.z > -camera.near;
          v.applyMatrix4(camera.projectionMatrix);
          if (behind || v.x < -1.1 || v.x > 1.1 || v.y < -1.1 || v.y > 1.1) show = false;
          else {
            sx = (v.x * 0.5 + 0.5) * width;
            sy = (-v.y * 0.5 + 0.5) * height;
            if (!it.w) { it.w = it.el.offsetWidth; it.h = it.el.offsetHeight; }
            const r = { x0: sx - it.w / 2 - 3, x1: sx + it.w / 2 + 3, y0: sy - it.h - 3, y1: sy + 3 };
            if (placed.some((p) => r.x0 < p.x1 && r.x1 > p.x0 && r.y0 < p.y1 && r.y1 > p.y0)) show = false;
            else placed.push(r);
          }
        }
      }
      if (show) {
        it.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
      }
      if (show !== it.shown) {
        it.el.classList.toggle('visible', show);
        it.shown = show;
      }
    }
  }

  return { root, add, update, measure, items };
}
