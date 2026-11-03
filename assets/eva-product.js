/**
 * Decodes HTML entities in server-formatted money strings (e.g. "&euro;45,00") without
 * executing anything: a <textarea>'s content is never parsed as markup.
 * @param {string} value
 */
function decodeEntities(value) {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = value;
  return textarea.value;
}

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * <eva-gallery> — a scroll-snap track of product media. Swipe on touch, thumbnails on desktop.
 * Keeps the thumbnail state and the mobile "1 / 4" counter in sync with the visible slide.
 */
class EvaGallery extends HTMLElement {
  /** @type {HTMLElement | null} */
  #track = null;

  /** @type {HTMLElement[]} */
  #slides = [];

  /** @type {HTMLElement[]} */
  #thumbs = [];

  /** @type {IntersectionObserver | null} */
  #observer = null;

  connectedCallback() {
    this.#track = this.querySelector('.eva-gallery__track');
    this.#slides = [...this.querySelectorAll('.eva-gallery__slide')];
    this.#thumbs = [...this.querySelectorAll('.eva-gallery__thumb')];
    if (!this.#track || this.#slides.length < 2) return;

    this.addEventListener('click', this.#onThumbClick);
    this.#observer = new IntersectionObserver(this.#onIntersect, { root: this.#track, threshold: 0.6 });
    for (const slide of this.#slides) this.#observer.observe(slide);
  }

  disconnectedCallback() {
    this.#observer?.disconnect();
    this.removeEventListener('click', this.#onThumbClick);
  }

  /**
   * Scrolls the track to the slide for a media id.
   * @param {string | number} mediaId
   * @param {ScrollBehavior} [behavior]
   */
  show(mediaId, behavior = 'smooth') {
    const slide = this.#slides.find((item) => item.dataset.mediaId === String(mediaId));
    if (!slide || !this.#track) return;

    this.#track.scrollTo({
      left: slide.offsetLeft,
      behavior: prefersReducedMotion() ? 'instant' : behavior,
    });
  }

  /** @param {MouseEvent} event */
  #onThumbClick = (event) => {
    const thumb = event.target instanceof Element ? event.target.closest('.eva-gallery__thumb') : null;
    if (thumb instanceof HTMLElement && thumb.dataset.mediaId) this.show(thumb.dataset.mediaId);
  };

  /** @param {IntersectionObserverEntry[]} entries */
  #onIntersect = (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting || !(entry.target instanceof HTMLElement)) continue;

      const mediaId = entry.target.dataset.mediaId;
      for (const thumb of this.#thumbs) {
        if (thumb.dataset.mediaId === mediaId) {
          thumb.setAttribute('aria-current', 'true');
        } else {
          thumb.removeAttribute('aria-current');
        }
      }

      const counter = this.querySelector('[data-gallery-current]');
      if (counter) counter.textContent = String(this.#slides.indexOf(entry.target) + 1);
    }
  };
}

/**
 * @typedef {object} Variant
 * @property {number} id
 * @property {(string | null)[]} options
 * @property {boolean} available
 * @property {string} price
 * @property {string | null} compare
 * @property {number | null} media
 */

const MESSAGE_DURATION = 3000;

/**
 * <eva-product-form> — option picker and add-to-bag for the product page.
 * Option changes resolve a variant from inline JSON (no network). Liquid lists at most 250
 * variants, so larger products ask the server for the rest. Adding to the bag posts to
 * /cart/add.js and announces it with Shopify's standard CartLinesUpdateEvent, which Horizon's
 * cart drawer and bag count already listen for.
 */
class EvaProductForm extends HTMLElement {
  /** @type {Variant[]} */
  #variants = [];

  #requestId = 0;

  /** @type {number | undefined} */
  #messageTimer;

