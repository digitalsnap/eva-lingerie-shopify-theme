import { getScrollContainer, scrollTo } from '@theme/scroll-container';

const STATE_KEY = 'eva-welcome';
const SUBMITTED_KEY = 'eva-welcome-submitted';
const DAY_MS = 24 * 60 * 60 * 1000;

/** @returns {{ state: string, at: number } | null} */
function readState() {
  try {
    return JSON.parse(window.localStorage.getItem(STATE_KEY) ?? 'null');
  } catch {
    return null;
  }
}

/** @param {'dismissed' | 'teaser-hidden' | 'unlocked'} state */
function writeState(state) {
  try {
    window.localStorage.setItem(STATE_KEY, JSON.stringify({ state, at: Date.now() }));
  } catch {
    // Storage can be blocked (private mode); the offer then simply shows again next visit.
  }
}

/**
 * <eva-welcome-offer> — the welcome discount (sections/eva-welcome-offer.liquid).
 *
 * Opens once after a delay or when the visitor reaches the footer (desktop; on phones only the
 * small tab shows unless the merchant turns auto-open on, since full-screen pop-ups on mobile can
 * hurt search rankings). "No thanks" leaves the tab; signing up or the one-tap unlock reveals the
 * code and applies it to the bag through Shopify's /discount/CODE link.
 */
class EvaWelcomeOffer extends HTMLElement {
  /** @type {number | undefined} */
  #timer;

  /** @type {IntersectionObserver | null} */
  #footerObserver = null;

