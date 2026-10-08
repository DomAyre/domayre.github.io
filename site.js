const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const narrowViewport = window.matchMedia("(max-width: 1100px), (hover: none) and (pointer: coarse)");
const header = document.querySelector(".site-header");
const mainContent = document.querySelector("#content");
mainContent.classList.add("has-scroll-fade");
const timeline = document.querySelector(".timeline-list");
const filters = document.querySelectorAll("[data-filter]");
const selectedTypes = new Set();
const count = document.querySelector("#timeline-count");
const minimap = document.querySelector(".minimap");
const mapTrack = minimap.querySelector(".minimap-track");
const mapMarks = minimap.querySelector(".minimap-marks");
const mapViewport = minimap.querySelector(".minimap-viewport");
const entries = Array.from(timeline.querySelectorAll(".timeline-entry"), (element) => {
  const sourceDate = element.querySelector("time").dateTime;
  const fullDate = sourceDate.length === 4 ? `${sourceDate}-01-01` : sourceDate.length === 7 ? `${sourceDate}-01` : sourceDate;
  const date = new Date(`${fullDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timeline date: ${element.id}`);
  return { element, date, pinned: element.dataset.pinned === "now", yearOnly: sourceDate.length === 4, type: element.dataset.type };
}).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.date - a.date);

const DAY = 86_400_000;
const COMPRESSED_GAP_DAYS = 270;
const dateFormat = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
let visibleEntries = entries;
let gaps = [];
let marks = [];
let geometry;
let layoutFrame;
let scrollFrame;
let clearAllFiltersTimer;
let expandedEntry;
let accordionScrollFrame;
const filterAnimations = new Set();
const cardAnimations = new Set();

function stopAccordionScroll() {
  cancelAnimationFrame(accordionScrollFrame);
}