  connectedCallback() {
    const data = this.querySelector('script[data-eva-variants]');
    try {
      this.#variants = data?.textContent ? JSON.parse(data.textContent) : [];
    } catch {
      this.#variants = [];
    }

    this.addEventListener('change', this.#onChange);
    this.querySelector('form')?.addEventListener('submit', this.#onSubmit);

    // Options picked before this script ran (or restored by the back button) win over the
    // variant the server rendered.
    const idInput = this.querySelector('[data-variant-input]');
    if (this.#fieldsets.length && idInput instanceof HTMLInputElement) {
      const variant = this.#findVariant(this.#selectedOptions);
      if (!variant || String(variant.id) !== idInput.value) this.#resolve();
    }
  }

  disconnectedCallback() {
    this.removeEventListener('change', this.#onChange);
    this.querySelector('form')?.removeEventListener('submit', this.#onSubmit);
    window.clearTimeout(this.#messageTimer);
  }

  /** @returns {HTMLFieldSetElement[]} */
  get #fieldsets() {
    return [...this.querySelectorAll('fieldset[data-option-index]')].filter(
      (element) => element instanceof HTMLFieldSetElement
    );
  }

  /** @returns {(string | null)[]} */
  get #selectedOptions() {
    return this.#fieldsets.map((fieldset) => {
      const checked = fieldset.querySelector('input:checked');
      return checked instanceof HTMLInputElement ? checked.value : null;
    });
  }

  /** The inline JSON holds every variant (Liquid caps product.variants at 250). */
  get #hasAllVariants() {
    return this.#variants.length >= Number(this.dataset.variantsCount || 0);
  }

  /** @param {(string | null)[]} selected */
  #findVariant(selected) {
    return this.#variants.find((item) => item.options.every((value, index) => value === selected[index]));
  }