  get #drawer() {
    return /** @type {HTMLElement & { showDialog?: () => void, closeDialog?: () => void } | null} */ (
      this.querySelector('dialog-component')
    );
  }

  get #code() {
    return this.dataset.code ?? '';
  }

  connectedCallback() {
    this.addEventListener('click', this.#onClick);
    this.#drawer?.addEventListener('dialog:close', this.#onClose);
    this.closest('form')?.addEventListener('submit', this.#onSubmit);
    document.addEventListener('shopify:section:select', this.#onEditorSelect);
    document.addEventListener('shopify:section:deselect', this.#onEditorDeselect);

    let submitted = false;
    try {
      submitted = window.sessionStorage.getItem(SUBMITTED_KEY) === '1';
      window.sessionStorage.removeItem(SUBMITTED_KEY);
    } catch {
      // Ignore blocked storage.
    }

    // Back from signing up (or from the newsletter section, which shares Shopify's customer form).
    if (this.hasAttribute('data-success')) {
      if (submitted) this.#returnToTop();
      this.#unlock({ open: true });
      return;
    }
    if (this.hasAttribute('data-error')) {
      if (submitted) {
        this.#returnToTop();
        this.#open();
        return;
      }
      // The error belongs to the newsletter section's form; this one wasn't sent.
      this.#clearError();
    }

    if (this.hasAttribute('data-design-mode')) {
      this.#showTeaser();
      return;
    }

    const saved = readState();
    const fresh = saved && Date.now() - saved.at < Number(this.dataset.dismissDays || 14) * DAY_MS;
    if (saved?.state === 'unlocked') return;
    if (saved?.state === 'teaser-hidden' && fresh) return;

    this.#showTeaser();
    if (saved?.state === 'dismissed' && fresh) return;

    const onPhone = window.matchMedia('(max-width: 749px)').matches;
    if (onPhone && !this.hasAttribute('data-auto-open-mobile')) return;
    this.#scheduleAutoOpen();
  }

  disconnectedCallback() {
    this.removeEventListener('click', this.#onClick);
    this.#drawer?.removeEventListener('dialog:close', this.#onClose);
    document.removeEventListener('shopify:section:select', this.#onEditorSelect);
    document.removeEventListener('shopify:section:deselect', this.#onEditorDeselect);
    this.#cancelAutoOpen();
  }

  #scheduleAutoOpen() {
    this.#timer = window.setTimeout(() => this.#autoOpen(), Number(this.dataset.delay || 8) * 1000);
    // Reaching the footer counts only once the visitor scrolls the page: on short pages it is in
    // view from the start. (Captured, so the desktop page wrapper's scrolling is heard too.)
    document.addEventListener('scroll', this.#watchFooter, { capture: true, passive: true });
  }

  /** @param {Event} event */
  #watchFooter = (event) => {
    // Scrolling inside the cart drawer, search results or a tile row isn't scrolling the page.
    if (event.target !== document && event.target !== getScrollContainer()) return;
    document.removeEventListener('scroll', this.#watchFooter, { capture: true });

    const footer = document.querySelector('footer');
    if (!footer || this.#footerObserver) return;

    this.#footerObserver = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) this.#autoOpen();
    });
    this.#footerObserver.observe(footer);
  };

  #cancelAutoOpen() {
    window.clearTimeout(this.#timer);
    document.removeEventListener('scroll', this.#watchFooter, { capture: true });
    this.#footerObserver?.disconnect();
    this.#footerObserver = null;
  }

  /**
   * Shopify sends a sign-up back to this page at #EvaWelcomeForm, which lands in the footer; the
   * offer opens over the top of the page instead (and the dialog restores that position on close).
   */
  #returnToTop() {
    const formId = this.closest('form')?.id;
    if (formId && window.location.hash === `#${formId}`) {
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    }

    const toTop = () => scrollTo({ top: 0, behavior: 'instant' });
    toTop();
    if (document.readyState !== 'complete') window.addEventListener('load', toTop, { once: true });
  }

  #clearError() {
    this.querySelector('.eva-welcome__error')?.remove();
    const input = this.querySelector('input[type="email"]');
    input?.removeAttribute('aria-invalid');
    input?.removeAttribute('aria-describedby');
  }

  #autoOpen() {
    // Never stack on top of the cart, search or another open dialog, and never in a background tab.
    if (document.visibilityState !== 'visible' || document.querySelector('dialog[open]')) {
      window.clearTimeout(this.#timer);
      this.#timer = window.setTimeout(() => this.#autoOpen(), 5000);
      return;
    }
    this.#open();
  }

  #open() {
    this.#cancelAutoOpen();
    customElements.whenDefined('dialog-component').then(() => this.#drawer?.showDialog?.());
  }

  #showTeaser() {
    const teaser = this.querySelector('[data-welcome-teaser]');
    if (teaser instanceof HTMLElement && this.hasAttribute('data-teaser')) teaser.hidden = false;
  }

  #hideTeaser() {
    const teaser = this.querySelector('[data-welcome-teaser]');
    if (teaser instanceof HTMLElement) teaser.hidden = true;
  }

  #onSubmit = () => {
    try {
      window.sessionStorage.setItem(SUBMITTED_KEY, '1');
    } catch {
      // Ignore blocked storage.
    }
  };

  #onClose = () => {
    if (readState()?.state === 'unlocked' || this.dataset.view === 'code') return;
    writeState('dismissed');
    this.#showTeaser();
  };

  /** @param {MouseEvent} event */
  #onClick = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    if (target.closest('[data-welcome-open]')) {
      this.#open();
    } else if (target.closest('[data-welcome-hide-teaser]')) {
      writeState('teaser-hidden');
      this.#hideTeaser();
    } else if (target.closest('[data-welcome-unlock]')) {
      this.#unlock({ open: false });
      const copy = this.querySelector('[data-welcome-copy]');
      if (copy instanceof HTMLElement) copy.focus();
    } else if (target.closest('[data-welcome-copy]')) {
      this.#copy(/** @type {HTMLElement} */ (target.closest('[data-welcome-copy]')));
    }
  };

  /** @param {{ open: boolean }} options */
  #unlock({ open }) {
    this.dataset.view = 'code';
    writeState('unlocked');
    this.#hideTeaser();
    this.#applyDiscount();
    if (open) this.#open();
  }

  /**
   * Adds the code to the bag through Shopify's discount link, which answers with the cart. The
   * link succeeds even for a code that doesn't apply (an empty bag, a minimum not met), so
   * "Applied to your bag" shows only when the cart says it applies; the cart drawer then updates.
   */
  async #applyDiscount() {
    if (!this.#code) return;

    const root = (this.dataset.root ?? '/').replace(/\/$/, '');
    const url = `${root}/discount/${encodeURIComponent(this.#code)}?redirect=${encodeURIComponent(`${root}/cart.js`)}`;
    try {
      const response = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!response.ok) return;

      const cart = await response.json();
      /** @type {{ code: string, applicable: boolean }[]} */
      const codes = cart.discount_codes ?? [];
      const entry = codes.find((item) => item.code.toLowerCase() === this.#code.toLowerCase());
      if (!entry?.applicable) return;

      const applied = this.querySelector('[data-welcome-applied]');
      if (applied instanceof HTMLElement) applied.hidden = false;
      this.#announce(applied?.textContent?.trim() ?? '');

      const { CartDiscountUpdateEvent } = await import('@shopify/events');
      const deferred = CartDiscountUpdateEvent.createPromise();
      this.dispatchEvent(
        new CartDiscountUpdateEvent({ discountCodes: codes.map(({ code }) => ({ code })), promise: deferred.promise })
      );
      deferred.resolve({ cart: CartDiscountUpdateEvent.createCartFromAjaxResponse(cart) });
    } catch {
      // The code is still shown; it can be entered at checkout.
    }
  }

  /** @param {HTMLElement} button */
  async #copy(button) {
    try {
      await navigator.clipboard.writeText(this.#code);
      const label = button.dataset.labelCopied;
      if (label) {
        button.textContent = label;
        this.#announce(label);
      }
    } catch {
      // Clipboard can be unavailable; the code stays visible to copy by hand.
    }
  }

  /** @param {string} message */
  #announce(message) {
    const status = this.querySelector('[data-welcome-status]');
    if (status && message) status.textContent = message;
  }

  /** Theme editor: selecting the section opens the offer so it can be edited. */
  #onEditorSelect = (/** @type {Event} */ event) => {
    if (event.target instanceof Node && event.target.contains(this)) this.#open();
  };

  #onEditorDeselect = (/** @type {Event} */ event) => {
    if (event.target instanceof Node && event.target.contains(this)) this.#drawer?.closeDialog?.();
  };
}

if (!customElements.get('eva-welcome-offer')) customElements.define('eva-welcome-offer', EvaWelcomeOffer);