function releaseAccordionSpace() {
  if (cardAnimations.size === 0) mainContent.style.removeProperty("min-height");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function cancelFilterMotion() {
  filterAnimations.forEach((animation) => animation.cancel());
  filterAnimations.clear();
}

function transitionBlock(element, before, height, animate, delay = 0) {
  const visible = height > 0;
  const finish = () => {
    element.hidden = !visible;
    element.classList.remove("is-filtering");
    element.style.removeProperty("opacity");
    if (element.classList.contains("timeline-gap")) {
      element.style.height = `${height}px`;
    } else {
      element.style.removeProperty("height");
    }
    scheduleMapLayout();
  };
  if (!animate || (Math.abs(before.height - height) < 1 && before.opacity === Number(visible))) {
    finish();
    return;
  }
  element.hidden = false;
  element.classList.add("is-filtering");
  element.style.height = `${height}px`;
  const animation = element.animate([
    { height: `${before.height}px`, opacity: before.opacity },
    { height: `${height}px`, opacity: Number(visible) },
  ], { duration: 460, delay, easing: "cubic-bezier(.22, 1, .36, 1)", fill: "backwards" });
  filterAnimations.add(animation);
  animation.onfinish = () => {
    filterAnimations.delete(animation);
    finish();
  };
  animation.oncancel = () => filterAnimations.delete(animation);
}

function createWave(className) {
  const wave = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  wave.setAttribute("viewBox", "0 0 17 80");
  wave.setAttribute("preserveAspectRatio", "none");
  wave.setAttribute("aria-hidden", "true");
  wave.classList.add(className);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M8.5 0 V8 C2 12 2 20 8.5 24 S15 36 8.5 40 S2 52 8.5 56 S15 68 8.5 72 V80");
  wave.append(path);
  return wave;
}

function describeGap(newer, older) {
  let months = (newer.getUTCFullYear() - older.getUTCFullYear()) * 12 + newer.getUTCMonth() - older.getUTCMonth();
  if (newer.getUTCDate() < older.getUTCDate()) months -= 1;
  const years = Math.floor(months / 12);
  const remainder = months % 12;
  return [
    years ? `${years} ${years === 1 ? "year" : "years"}` : "",
    remainder ? `${remainder} ${remainder === 1 ? "month" : "months"}` : "",
  ].filter(Boolean).join(", ");
}

function describeEntryDate(entry, yearOnly = false) {
  if (entry.pinned) return "Now";
  return yearOnly || entry.yearOnly ? String(entry.date.getUTCFullYear()) : dateFormat.format(entry.date);
}

function renderGaps() {
  entries.forEach(({ element }) => element.classList.remove("is-first", "is-last"));
  gaps = [];
  entries.forEach((entry) => {
    const index = visibleEntries.indexOf(entry);
    const gap = entry.gap;
    gap.classList.remove("compressed");
    gap.removeAttribute("aria-label");
    gap.setAttribute("aria-hidden", "true");
    gap.replaceChildren();
    entry.gapHeight = 0;
    if (index === -1) return;
    entry.element.classList.toggle("is-first", index === 0);
    entry.element.classList.toggle("is-last", index === visibleEntries.length - 1);
    const next = visibleEntries[index + 1];
    if (!next) return;
    if (entry.pinned) {
      entry.gapHeight = 28;
      return;
    }
    const days = (entry.date - next.date) / DAY;
    if (days > COMPRESSED_GAP_DAYS) {
      gap.classList.add("compressed");
      gap.removeAttribute("aria-hidden");
      entry.gapHeight = 80;
      const label = document.createElement("span");
      label.className = "gap-label";
      if (entry.yearOnly || next.yearOnly) {
        const years = Math.max(1, Math.round(days / 365.25));
        label.textContent = `About ${years} ${years === 1 ? "year" : "years"}`;
      } else {
        label.textContent = describeGap(entry.date, next.date);
      }
      gap.setAttribute("aria-label", `${label.textContent} between entries; time compressed`);
      gap.append(createWave("gap-wave"), label);
      gaps.push(gap);
    } else {
      entry.gapHeight = Math.min(56, 20 + days / 6);
    }
  });
  timeline.classList.add("is-enhanced");
}

function renderMap() {
  mapMarks.replaceChildren();
  const years = new Set();
  marks = visibleEntries.map((entry) => {
    const mark = document.createElement("span");
    mark.className = "mini-entry";
    mark.dataset.type = entry.type;
    mapMarks.append(mark);
    const year = describeEntryDate(entry, true);
    let label;
    if (!years.has(year)) {
      label = document.createElement("span");
      label.className = "mini-year";
      label.textContent = year;
      mapMarks.append(label);
      years.add(year);
    }
    return { entry, mark, label };
  });
  gaps.forEach((gap) => {
    const wave = createWave("mini-gap");
    mapMarks.append(wave);
    gap.mapWave = wave;
  });
  minimap.hidden = visibleEntries.length === 0;
  if (visibleEntries.length) {
    document.querySelector("#minimap-newest").textContent = describeEntryDate(visibleEntries[0], true);
    document.querySelector("#minimap-oldest").textContent = describeEntryDate(visibleEntries.at(-1), true);
  }
  measureMap();
}

function measureMap() {
  if (minimap.hidden || narrowViewport.matches) return;
  const bounds = timeline.getBoundingClientRect();
  const lastEntry = visibleEntries.at(-1).element;
  const height = Math.max(1, lastEntry.offsetTop + lastEntry.offsetHeight);
  const mapHeight = mapTrack.clientHeight;
  const maximumScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  geometry = {
    top: bounds.top + scrollY,
    height,
    mapHeight,
    maximumScroll,
    minimumScroll: Math.min(maximumScroll, Math.max(0, bounds.top + scrollY - header.offsetHeight - 32)),
  };
  let lastLabelPosition = -20;
  marks.forEach(({ entry, mark, label }) => {
    const top = entry.element.offsetTop / height * mapHeight;
    const markHeight = entry.element.offsetHeight / height * mapHeight;
    mark.style.top = `${top}px`;
    mark.style.height = `${Math.max(2, markHeight)}px`;
    if (label) {
      label.style.top = `${top + 4}px`;
      label.hidden = top - lastLabelPosition < 17;
      if (!label.hidden) lastLabelPosition = top;
    }
  });
  gaps.forEach((gap) => {
    gap.mapWave.style.top = `${gap.offsetTop / height * mapHeight}px`;
    gap.mapWave.style.height = `${gap.offsetHeight / height * mapHeight}px`;
  });
  updateMapPosition();
}

function scheduleMapLayout() {
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(measureMap);
}

function updateMapPosition() {
  mainContent.style.setProperty("--content-scroll", `${Math.max(0, -mainContent.getBoundingClientRect().top)}px`);
  if (!geometry || minimap.hidden || narrowViewport.matches) return;
  const { top, height, mapHeight, minimumScroll, maximumScroll } = geometry;
  const visibleTop = clamp((scrollY + header.offsetHeight - top) / height, 0, 1);
  const visibleBottom = clamp((scrollY + innerHeight - top) / height, 0, 1);
  const viewportHeight = Math.max(12, (visibleBottom - visibleTop) * mapHeight);
  mapViewport.style.height = `${viewportHeight}px`;
  mapViewport.style.top = `${Math.min(visibleTop * mapHeight, mapHeight - viewportHeight)}px`;
  const range = maximumScroll - minimumScroll;
  const progress = range > 0 ? clamp((scrollY - minimumScroll) / range, 0, 1) : 0;
  mapTrack.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
  let current = visibleEntries[0];
  for (const entry of visibleEntries) {
    if (entry.element.getBoundingClientRect().top <= header.offsetHeight + 100) current = entry;
  }
  if (progress >= .999) current = visibleEntries.at(-1);
  marks.forEach(({ entry, mark }) => mark.classList.toggle("is-current", entry === current));
  const dateLabel = describeEntryDate(current);
  mapTrack.setAttribute("aria-valuetext", `${dateLabel} - ${current.type}`);
}

function updateFilterButtons() {
  filters.forEach((button) => button.setAttribute("aria-pressed", String(selectedTypes.has(button.dataset.filter))));
}

function applyFilters(animate = true) {
  stopAccordionScroll();
  stopMinimapScrub();
  const motion = animate && !reducedMotion.matches;
  const previous = new Map();
  for (const entry of entries) {
    for (const element of [entry.element, entry.gap]) {
      const height = element.getBoundingClientRect().height;
      const opacity = height > 0 ? Number(getComputedStyle(element).opacity) : 0;
      previous.set(element, { height, opacity });
      // Freeze the current frame before cancelling an interrupted transition.
      element.style.height = `${height}px`;
      element.style.opacity = String(opacity);
    }
  }
  cancelFilterMotion();
  updateFilterButtons();
  visibleEntries = entries.filter((entry) => selectedTypes.size === 0 || selectedTypes.has(entry.type));
  entries.forEach((entry) => {
    entry.element.inert = !visibleEntries.includes(entry);
    if (entry.element.inert) entry.element.querySelectorAll("video").forEach((video) => video.pause());
    if (!entry.element.inert) entry.element.hidden = false;
  });
  const type = selectedTypes.size === 1 ? selectedTypes.values().next().value : null;
  const label = type ? `${type}${visibleEntries.length === 1 ? "" : "s"}` : visibleEntries.length === 1 ? "entry" : "entries";
  count.textContent = `${visibleEntries.length} ${label}`;
  document.querySelector(".empty-state").hidden = visibleEntries.length > 0;
  renderGaps();
  let arrival = 0;
  entries.forEach((entry) => {
    const card = entry.element.querySelector(".entry-card");
    const height = entry.element.inert ? 0 : card.offsetTop + card.offsetHeight;
    const before = previous.get(entry.element);
    const delay = height > 0 && before.height === 0 ? Math.min(arrival++ * 30, 120) : 0;
    transitionBlock(entry.element, before, height, motion, delay);
    transitionBlock(entry.gap, previous.get(entry.gap), entry.gapHeight, motion, delay);
  });
  renderMap();
  scheduleMapLayout();
}

entries.forEach((entry) => {
  const { element } = entry;
  timeline.append(element);
  const card = element.querySelector(".entry-card");
  const summary = card.querySelector("summary");
  const content = card.querySelector(".entry-content");
  const repository = entry.type === "project" ? content.querySelector('a[href^="https://github.com/"]') : null;
  if (repository) {
    const title = summary.querySelector("h2");
    const actions = document.createElement("span");
    actions.className = "entry-actions";
    const link = repository.cloneNode(false);
    link.className = "project-github";
    link.title = "View on GitHub";
    link.setAttribute("aria-label", `View ${title.textContent} on GitHub`);
    link.append(document.querySelector('.contact a[href^="https://github.com/"] svg').cloneNode(true));
    actions.append(link, summary.querySelector(".entry-toggle"));
    summary.append(actions);
  }
  let expanded = card.open;
  let animation;
  card.removeAttribute("name");
  card.classList.add("is-enhanced");
  content.inert = !expanded;
  summary.setAttribute("aria-expanded", String(expanded));

  entry.setExpanded = (value, animate = true) => {
    if (expanded === value) return;
    expanded = value;
    if (!expanded) content.querySelectorAll("video").forEach((video) => video.pause());
    const startHeight = card.getBoundingClientRect().height;
    if (animation) {
      cardAnimations.delete(animation);
      animation.cancel();
      animation = undefined;
    }
    card.open = true;
    card.classList.toggle("is-expanded", expanded);
    content.inert = !expanded;
    summary.setAttribute("aria-expanded", String(expanded));
    const border = parseFloat(getComputedStyle(card).borderTopWidth) * 2;
    const endHeight = expanded ? card.getBoundingClientRect().height : summary.getBoundingClientRect().height + border;
    if (!animate || reducedMotion.matches || element.hidden || element.inert) {
      card.open = expanded;
      scheduleMapLayout();
      return;
    }
    animation = card.animate([{ height: `${startHeight}px` }, { height: `${endHeight}px` }], {
      duration: 300,
      easing: "cubic-bezier(.22, 1, .36, 1)",
    });
    const currentAnimation = animation;
    cardAnimations.add(currentAnimation);
    currentAnimation.onfinish = () => {
      card.open = expanded;
      cardAnimations.delete(currentAnimation);
      if (animation === currentAnimation) animation = undefined;
      releaseAccordionSpace();
      scheduleMapLayout();
    };
  };

  summary.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("a")) return;
    event.preventDefault();
    stopAccordionScroll();
    stopMinimapScrub();
    const opening = !expanded;
    const previous = expandedEntry;
    const anchorTop = summary.getBoundingClientRect().top;
    const keepMobilePosition = narrowViewport.matches && opening;
    const keepPosition = !narrowViewport.matches && opening && previous && !previous.element.inert
      && previous.element.getBoundingClientRect().top < element.getBoundingClientRect().top && scrollY > 0;
    if (keepMobilePosition) {
      // Reserve the scroll range while swapping cards so Safari cannot clamp it mid-layout.
      mainContent.style.minHeight = `${mainContent.getBoundingClientRect().height}px`;
      if (filterAnimations.size) applyFilters(false);
    }
    if (opening && previous && previous !== entry) previous.setExpanded(false, !keepMobilePosition);
    entry.setExpanded(opening);
    expandedEntry = opening ? entry : undefined;

    if (keepMobilePosition) {
      const delta = summary.getBoundingClientRect().top - anchorTop;
      if (Math.abs(delta) > .5) window.scrollBy({ top: delta, behavior: "instant" });
    }
    releaseAccordionSpace();
    if (keepPosition) {
      const anchor = () => {
        const delta = summary.getBoundingClientRect().top - anchorTop;
        if (Math.abs(delta) > .5) window.scrollBy({ top: delta, behavior: "instant" });
        if (animation?.playState === "running") accordionScrollFrame = requestAnimationFrame(anchor);
      };
      anchor();
    }
  });
});