  /** @param {Event} event */
  #onChange = (event) => {
    if (!(event.target instanceof HTMLInputElement) || !event.target.closest('fieldset[data-option-index]')) return;
    this.#resolve();
  };

  async #resolve() {
    const selected = this.#selectedOptions;
    let variant = this.#findVariant(selected);

    if (!variant && !this.#hasAllVariants) {
      const requestId = ++this.#requestId;
      variant = await this.#fetchVariant(selected).catch(() => undefined);
      if (requestId !== this.#requestId) return;
    }

    this.#render(selected, variant);
  }

  /**
   * Asks Shopify to render this section for the chosen option values and reads the variant back.
   * @param {(string | null)[]} selected
   * @returns {Promise<Variant | undefined>}
   */
  async #fetchVariant(selected) {
    const valueIds = this.#fieldsets.map((fieldset) => {
      const checked = fieldset.querySelector('input:checked');
      return checked instanceof HTMLInputElement ? checked.dataset.valueId : undefined;
    });
    if (valueIds.some((id) => !id) || !this.dataset.productUrl || !this.dataset.sectionId) return undefined;

    const url = new URL(this.dataset.productUrl, window.location.origin);
    url.searchParams.set('option_values', valueIds.join(','));
    url.searchParams.set('section_id', this.dataset.sectionId);

    const response = await fetch(url);
    if (!response.ok) return undefined;

    const html = new DOMParser().parseFromString(await response.text(), 'text/html');
    const form = html.querySelector('eva-product-form');
    if (!(form instanceof HTMLElement)) return undefined;

    // Shopify falls back to another variant when the combination doesn't exist; only accept an exact match.
    const rendered = [...form.querySelectorAll('fieldset[data-option-index] input:checked')].map((input) =>
      input instanceof HTMLInputElement ? input.value : null
    );
    if (rendered.length !== selected.length || rendered.some((value, index) => value !== selected[index])) {
      return undefined;
    }

    const idInput = form.querySelector('[data-variant-input]');
    const button = form.querySelector('[data-add-button]');
    const compareWrap = form.querySelector('[data-compare]');
    if (!(idInput instanceof HTMLInputElement)) return undefined;

    return {
      id: Number(idInput.value),
      options: selected,
      available: button instanceof HTMLButtonElement && !button.disabled,
      price: form.querySelector('[data-price-current]')?.textContent?.trim() ?? '',
      compare:
        compareWrap instanceof HTMLElement && !compareWrap.hidden
          ? form.querySelector('[data-price-compare]')?.textContent?.trim() ?? null
          : null,
      media: Number(form.dataset.selectedMedia) || null,
    };
  }

  /**
   * @param {(string | null)[]} selected
   * @param {Variant | undefined} variant
   */
  #render(selected, variant) {
    this.#fieldsets.forEach((fieldset, index) => {
      const label = fieldset.querySelector('[data-selected-value]');
      if (label) label.textContent = selected[index] ?? '';

      // Availability needs the full variant list; with more than 250 variants the server-rendered marks stay.
      if (!this.#hasAllVariants) return;

      // A value is available when some in-stock variant has it together with the other current choices.
      for (const input of fieldset.querySelectorAll('input')) {
        const available = this.#variants.some(
          (item) =>
            item.available &&
            item.options[index] === input.value &&
            item.options.every((value, other) => other === index || value === selected[other])
        );
        const valueLabel = input.closest('label');
        valueLabel?.classList.toggle('is-unavailable', !available);
        const status = valueLabel?.querySelector('[data-value-status]');
        if (status) status.textContent = available ? '' : `, ${this.dataset.labelValueSoldOut ?? ''}`;
      }
    });

    const button = this.querySelector('[data-add-button]');
    const buttonLabel = this.querySelector('[data-add-label]');
    const idInput = this.querySelector('[data-variant-input]');

    if (!variant) {
      if (button instanceof HTMLButtonElement) button.disabled = true;
      if (buttonLabel) buttonLabel.textContent = this.dataset.labelUnavailable ?? '';
      return;
    }

    if (idInput instanceof HTMLInputElement && idInput.value !== String(variant.id)) {
      idInput.value = String(variant.id);
      // Shopify's accelerated checkout buttons and apps watch the variant input for changes.
      idInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (button instanceof HTMLButtonElement) button.disabled = !variant.available;
    if (buttonLabel) {
      buttonLabel.textContent = (variant.available ? this.dataset.labelAdd : this.dataset.labelSoldOut) ?? '';
    }

    const current = this.querySelector('[data-price-current]');
    const compare = this.querySelector('[data-price-compare]');
    const compareWrap = this.querySelector('[data-compare]');
    const saleLabel = this.querySelector('[data-sale-label]');
    if (current) current.textContent = decodeEntities(variant.price);
    if (compare) compare.textContent = variant.compare ? decodeEntities(variant.compare) : '';
    if (compareWrap instanceof HTMLElement) compareWrap.hidden = !variant.compare;
    if (saleLabel instanceof HTMLElement) saleLabel.hidden = !variant.compare;

    const url = new URL(window.location.href);
    url.searchParams.set('variant', String(variant.id));
    window.history.replaceState(window.history.state, '', url);

    if (variant.media && this.dataset.gallery) {
      const gallery = document.getElementById(this.dataset.gallery);
      if (gallery instanceof EvaGallery) gallery.show(variant.media);
    }
  }

  /** @param {SubmitEvent} event */
  #onSubmit = async (event) => {
    const form = event.currentTarget;
    const button = this.querySelector('[data-add-button]');
    if (!(form instanceof HTMLFormElement) || !(button instanceof HTMLButtonElement)) return;

    event.preventDefault();
    if (button.disabled || button.getAttribute('aria-busy') === 'true') return;

    // Loaded on demand so option picking never waits on the CDN. If it can't load, fall back to
    // the regular form post, which still carries the right variant.
    let events;
    try {
      events = await import('@shopify/events');
    } catch {
      HTMLFormElement.prototype.submit.call(form);
      return;
    }
    const { CartLinesUpdateEvent, CartErrorEvent } = events;

    const formData = new FormData(form);
    const quantity = Number(formData.get('quantity')) || 1;
    const sectionIds = [...document.querySelectorAll('eva-cart[data-section-id]')]
      .map((element) => (element instanceof HTMLElement ? element.dataset.sectionId : undefined))
      .filter(Boolean);
    if (sectionIds.length) formData.append('sections', sectionIds.join(','));

    const deferred = CartLinesUpdateEvent.createPromise();
    this.dispatchEvent(
      new CartLinesUpdateEvent({
        action: 'add',
        context: 'product',
        lines: [{ merchandiseId: String(formData.get('id')), quantity }],
        promise: deferred.promise,
      })
    );

    button.setAttribute('aria-busy', 'true');
    this.#setError('');

    try {
      const response = await fetch(Theme.routes.cart_add_url, {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'text/html' },
        body: formData,
      });
      const result = await response.json();
      const cart = await fetch(`${Theme.routes.cart_url}.js`, { headers: { Accept: 'application/json' } }).then(
        (cartResponse) => cartResponse.json()
      );
      const didError = Boolean(result.status);

      deferred.resolve({
        cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart),
        detail: {
          items: cart.items,
          sections: result.sections,
          didError,
          source: 'eva-product-form',
          itemCount: quantity,
          productId: this.dataset.productId,
        },
      });

      if (didError) {
        this.dispatchEvent(
          new CartErrorEvent({
            error: result.message || 'Add to cart failed',
            code: 'INVALID',
            detail: { description: result.description, errors: result.errors },
          })
        );
        this.#setError(result.description || result.message || this.dataset.labelError || '');
        return;
      }

      // Without a cart drawer (cart type set to "page"), go to the cart like the no-JavaScript form does.
      if (!document.getElementById('eva-cart-drawer')) {
        window.location.href = Theme.routes.cart_url;
        return;
      }
      this.#confirmAdded();
    } catch (error) {
      deferred.reject(error);
      this.#setError(this.dataset.labelError ?? '');
    } finally {
      button.removeAttribute('aria-busy');
    }
  };

  /** Shows "Added" on the button and announces it, then restores both so a repeat add is announced again. */
  #confirmAdded() {
    const buttonLabel = this.querySelector('[data-add-label]');
    const status = this.querySelector('[data-status]');
    if (buttonLabel) buttonLabel.textContent = this.dataset.labelAddedShort ?? '';
    if (status) status.textContent = this.dataset.labelAdded ?? '';

    window.clearTimeout(this.#messageTimer);
    this.#messageTimer = window.setTimeout(() => {
      if (status) status.textContent = '';
      const button = this.querySelector('[data-add-button]');
      if (buttonLabel && button instanceof HTMLButtonElement) {
        buttonLabel.textContent = (button.disabled ? this.dataset.labelSoldOut : this.dataset.labelAdd) ?? '';
      }
    }, MESSAGE_DURATION);
  }

  /** @param {string} text */
  #setError(text) {
    const element = this.querySelector('[data-error]');
    if (!(element instanceof HTMLElement)) return;
    element.textContent = text;
    element.hidden = !text;
  }
}

