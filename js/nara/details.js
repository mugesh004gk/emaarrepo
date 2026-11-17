/**
 * Selected Home Details Panel, Developer Floor-Plan Sheet Modal & Community Guide Modal
 * For Nara at The Valley (372 Townhouses)
 */
const DESIGN_RENDER = {
  Aston: 'assets/renders/aston.jpg',
  Palma: 'assets/renders/palma.jpg',
  Charm: 'assets/renders/charm.jpg',
};

export function initDetailsModule(state) {
  const { data } = state;
  const unitsByNo = new Map(data.units.map((u) => [u.unit, u]));

  const elHeroImg = document.getElementById('det-hero-img');
  const elHeroDesign = document.getElementById('det-hero-design');
  const elFrontArrow = document.getElementById('det-front-arrow');
  const elGardenArrow = document.getElementById('det-garden-arrow');
  const btnActionShowHome = document.getElementById('btn-action-showhome');

  const elDetailsEmpty = document.getElementById('details-empty');
  const elDetailsContent = document.getElementById('details-content');
  const elDesignBadge = document.getElementById('det-design-badge');
  const elPlanBadge = document.getElementById('det-plan-badge');
  const elPosBadge = document.getElementById('det-pos-badge');
  const elTitle = document.getElementById('det-title');
  const elRowSubtitle = document.getElementById('det-row-subtitle');

  const elBedrooms = document.getElementById('det-bedrooms');
  const elBua = document.getElementById('det-bua');
  const elPlot = document.getElementById('det-plot');
  const elPosition = document.getElementById('det-position');
  const elFrontFacing = document.getElementById('det-front-facing');
  const elGardenFacing = document.getElementById('det-garden-facing');
  const elBacksOnto = document.getElementById('det-backs-onto');

  const elDistPool = document.getElementById('det-dist-pool');
  const elNearestParkName = document.getElementById('det-nearest-park-name');
  const elDistPark = document.getElementById('det-dist-park');
  const elDistMosque = document.getElementById('det-dist-mosque');
  const elDistGate = document.getElementById('det-dist-gate');

  const elSheetLabel = document.getElementById('det-sheet-label');
  const elSheetImg = document.getElementById('det-sheet-img');
  const elRoomsList = document.getElementById('det-rooms-list');
  const elTransactionsBox = document.getElementById('det-transactions-box');

  const btnActionInside = document.getElementById('btn-action-inside');
  const btnActionStreet = document.getElementById('btn-action-street');
  const btnActionFlyto = document.getElementById('btn-action-flyto');
  const btnCloseDetails = document.getElementById('btn-close-details');

  // Modals
  const elSheetModal = document.getElementById('sheet-modal');
  const elModalSheetTitle = document.getElementById('modal-sheet-title');
  const elModalSheetImg = document.getElementById('modal-sheet-img');
  const btnOpenSheetModal = document.getElementById('btn-open-sheet-modal');
  const elSheetPreviewTrigger = document.getElementById('sheet-preview-trigger');
  const btnCloseSheetModal = document.getElementById('btn-close-sheet-modal');

  const elCommunityModal = document.getElementById('community-modal');
  const elCommunityModalBody = document.getElementById('community-modal-body');
  const btnCloseCommunityModal = document.getElementById('btn-close-community-modal');

  function showUnitDetails(unitNo) {
    const u = unitsByNo.get(Number(unitNo));
    if (!u) {
      elDetailsEmpty.classList.remove('hidden');
      elDetailsContent.classList.add('hidden');
      return;
    }

    const pdata = data.plans[u.planType];
    elDetailsEmpty.classList.add('hidden');
    elDetailsContent.classList.remove('hidden');

    elHeroImg.src = DESIGN_RENDER[u.design] || DESIGN_RENDER.Aston;
    elHeroImg.alt = `${u.design} design, brochure render`;
    elHeroDesign.textContent = u.design;

    elDesignBadge.textContent = u.design;
    elDesignBadge.className = `badge badge-${u.design.toLowerCase()}`;
    elPlanBadge.textContent = `Plan ${u.planType}`;
    elPosBadge.textContent = `${u.endOrMiddle} unit · TH ${u.th}`;

    elTitle.textContent = `Unit ${u.unit}`;
    elRowSubtitle.textContent = `${u.planName} · ${u.plex} row ${u.row}`;

    elBedrooms.innerHTML = `${u.bedrooms} <small>+ maid</small>`;
    elBua.innerHTML = `${Math.round(u.buaSqft).toLocaleString()} <small>sq ft</small><span class="stat-sub">${u.buaSqm.toFixed(1)} m²</span>`;
    elPlot.innerHTML = `${u.plotSqft.toLocaleString()} <small>sq ft</small>`;
    elPosition.textContent = `${u.endOrMiddle} · TH ${u.th}`;
    elFrontFacing.textContent = `${u.frontFaces} · ${u.frontBearing.toFixed(1)}°`;
    elGardenFacing.textContent = `${u.gardenFaces} · ${u.gardenBearing.toFixed(1)}°`;
    elFrontArrow.style.transform = `rotate(${u.frontBearing}deg)`;
    elGardenArrow.style.transform = `rotate(${u.gardenBearing}deg)`;
    elBacksOnto.textContent = u.backsOnto;

    elDistPool.textContent = `${u.distPool} m`;
    elNearestParkName.textContent = u.nearestPark || 'Nearest Park';
    elDistPark.textContent = `${u.distPark} m`;
    elDistMosque.textContent = `${u.distMosque} m`;
    elDistGate.textContent = `${u.distGate} m`;

    elSheetLabel.textContent = u.planType;
    elSheetImg.src = pdata.sheetImage;
    elSheetImg.alt = `Developer Floor Plan Sheet ${u.planType}`;

    renderRoomsBreakdown(u, pdata);
    renderTransactions(u);
  }

  function renderRoomsBreakdown(u, pdata) {
    const groups = [
      { key: 'ground', title: 'Ground Floor' },
      { key: 'first', title: 'First Floor' },
    ];

    const html = groups
      .map((g) => {
        const rooms = pdata.floors[g.key].rooms;
        const rows = rooms
          .map(
            (rm, idx) => `
          <button class="room-dim-chip" data-floor="${g.key}" data-room-idx="${idx}" title="Jump inside to ${rm.name}">
            <span class="r-name">${rm.name}</span>
            <span class="r-dim">${rm.dims ? rm.dims + ' m' : rm.areaM2 ? rm.areaM2.toFixed(1) + ' m²' : ''}</span>
          </button>
        `
          )
          .join('');
        return `
          <div class="floor-rooms-group">
            <div class="floor-group-label">${g.title}</div>
            <div class="floor-rooms-chips">${rows}</div>
          </div>
        `;
      })
      .join('');

    elRoomsList.innerHTML = html;
  }

  // community medians from data.market.ranges ('3BR', '4BR'; older bundles used sales/leases.last12MonthsByBedrooms)
  function marketNote(beds) {
    const m = data.market || {};
    const r = m.ranges?.[`${beds}BR`];
    const sale = r?.saleMedian ?? m.sales?.last12MonthsByBedrooms?.[String(beds)]?.median;
    const rent = r?.rentMedian ?? m.leases?.last12MonthsByBedrooms?.[String(beds)]?.median;
    if (!sale && !rent) return `No 12-month community median published for ${beds}-bedroom homes yet.`;
    return `12-month community median (${beds} BR):${sale ? ` sale AED ${(sale / 1e6).toFixed(2)}M` : ''}${sale && rent ? ' ·' : ''}${rent ? ` rent AED ${rent.toLocaleString()}/yr` : ''}`;
  }

  function renderTransactions(u) {
    const sales = u.sales || [];
    const leases = u.leases || [];

    if (sales.length === 0 && leases.length === 0) {
      elTransactionsBox.innerHTML = `
        <div class="tx-empty">
          No individual DLD sale or lease registration recorded for Unit ${u.unit} in the dataset.
          <div class="tx-market-note">${marketNote(u.bedrooms)}</div>
        </div>
      `;
      return;
    }

    let html = '';
    if (sales.length > 0) {
      html += `<div class="tx-subhead">Sales (${sales.length})</div>`;
      html += sales
        .map(
          (s) => `
        <div class="tx-row tx-sale">
          <div>
            <strong>AED ${s.priceAED.toLocaleString()}</strong>
            <span class="tx-badge">${s.status}</span>
          </div>
          <div class="tx-meta">${s.date}${s.psf ? ` · AED ${s.psf.toLocaleString()} per sq ft` : ''}</div>
        </div>
      `
        )
        .join('');
    }

    if (leases.length > 0) {
      html += `<div class="tx-subhead">Leases (${leases.length})</div>`;
      html += leases
        .map(
          (l) => `
        <div class="tx-row tx-lease">
          <div>
            <strong>AED ${l.rentAED.toLocaleString()} / yr</strong>
            <span class="tx-badge">${l.contract}</span>
          </div>
          <div class="tx-meta">${l.date} (${l.start} to ${l.end})</div>
        </div>
      `
        )
        .join('');
    }

    elTransactionsBox.innerHTML = html;
  }

  function openSheetModal() {
    const u = unitsByNo.get(state.selectedUnitNo || 233);
    if (!u) return;
    const pdata = data.plans[u.planType];
    elModalSheetTitle.textContent = `Unit ${u.unit} · ${u.planName} (${u.planType}) · ${Math.round(u.buaSqft).toLocaleString()} sq ft built-up`;
    elModalSheetImg.src = pdata.sheetImage;
    elSheetModal.classList.remove('hidden');
  }

  function openCommunityModal() {
    const c = data.community;
    const amenitiesHtml = c.amenities
      .map(
        (a) => `
      <div class="guide-amenity-item">
        <span class="am-num">${a.no}</span>
        <div>
          <strong>${a.name}</strong>
          <p>${a.detail}</p>
        </div>
      </div>
    `
      )
      .join('');

    elCommunityModalBody.innerHTML = `
      <div class="guide-grid">
        <div>
          <h4>${c.tagline} — ${c.subtitle}</h4>
          <p class="guide-lead">${c.intro}</p>
          <h5>The 10 Numbered Community Amenities</h5>
          <div class="guide-amenities-list">${amenitiesHtml}</div>
        </div>
        <div>
          <h5>Developer Reference Renders &amp; Masterplan</h5>
          <div class="guide-renders-grid">
            <figure><img src="assets/renders/aston.jpg" alt="Aston Design" /><figcaption>Aston Collection (132 Homes)</figcaption></figure>
            <figure><img src="assets/renders/palma.jpg" alt="Palma Design" /><figcaption>Palma Collection (188 Homes)</figcaption></figure>
            <figure><img src="assets/renders/charm.jpg" alt="Charm Design" /><figcaption>Charm Collection (52 Homes)</figcaption></figure>
            <figure><img src="assets/renders/pool.jpg" alt="Community Centre Pool" /><figcaption>Amenity #1: Community Centre &amp; Pool</figcaption></figure>
            <figure><img src="assets/renders/cycle_path.jpg" alt="Wadi Cycle Track" /><figcaption>Dry Landscaped Valley &amp; Blue Cycle Track</figcaption></figure>
            <figure><img src="assets/renders/interior_living.jpg" alt="Interior Living Room" /><figcaption>Brochure Interior Reference</figcaption></figure>
          </div>
        </div>
      </div>
    `;
    elCommunityModal.classList.remove('hidden');
  }

  // Event bindings
  document.querySelectorAll('[data-goto-unit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const uno = Number(btn.dataset.gotoUnit);
      if (uno && state.selectUnit) state.selectUnit(uno, { flyTo: true });
    });
  });

  btnCloseDetails.addEventListener('click', () => {
    if (state.toggleDetailsPanel) {
      state.toggleDetailsPanel(false);
    } else {
      elDetailsContent.classList.add('hidden');
      elDetailsEmpty.classList.remove('hidden');
    }
  });

  btnActionInside.addEventListener('click', () => {
    if (state.selectedUnitNo && state.enterHomeInterior) {
      state.enterHomeInterior(state.selectedUnitNo, 'interior');
    }
  });

  btnActionStreet.addEventListener('click', () => {
    if (state.selectedUnitNo && state.enterStreetMode) {
      state.enterStreetMode(state.selectedUnitNo);
    }
  });

  btnActionShowHome.addEventListener('click', () => {
    if (state.setCameraMode) state.setCameraMode('showhome');
  });

  btnActionFlyto.addEventListener('click', () => {
    if (state.selectedUnitNo && state.flyToUnit) {
      state.setCameraMode('aerial');
      state.flyToUnit(state.selectedUnitNo);
    }
  });

  elRoomsList.addEventListener('click', (e) => {
    const chip = e.target.closest('.room-dim-chip');
    if (!chip || !state.selectedUnitNo) return;
    const flKey = chip.dataset.floor;
    const rIdx = Number(chip.dataset.roomIdx);
    const u = unitsByNo.get(state.selectedUnitNo);
    const rm = data.plans[u.planType].floors[flKey].rooms[rIdx];
    if (rm && state.jumpToRoomInUnit) {
      state.jumpToRoomInUnit(state.selectedUnitNo, flKey, rm.name);
    }
  });

  btnOpenSheetModal.addEventListener('click', openSheetModal);
  elSheetPreviewTrigger.addEventListener('click', openSheetModal);
  btnCloseSheetModal.addEventListener('click', () => elSheetModal.classList.add('hidden'));
  btnCloseCommunityModal.addEventListener('click', () => elCommunityModal.classList.add('hidden'));

  return {
    showUnitDetails,
    openSheetModal,
    openCommunityModal,
  };
}