entries.forEach((entry) => {
  entry.gap = document.createElement("li");
  entry.gap.className = "timeline-gap";
  entry.gap.hidden = true;
  entry.element.after(entry.gap);
});

filters.forEach((button) => {
  button.addEventListener("click", () => {
    clearTimeout(clearAllFiltersTimer);
    const type = button.dataset.filter;
    if (selectedTypes.has(type)) {
      selectedTypes.delete(type);
    } else {
      selectedTypes.add(type);
    }
    applyFilters();
    if (selectedTypes.size === filters.length) {
      clearAllFiltersTimer = setTimeout(() => {
        selectedTypes.clear();
        updateFilterButtons();
      }, 1500);
    }
  });
});
document.querySelector(".timeline-filters").hidden = false;

let activeScrub;

function preventScrubScroll(event) {
  if (activeScrub && event.cancelable) event.preventDefault();
}

function stopMinimapScrub() {
  if (!activeScrub) return;
  const { pointerId } = activeScrub;
  activeScrub = undefined;
  window.removeEventListener("wheel", preventScrubScroll, true);
  if (mapTrack.hasPointerCapture(pointerId)) mapTrack.releasePointerCapture(pointerId);
}

function moveMinimapScrub(event) {
  if (!activeScrub || event.pointerId !== activeScrub.pointerId) return;
  event.preventDefault();
  const target = activeScrub.startScroll + (event.clientY - activeScrub.startY) * activeScrub.scale;
  window.scrollTo({ top: clamp(target, 0, activeScrub.maximumScroll), behavior: "instant" });
}