/**
 * <eva-recommendations> — fills "Complete the set" from Shopify's product recommendations when the
 * product has no hand-picked list. Fetches only when the section is about to scroll into view.
 */
class EvaRecommendations extends HTMLElement {
  /** @type {IntersectionObserver | null} */
  #observer = null;

  connectedCallback() {
    if (!this.dataset.url) return;

    this.#observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        this.#observer?.disconnect();
        this.#load();
      },
      { rootMargin: '400px 0px' }
    );
    this.#observer.observe(this);
  }

  disconnectedCallback() {
    this.#observer?.disconnect();
  }

  async #load() {
    try {
      const response = await fetch(this.dataset.url ?? '');
      if (!response.ok) return;

      const html = new DOMParser().parseFromString(await response.text(), 'text/html');
      const fresh = html.querySelector(`eva-recommendations[data-section="${this.dataset.section}"]`);
      if (!fresh?.querySelector('li')) return;

      this.replaceChildren(...fresh.childNodes);
      this.hidden = false;
    } catch {
      // Recommendations are optional; the section simply stays hidden.
    }
  }
}

if (!customElements.get('eva-gallery')) customElements.define('eva-gallery', EvaGallery);
if (!customElements.get('eva-product-form')) customElements.define('eva-product-form', EvaProductForm);
if (!customElements.get('eva-recommendations')) customElements.define('eva-recommendations', EvaRecommendations);
