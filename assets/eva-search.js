const SEARCH_DELAY = 200;

/**
 * <eva-predictive-search> — live results in the header search panel. Each pause in typing asks
 * Shopify's Predictive Search API to render sections/eva-predictive-search.liquid and swaps the
 * result in; an older request still in flight is cancelled. The form itself submits to /search,
 * so Enter (and browsers without JavaScript) go to the full results page.
 */
class EvaPredictiveSearch extends HTMLElement {
  /** @type {AbortController | null} */
  #controller = null;

  /** @type {number | undefined} */
  #timer;

  /** @type {HTMLInputElement | null} */
  #input = null;

  connectedCallback() {
    const input = this.querySelector('input[type="search"]');
    if (!(input instanceof HTMLInputElement)) return;

    this.#input = input;
    input.addEventListener('input', this.#onInput);
  }

  disconnectedCallback() {
    this.#input?.removeEventListener('input', this.#onInput);
    this.#controller?.abort();
    window.clearTimeout(this.#timer);
  }

  #onInput = () => {
    window.clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => this.#search(this.#input?.value.trim() ?? ''), SEARCH_DELAY);
  };

  /** @param {string} terms */
  async #search(terms) {
    const results = this.querySelector('[data-results]');
    if (!(results instanceof HTMLElement)) return;

    this.#controller?.abort();
    if (!terms) {
      results.replaceChildren();
      this.#announce('');
      return;
    }

    const controller = new AbortController();
    this.#controller = controller;

    const url = new URL(this.dataset.url ?? '/search/suggest', window.location.origin);
    url.searchParams.set('q', terms);
    url.searchParams.set('section_id', this.dataset.section ?? '');
    url.searchParams.set('resources[type]', 'product,query,collection,page,article');
    url.searchParams.set('resources[limit]', '6');
    url.searchParams.set('resources[limit_scope]', 'each');

    results.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return;

      const html = new DOMParser().parseFromString(await response.text(), 'text/html');
      const fresh = html.querySelector('[data-predictive-results]');
      if (controller.signal.aborted) return;

      results.replaceChildren(...(fresh ? [fresh] : []));
      const count = Number(fresh instanceof HTMLElement ? fresh.dataset.count : 0);
      this.#announce(
        count > 0 ? (this.dataset.labelCount ?? '').replace('[count]', String(count)) : this.dataset.labelNone ?? ''
      );
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) console.error('[eva-search]', error);
    } finally {
      if (this.#controller === controller) {
        results.removeAttribute('aria-busy');
        this.#controller = null;
      }
    }
  }

  /** @param {string} message */
  #announce(message) {
    const status = this.querySelector('[data-status]');
    if (status) status.textContent = message;
  }
}

if (!customElements.get('eva-predictive-search')) customElements.define('eva-predictive-search', EvaPredictiveSearch);

/*
 * iOS only raises the keyboard for focus that happens during the tap itself, but dialog.js opens
 * the panel a frame later. Focusing a stand-in field during the tap, then handing focus to the
 * search input once the panel is open, keeps the keyboard up.
 */
document.addEventListener(
  'click',
  (event) => {
    const trigger = event.target instanceof Element ? event.target.closest('[aria-controls="eva-search"]') : null;
    const panel = document.getElementById('eva-search');
    if (!trigger || !panel) return;

    const standIn = document.createElement('input');
    standIn.type = 'text';
    standIn.tabIndex = -1;
    standIn.setAttribute('aria-hidden', 'true');
    Object.assign(standIn.style, { position: 'fixed', top: '0', left: '0', opacity: '0', height: '0', fontSize: '16px' });
    document.body.append(standIn);
    standIn.focus({ preventScroll: true });

    const handOver = () => {
      const input = panel.querySelector('input[type="search"]');
      if (input instanceof HTMLInputElement) input.focus({ preventScroll: true });
      standIn.remove();
    };
    panel.addEventListener('dialog:open', handOver, { once: true });
    window.setTimeout(() => {
      panel.removeEventListener('dialog:open', handOver);
      standIn.remove();
    }, 1000);
  },
  true
);
