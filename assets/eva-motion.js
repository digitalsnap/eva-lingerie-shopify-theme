/**
 * Eva motion: content fades up as it scrolls into view, and scrolling text bands can be paused.
 *
 * Runs only when the theme's motion setting is on and the visitor hasn't asked for reduced motion
 * (snippets/eva-head.liquid then sets `eva-motion` on <html>). Elements marked [data-eva-reveal] start
 * hidden in CSS, but only once this script has marked <html> with `eva-motion-js`, so if it never
 * loads they simply stay visible. Animations use transform and opacity only: no layout shift.
 */

const root = document.documentElement;
const STAGGER_MS = 90;
const MAX_STAGGER = 5;

/** @type {IntersectionObserver | null} */
let observer = null;

/**
 * @param {Element} element
 * @param {boolean} [entering] - Scrolled into view (rather than on screen from the start), which also
 *   lets category images settle (eva-base.css).
 */
function reveal(element, entering = false) {
  element.classList.add('is-revealed');
  if (entering) element.classList.add('is-entering');
}

/**
 * Watches every unrevealed element in a scope. Siblings that appear together (cards in a grid)
 * get a small, capped stagger.
 * @param {ParentNode} scope
 */
function watch(scope) {
  if (!observer) return;

  for (const element of scope.querySelectorAll('[data-eva-reveal]:not(.is-revealed)')) {
    if (!(element instanceof HTMLElement)) continue;

    const siblings = element.parentElement
      ? [...element.parentElement.children].filter((child) => child.hasAttribute('data-eva-reveal'))
      : [];
    const index = Math.min(siblings.indexOf(element), MAX_STAGGER);
    if (index > 0) element.style.setProperty('--eva-reveal-delay', `${index * STAGGER_MS}ms`);

    observer.observe(element);
  }
}

if (root.classList.contains('eva-motion')) {
  // Already on screen when this runs: leave it as it is, so nothing visible blinks out and back in.
  for (const element of document.querySelectorAll('[data-eva-reveal]')) {
    if (element.getBoundingClientRect().top < window.innerHeight) reveal(element);
  }

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        reveal(entry.target, true);
        observer?.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.1 }
  );

  root.classList.add('eva-motion-js');
  watch(document);

  // The theme editor re-renders sections in place; Eva components announce content they fetch
  // after load (e.g. "Complete the set"), which would otherwise stay hidden.
  for (const type of ['shopify:section:load', 'eva:content-loaded']) {
    document.addEventListener(type, (event) => {
      if (event.target instanceof Element) watch(event.target);
    });
  }
}

/*
 * Pause / play for scrolling text bands (sections/eva-marquee.liquid). Moving text that runs for
 * more than five seconds must be pausable (WCAG 2.2.2).
 */
document.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest('[data-eva-marquee-toggle]') : null;
  if (!(button instanceof HTMLButtonElement)) return;

  const marquee = button.closest('.eva-marquee');
  if (!marquee) return;

  // One constant label ("Pause moving text"); the pressed state says whether it is paused.
  button.setAttribute('aria-pressed', String(marquee.classList.toggle('is-paused')));
});
