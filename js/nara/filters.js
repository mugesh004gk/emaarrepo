/**
 * Agent Filter, Quick Presets, Colour-Coding Legend & Matching Units List Controller
 * For Nara at The Valley (372 Townhouses)
 */
export function initFiltersModule(state) {
  const { data, community } = state;
  const units = data.units;

  const elMatchCount = document.getElementById('filter-match-count');
  const elUnitsList = document.getElementById('matching-units-list');
  const elBedrooms = document.getElementById('filter-bedrooms');
  const elDesign = document.getElementById('filter-design');
  const elPlan = document.getElementById('filter-plan');
  const elUnitPos = document.getElementById('filter-unit-pos');
  const elFrontFacing = document.getElementById('filter-front-facing');
  const elGardenFacing = document.getElementById('filter-garden-facing');
  const elBacksOnto = document.getElementById('filter-backs-onto');
  const elMaxPrice = document.getElementById('filter-max-price');
  const elPriceReadout = document.getElementById('filter-price-readout');
  const elColorMode = document.getElementById('color-mode-select');
  const elColorLegend = document.getElementById('color-legend');

  const btnReset = document.getElementById('btn-reset-filters');
  const btnPreset4BrPark = document.getElementById('preset-4br-park');
  const btnPresetPalma3BrNW = document.getElementById('preset-palma-3br-nw');
  const btnPresetCommunity = document.getElementById('preset-community-info');

  function isAnyFilterActive() {
    return (
      elBedrooms.value !== 'all' ||
      elDesign.value !== 'all' ||
      elPlan.value !== 'all' ||
      elUnitPos.value !== 'all' ||
      elFrontFacing.value !== 'all' ||
      elGardenFacing.value !== 'all' ||
      elBacksOnto.value !== 'all' ||
      elMaxPrice.value !== 'all'
    );
  }

  function evaluateUnitMatch(u) {
    if (elBedrooms.value !== 'all' && u.bedrooms !== Number(elBedrooms.value)) return false;
    if (elDesign.value !== 'all' && u.design !== elDesign.value) return false;
    if (elPlan.value !== 'all' && u.planType !== elPlan.value) return false;
    if (elUnitPos.value !== 'all' && u.endOrMiddle !== elUnitPos.value) return false;
    if (elFrontFacing.value !== 'all' && u.frontFaces !== elFrontFacing.value) return false;
    if (elGardenFacing.value !== 'all' && u.gardenFaces !== elGardenFacing.value) return false;

    if (elBacksOnto.value !== 'all') {
      if (elBacksOnto.value === 'any_park') {
        if (!u.backsOntoPark) return false;
      } else if (u.backsOnto !== elBacksOnto.value) {
        return false;
      }
    }

    if (elMaxPrice.value !== 'all') {
      if (elMaxPrice.value === 'has_sale') {
        if (!u.salesCount || u.salesCount <= 0) return false;
      } else if (elMaxPrice.value === 'has_lease') {
        if (!u.leasesCount || u.leasesCount <= 0) return false;
      } else {
        const cap = Number(elMaxPrice.value);
        if (!u.lastSalePrice || u.lastSalePrice > cap) return false;
      }
    }

    return true;
  }

  function updateColorLegend(mode) {
    if (mode === 'realistic') {
      elColorLegend.classList.add('hidden');
      elColorLegend.innerHTML = '';
      return;
    }
    elColorLegend.classList.remove('hidden');

    let items = [];
    if (mode === 'design') {
      items = [
        ['#52b788', 'Aston (132 homes)'],
        ['#f4a261', 'Palma (188 homes)'],
        ['#e76f51', 'Charm (52 homes)'],
      ];
    } else if (mode === 'bedrooms') {
      items = [
        ['#10b981', '3 Bedrooms + Maid (258)'],
        ['#3b82f6', '4 Bedrooms + Maid (114)'],
      ];
    } else if (mode === 'facing') {
      items = [
        ['#38bdf8', 'Front Faces North-West'],
        ['#f59e0b', 'Front Faces South-East'],
        ['#a855f7', 'Front Faces North-East'],
        ['#ec4899', 'Front Faces South-West'],
      ];
    } else if (mode === 'market') {
      items = [
        ['#8b5cf6', 'Recorded Sale & Lease'],
        ['#10b981', 'Recorded Sale (DLD)'],
        ['#0ea5e9', 'Recorded Lease (DLD)'],
        ['#64748b', 'No Recorded Registration'],
      ];
    }

    elColorLegend.innerHTML = items
      .map(
        ([hex, label]) =>
          `<div class="legend-row"><span class="legend-swatch" style="background:${hex}"></span><span>${label}</span></div>`
      )
      .join('');
  }

  function applyFilters() {
    const active = isAnyFilterActive();
    const matchingUnits = [];
    const matchingSet = new Set();

    for (const u of units) {
      if (evaluateUnitMatch(u)) {
        matchingUnits.push(u);
        matchingSet.add(u.unit);
      }
    }

    state.matchingUnitSet = matchingSet;
    state.filterActive = active;
    state.matchingUnits = matchingUnits;

    elMatchCount.textContent = String(matchingUnits.length);
    const elReopenCount = document.getElementById('reopen-filter-count');
    if (elReopenCount) elReopenCount.textContent = String(matchingUnits.length);

    if (elMaxPrice.value === 'all') {
      elPriceReadout.textContent = 'All homes';
    } else if (elMaxPrice.value === 'has_sale') {
      elPriceReadout.textContent = 'DLD sale';
    } else if (elMaxPrice.value === 'has_lease') {
      elPriceReadout.textContent = 'DLD lease';
    } else {
      elPriceReadout.textContent = `≤ AED ${(Number(elMaxPrice.value) / 1e6).toFixed(1)}M`;
    }

    renderUnitsList(matchingUnits);
    syncSegments();
    refreshVisuals();
    return matchingUnits;
  }

  // Segmented controls drive the (visually hidden) selects that hold the filter values
  const segments = document.querySelectorAll('.segmented[data-target]');
  function syncSegments() {
    segments.forEach((seg) => {
      const sel = document.getElementById(seg.dataset.target);
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.value === sel.value));
    });
  }
  segments.forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-value]');
      if (!b) return;
      const sel = document.getElementById(seg.dataset.target);
      if (sel.value === b.dataset.value) return;
      sel.value = b.dataset.value;
      sel.dispatchEvent(new Event('change'));
    });
  });

  const FACING_ABBR = { 'North-West': 'NW', 'South-East': 'SE', 'North-East': 'NE', 'South-West': 'SW' };

  function renderUnitsList(list) {
    if (list.length === 0) {
      elUnitsList.innerHTML = `<div class="empty-list-msg">No homes match these filters. Reset to see all 372.</div>`;
      return;
    }

    const html = list
      .map((u) => {
        const isSel = state.selectedUnitNo === u.unit;
        const price = u.lastSalePrice
          ? `AED ${(u.lastSalePrice / 1e6).toFixed(2)}M<small>last sale</small>`
          : u.lastAnnualRent
          ? `AED ${Math.round(u.lastAnnualRent / 1000)}k<small>per year</small>`
          : `${Math.round(u.buaSqft).toLocaleString()}<small>sq ft</small>`;

        return `
          <button type="button" class="unit-row${isSel ? ' selected' : ''}" data-unit="${u.unit}">
            <span class="unit-no">${u.unit}</span>
            <span class="unit-main">
              <strong>${u.design} · ${u.planType}</strong>
              <span>${u.bedrooms} bed · ${u.endOrMiddle} · Front ${FACING_ABBR[u.frontFaces] || u.frontFaces} · ${u.backsOnto}</span>
            </span>
            <span class="unit-price">${price}</span>
          </button>
        `;
      })
      .join('');

    elUnitsList.innerHTML = html;
  }

  function refreshVisuals() {
    community.updateUnitVisualStates({
      selectedUnitNo: state.selectedUnitNo,
      matchingUnitSet: state.matchingUnitSet,
      filterActive: state.filterActive,
      colorMode: state.colorMode,
      cameraMode: state.cameraMode,
    });
  }

  function resetAllFilters() {
    elBedrooms.value = 'all';
    elDesign.value = 'all';
    elPlan.value = 'all';
    elUnitPos.value = 'all';
    elFrontFacing.value = 'all';
    elGardenFacing.value = 'all';
    elBacksOnto.value = 'all';
    elMaxPrice.value = 'all';
    btnPreset4BrPark.classList.remove('active');
    btnPresetPalma3BrNW.classList.remove('active');
    return applyFilters();
  }

  function applyPreset4BrPark() {
    resetAllFilters();
    elBedrooms.value = '4';
    elBacksOnto.value = 'any_park';
    btnPreset4BrPark.classList.add('active');
    return applyFilters();
  }

  function applyPresetPalma3BrNW() {
    resetAllFilters();
    elDesign.value = 'Palma';
    elBedrooms.value = '3';
    elFrontFacing.value = 'North-West';
    btnPresetPalma3BrNW.classList.add('active');
    return applyFilters();
  }

  // Event listeners
  for (const sel of [
    elBedrooms,
    elDesign,
    elPlan,
    elUnitPos,
    elFrontFacing,
    elGardenFacing,
    elBacksOnto,
    elMaxPrice,
  ]) {
    sel.addEventListener('change', () => {
      btnPreset4BrPark.classList.remove('active');
      btnPresetPalma3BrNW.classList.remove('active');
      applyFilters();
    });
  }

  btnReset.addEventListener('click', () => resetAllFilters());
  btnPreset4BrPark.addEventListener('click', () => applyPreset4BrPark());
  btnPresetPalma3BrNW.addEventListener('click', () => applyPresetPalma3BrNW());

  if (btnPresetCommunity) {
    btnPresetCommunity.addEventListener('click', () => {
      if (state.openCommunityModal) state.openCommunityModal();
    });
  }

  elColorMode.addEventListener('change', () => {
    state.colorMode = elColorMode.value;
    updateColorLegend(state.colorMode);
    refreshVisuals();
  });

  elUnitsList.addEventListener('click', (e) => {
    const item = e.target.closest('.unit-row');
    if (!item) return;
    const uno = Number(item.dataset.unit);
    if (uno && state.selectUnit) {
      state.selectUnit(uno, { flyTo: true });
    }
  });

  // Initial populate
  applyFilters();

  return {
    applyFilters,
    resetAllFilters,
    applyPreset4BrPark,
    applyPresetPalma3BrNW,
    refreshVisuals,
    renderUnitsList,
  };
}