mapTrack.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !event.isPrimary || activeScrub) return;
  measureMap();
  if (!geometry || mapTrack.clientHeight === 0) return;
  event.preventDefault();
  stopAccordionScroll();
  const bounds = mapTrack.getBoundingClientRect();
  const viewport = mapViewport.getBoundingClientRect();
  const grabbedViewport = event.clientX >= viewport.left && event.clientX <= viewport.right
    && event.clientY >= viewport.top && event.clientY <= viewport.bottom;
  const ratio = clamp((event.clientY - bounds.top) / bounds.height, 0, 1);
  const target = geometry.top + ratio * geometry.height - (innerHeight + header.offsetHeight) / 2;
  const startScroll = grabbedViewport ? scrollY : clamp(target, 0, geometry.maximumScroll);
  // Keep drag coordinates fixed even if browser chrome changes the viewport mid-gesture.
  activeScrub = {
    pointerId: event.pointerId,
    startY: event.clientY,
    startScroll,
    scale: geometry.height / bounds.height,
    maximumScroll: geometry.maximumScroll,
  };
  mapTrack.setPointerCapture(event.pointerId);
  mapTrack.focus({ preventScroll: true });
  window.addEventListener("wheel", preventScrubScroll, { passive: false, capture: true });
  // Also cancel an in-flight scroll when grabbing the indicator without moving it.
  window.scrollTo({ top: startScroll, behavior: "instant" });
});
mapTrack.addEventListener("pointermove", moveMinimapScrub);
mapTrack.addEventListener("pointerup", (event) => {
  if (event.pointerId !== activeScrub?.pointerId) return;
  moveMinimapScrub(event);
  stopMinimapScrub();
});
mapTrack.addEventListener("pointercancel", (event) => {
  if (event.pointerId === activeScrub?.pointerId) stopMinimapScrub();
});
mapTrack.addEventListener("lostpointercapture", (event) => {
  if (event.pointerId === activeScrub?.pointerId) stopMinimapScrub();
});
mapTrack.addEventListener("touchmove", preventScrubScroll, { passive: false });
mapTrack.addEventListener("keydown", (event) => {
  const position = Number(mapTrack.getAttribute("aria-valuenow"));
  const destinations = { ArrowUp: position - 5, ArrowLeft: position - 5, ArrowDown: position + 5, ArrowRight: position + 5, PageUp: position - 20, PageDown: position + 20, Home: 0, End: 100 };
  if (!Object.hasOwn(destinations, event.key)) return;
  event.preventDefault();
  stopMinimapScrub();
  const ratio = clamp(destinations[event.key], 0, 100) / 100;
  window.scrollTo({
    top: geometry.minimumScroll + ratio * (geometry.maximumScroll - geometry.minimumScroll),
    behavior: reducedMotion.matches ? "instant" : "smooth",
  });
});

window.addEventListener("scroll", () => {
  cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(updateMapPosition);
}, { passive: true });
window.addEventListener("resize", scheduleMapLayout);
window.addEventListener("blur", stopMinimapScrub);
window.addEventListener("wheel", stopAccordionScroll, { passive: true });
window.addEventListener("touchstart", stopAccordionScroll, { passive: true });
window.addEventListener("keydown", stopAccordionScroll);
new ResizeObserver(scheduleMapLayout).observe(timeline);
narrowViewport.addEventListener("change", () => {
  stopMinimapScrub();
  scheduleMapLayout();
});
reducedMotion.addEventListener("change", () => {
  if (reducedMotion.matches) {
    applyFilters(false);
  }
});

document.querySelectorAll(".carousel").forEach((carousel) => {
  const track = carousel.querySelector(".carousel-track");
  const slides = carousel.querySelectorAll(".carousel-slide");
  const controls = document.querySelector("#carousel-controls-template").content.firstElementChild.cloneNode(true);
  carousel.querySelector(".carousel-caption").append(controls);
  controls.querySelector("[data-total-slides]").textContent = String(slides.length).padStart(2, "0");
  controls.querySelectorAll("button").forEach((button) => button.setAttribute("aria-controls", track.id));
  track.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight Home End");
  slides.forEach((slide, index) => {
    slide.setAttribute("role", "group");
    slide.setAttribute("aria-roledescription", "slide");
    slide.setAttribute("aria-label", `${index + 1} of ${slides.length}`);
  });
  const previous = carousel.querySelector('[data-direction="-1"]');
  const next = carousel.querySelector('[data-direction="1"]');
  const position = carousel.querySelector("[data-current-slide]");
  let index = 0;
  let scrollTimer;

  function updateControls() {
    position.textContent = String(index + 1).padStart(2, "0");
    previous.disabled = index === 0;
    next.disabled = index === slides.length - 1;
  }
  function goToSlide(destination) {
    index = clamp(destination, 0, slides.length - 1);
    updateControls();
    track.scrollTo({ left: index * track.clientWidth, behavior: reducedMotion.matches ? "auto" : "smooth" });
  }
  previous.addEventListener("click", () => goToSlide(index - 1));
  next.addEventListener("click", () => goToSlide(index + 1));
  track.addEventListener("keydown", (event) => {
    const destinations = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: slides.length - 1 };
    if (Object.hasOwn(destinations, event.key)) {
      event.preventDefault();
      goToSlide(destinations[event.key]);
    }
  });
  track.addEventListener("scroll", () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (track.clientWidth === 0) return;
      index = clamp(Math.round(track.scrollLeft / track.clientWidth), 0, slides.length - 1);
      updateControls();
    }, 120);
  }, { passive: true });
  new ResizeObserver(() => {
    if (track.clientWidth > 0) track.scrollTo({ left: index * track.clientWidth, behavior: "auto" });
  }).observe(track);
  controls.hidden = false;
  updateControls();
});

applyFilters(false);
