const UPDATE_DELAY = 350;
const NOTE_DELAY = 600;
const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

/**
 * <eva-cart> — quantity, remove, discount-code and note updates on the cart page without a reload.
 * Each change posts to Shopify's cart API with this section's id, swaps in the re-rendered
 * section, and announces it with Shopify's standard cart events so the header bag count follows.
 * Without the script the page still works: the form posts `updates[]`, remove links go to
 * /cart/change, and checkout submits normally.
 */
class EvaCart extends HTMLElement {
  /** Requests run one at a time so each sees the cart the previous one left. */
  #queue = Promise.resolve();

  /** @type {Map<string, number>} */
  #timers = new Map();

  /** @type {string | null} */
  #linesUpdateEvent = null;

  connectedCallback() {
    this.addEventListener('click', this.#onClick);
    this.addEventListener('change', this.#onChange);
    this.addEventListener('input', this.#onInput);
    this.addEventListener('submit', this.#onSubmit);

    // The cart drawer follows changes made elsewhere: add to bag, other tabs (back/forward cache), apps.
    if (this.hasAttribute('data-listen-updates')) {
      import('@shopify/events')
        .then(({ StandardEvents }) => {
          if (!this.isConnected) return;
          this.#linesUpdateEvent = StandardEvents.cartLinesUpdate;
          document.addEventListener(this.#linesUpdateEvent, this.#onExternalUpdate);
        })
        .catch(() => {});
      window.addEventListener('pageshow', this.#onPageShow);
    }
  }

  disconnectedCallback() {
    this.removeEventListener('click', this.#onClick);
    this.removeEventListener('change', this.#onChange);
    this.removeEventListener('input', this.#onInput);
    this.removeEventListener('submit', this.#onSubmit);
    if (this.#linesUpdateEvent) document.removeEventListener(this.#linesUpdateEvent, this.#onExternalUpdate);
    window.removeEventListener('pageshow', this.#onPageShow);
    for (const timer of this.#timers.values()) window.clearTimeout(timer);
  }

  /**
   * Re-renders from the section HTML the change already carried (add to bag requests it), else
   * from the server, then opens the drawer after an add.
   * @param {Event & { action?: string, promise?: Promise<any> }} event
   */
  #onExternalUpdate = (event) => {
    if (event.target instanceof Node && this.contains(event.target)) return;

    const action = event.action;
    Promise.resolve(event.promise)
      .then((result) => {
        if (result?.detail?.didError) return;
        this.#enqueue(async () => {
          const html = result?.detail?.sections?.[this.#sectionId];
          if (html) {
            this.#render(html, undefined, false);
          } else {
            await this.#refresh(undefined, false);
          }
          if (action === 'add' && this.hasAttribute('data-auto-open')) this.#openDrawer();
        });
      })
      .catch(() => {});
  };

  /** @param {PageTransitionEvent} event */
  #onPageShow = (event) => {
    if (event.persisted) this.#enqueue(() => this.#refresh(undefined, false));
  };

  #openDrawer() {
    const drawer = this.closest('dialog-component');
    if (!drawer) return;
    customElements.whenDefined('dialog-component').then(() => {
      if ('showDialog' in drawer && typeof drawer.showDialog === 'function') drawer.showDialog();
    });
  }

  get #sectionId() {
    return this.dataset.sectionId ?? '';
  }

  /** @param {MouseEvent} event */
  #onClick = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const stepButton = target.closest('button[data-step]');
    if (stepButton instanceof HTMLButtonElement) {
      const input = stepButton.parentElement?.querySelector('input[data-quantity]');
      if (!(input instanceof HTMLInputElement)) return;

      const step = Number(input.step) || 1;
      const min = Number(input.dataset.min) || 1;
      const max = input.max ? Number(input.max) : Infinity;
      const next = Number(input.value) + Number(stepButton.dataset.step) * step;
      input.value = String(Math.min(max, Math.max(min, next)));
      this.#schedule(input, stepButton.dataset.focusKey);
      return;
    }

    const removeLink = target.closest('a[data-remove]');
    if (removeLink instanceof HTMLAnchorElement) {
      event.preventDefault();
      const key = removeLink.dataset.key ?? '';
      window.clearTimeout(this.#timers.get(key));
      this.#enqueue(() => this.#changeLine(key, 0, undefined));
      return;
    }

    const removeCode = target.closest('button[data-remove-code]');
    if (removeCode instanceof HTMLButtonElement) {
      const code = (removeCode.dataset.removeCode ?? '').toLowerCase();
      this.#enqueue(async () => {
        const codes = await this.#appliedCodes();
        await this.#updateDiscounts(
          codes.filter((item) => item.toLowerCase() !== code),
          null
        );
      });
    }
  };

  /** @param {Event} event */
  #onChange = (event) => {
    if (event.target instanceof HTMLInputElement && event.target.matches('input[data-quantity]')) {
      this.#schedule(event.target, event.target.dataset.focusKey);
    }
  };

  /** Saves the order note as it's typed, so accelerated checkout and other tabs see it too. */
  #onInput = (/** @type {Event} */ event) => {
    const note = event.target;
    if (!(note instanceof HTMLTextAreaElement) || note.name !== 'note') return;

    window.clearTimeout(this.#timers.get('note'));
    this.#timers.set(
      'note',
      window.setTimeout(() => {
        this.#timers.delete('note');
        const value = note.value;
        this.#enqueue(() => this.#post(Theme.routes.cart_update_url, { note: value }).then(() => undefined));
      }, NOTE_DELAY)
    );
  };

  /** @param {SubmitEvent} event */
  #onSubmit = (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('[data-discount-form]')) return;

    event.preventDefault();
    const input = form.elements.namedItem('discount');
    const code = input instanceof HTMLInputElement ? input.value.trim() : '';
    if (!code) return;

    this.#enqueue(async () => {
      const codes = await this.#appliedCodes();
      if (codes.some((item) => item.toLowerCase() === code.toLowerCase())) return;
      await this.#updateDiscounts([...codes, code], code);
    });
  };

  /**
   * The codes on the cart right now. Read from the cart API rather than the page, because Liquid
   * leaves out shipping discounts and /cart/update replaces the whole list.
   * @returns {Promise<string[]>}
   */
  async #appliedCodes() {
    try {
      const cart = await fetch(`${Theme.routes.cart_url}.js`, { headers: { Accept: 'application/json' } }).then(
        (response) => response.json()
      );
      /** @type {{ code: string, applicable: boolean }[]} */
      const codes = cart.discount_codes ?? [];
      return codes.filter((item) => item.applicable).map((item) => item.code);
    } catch {
      const form = this.querySelector('[data-discount-form]');
      const value = form instanceof HTMLElement ? form.dataset.codes ?? '' : '';
      return value.split(',').filter(Boolean);
    }
  }

  /**
   * Waits for typing or repeated taps to settle before sending one update per line.
   * @param {HTMLInputElement} input
   * @param {string | undefined} focusKey
   */
  #schedule(input, focusKey) {
    const key = input.dataset.key ?? '';
    window.clearTimeout(this.#timers.get(key));
    this.#timers.set(
      key,
      window.setTimeout(() => {
        this.#timers.delete(key);
        this.#enqueue(() => this.#changeLine(key, Number(input.value), focusKey));
      }, UPDATE_DELAY)
    );
  }

  /** @param {() => Promise<void>} task */
  #enqueue(task) {
    this.#queue = this.#queue.then(task).catch((error) => console.error('[eva-cart]', error));
  }

  /**
   * @param {string} url
   * @param {Record<string, unknown>} body
   */
  async #post(url, body) {
    const response = await fetch(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
    return { ok: response.ok, data: await response.json() };
  }

  /**
   * Changes one line, addressed by its item key (line positions shift after a removal).
   * @param {string} key
   * @param {number} quantity
   * @param {string | undefined} focusKey
   */
  async #changeLine(key, quantity, focusKey) {
    if (!key || Number.isNaN(quantity) || quantity < 0) return;

    const { CartLinesUpdateEvent } = await import('@shopify/events');
    const deferred = CartLinesUpdateEvent.createPromise();
    this.dispatchEvent(
      new CartLinesUpdateEvent({
        action: quantity > 0 ? 'update' : 'remove',
        context: 'cart',
        lines: [{ id: key, quantity }],
        promise: deferred.promise,
      })
    );

    this.setAttribute('aria-busy', 'true');
    const errorSelector = `[data-line-error="${CSS.escape(key)}"]`;
    try {
      const { ok, data } = await this.#post(Theme.routes.cart_change_url, {
        id: key,
        quantity,
        sections: this.#sectionId,
        sections_url: window.location.pathname,
      });

      if (!ok || data.errors || data.status) {
        deferred.reject(new Error(data.description || data.message || 'Cart update failed'));
        // Put the real quantities back, then explain why the change didn't go through.
        await this.#refresh(focusKey);
        this.#showError(errorSelector, data.description || data.message || this.dataset.labelError);
        return;
      }

      deferred.resolve({
        cart: CartLinesUpdateEvent.createCartFromAjaxResponse(data),
        detail: {
          items: data.items,
          itemCount: data.item_count,
          sections: data.sections,
          source: 'eva-cart',
          didError: false,
        },
      });
      this.#render(data.sections?.[this.#sectionId], focusKey);

      // Shopify caps a line at the stock it has instead of refusing the change.
      /** @type {{ key: string, quantity: number }[]} */
      const items = data.items ?? [];
      const saved = items.find((item) => item.key === key);
      if (saved && quantity > saved.quantity) {
        this.#showError(errorSelector, (this.dataset.labelQuantityCapped ?? '').replace('[quantity]', String(saved.quantity)));
      } else {
        this.#announce(this.dataset.labelUpdated);
      }
    } catch (error) {
      deferred.reject(error);
      this.#showError(errorSelector, this.dataset.labelError);
    } finally {
      this.removeAttribute('aria-busy');
    }
  }

  /**
   * Replaces the cart's discount codes (Shopify takes the full list each time).
   * @param {string[]} codes
   * @param {string | null} newCode - The code just entered, to report if it can't be shown or applied.
   */
  async #updateDiscounts(codes, newCode) {
    const { CartDiscountUpdateEvent } = await import('@shopify/events');
    const deferred = CartDiscountUpdateEvent.createPromise();
    this.dispatchEvent(
      new CartDiscountUpdateEvent({
        discountCodes: codes.map((code) => ({ code })),
        promise: deferred.promise,
      })
    );

    this.setAttribute('aria-busy', 'true');
    try {
      const { ok, data } = await this.#post(Theme.routes.cart_update_url, {
        discount: codes.join(','),
        sections: this.#sectionId,
      });
      if (!ok || data.status) throw new Error(data.description || data.message || 'Discount update failed');

      deferred.resolve({ cart: CartDiscountUpdateEvent.createCartFromAjaxResponse(data) });
      this.#render(data.sections?.[this.#sectionId], 'discount-input');
      if (!newCode) {
        this.#announce(this.dataset.labelUpdated);
        return;
      }

      /** @type {{ code: string, applicable: boolean }[]} */
      const applied = data.discount_codes ?? [];
      const entry = applied.find((item) => item.code.toLowerCase() === newCode.toLowerCase());
      const shownAsChip = [...this.querySelectorAll('button[data-remove-code]')].some(
        (chip) => chip instanceof HTMLElement && chip.dataset.removeCode?.toLowerCase() === newCode.toLowerCase()
      );

      if (!entry?.applicable) {
        this.#showError('[data-discount-error]', this.dataset.labelDiscountError);
      } else if (!shownAsChip) {
        // Applied, but Liquid has no allocation to show yet: shipping discounts appear at checkout.
        this.#showError('[data-discount-error]', this.dataset.labelShippingDiscount);
      } else {
        this.#announce(this.dataset.labelUpdated);
      }
    } catch (error) {
      deferred.reject(error);
      this.#showError('[data-discount-error]', this.dataset.labelError);
    } finally {
      this.removeAttribute('aria-busy');
    }
  }

  /**
   * Re-renders the section from the server, e.g. after a refused update.
   * @param {string | undefined} focusKey
   * @param {boolean} [moveFocus]
   */
  async #refresh(focusKey, moveFocus = true) {
    const url = new URL(window.location.href);
    url.searchParams.set('section_id', this.#sectionId);
    const response = await fetch(url);
    if (response.ok) this.#render(await response.text(), focusKey, moveFocus);
  }

  /**
   * Swaps in a freshly rendered section. Keeps what the shopper is typing (note, discount code),
   * keeps the accelerated checkout buttons Shopify already rendered, and puts focus back.
   * @param {string | undefined} html
   * @param {string | undefined} focusKey
   * @param {boolean} [moveFocus] - False for background refreshes, which must not take focus.
   */
  #render(html, focusKey, moveFocus = true) {
    if (!html) return;

    const fresh = new DOMParser().parseFromString(html, 'text/html').querySelector('eva-cart');
    if (!fresh) return;

    const active = document.activeElement;
    const hadFocusInside = active instanceof Node && this.contains(active);
    const activeKey = hadFocusInside && active instanceof HTMLElement ? active.dataset.focusKey : undefined;
    const note = this.querySelector('textarea[name="note"]');
    const discount = this.querySelector('input[name="discount"]');
    const accelerated = this.querySelector('.eva-cart__accelerated');

    this.replaceChildren(...fresh.childNodes);

    const newNote = this.querySelector('textarea[name="note"]');
    if (note instanceof HTMLTextAreaElement && newNote instanceof HTMLTextAreaElement) newNote.value = note.value;
    const newDiscount = this.querySelector('input[name="discount"]');
    if (discount instanceof HTMLInputElement && newDiscount instanceof HTMLInputElement && focusKey !== 'discount-input') {
      newDiscount.value = discount.value;
    }
    const slot = this.querySelector('.eva-cart__accelerated');
    if (accelerated && slot) slot.replaceWith(accelerated);

    // Background refreshes leave focus alone, unless it was inside what just got replaced
    // (e.g. the drawer is open when the page returns from the back/forward cache).
    if (!moveFocus && !hadFocusInside) return;

    // Focus whatever the shopper is in now (e.g. still typing the note), else the control they used.
    const key = activeKey && activeKey !== focusKey ? activeKey : focusKey;
    const target = key ? this.querySelector(`[data-focus-key="${CSS.escape(key)}"]`) : null;
    const focusable = target instanceof HTMLElement && !(target instanceof HTMLButtonElement && target.disabled) ? target : null;
    const fallback = this.querySelector('[data-cart-heading]');
    (focusable ?? (fallback instanceof HTMLElement ? fallback : null))?.focus({ preventScroll: true });

    // Keep the caret where it was in a field the shopper was typing in.
    if (key === activeKey && (focusable instanceof HTMLTextAreaElement || focusable instanceof HTMLInputElement)) {
      if (active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && active.type === 'text')) {
        focusable.setSelectionRange(active.selectionStart, active.selectionEnd);
      }
    }
  }

  /**
   * @param {string} selector
   * @param {string | undefined} message
   */
  #showError(selector, message) {
    const element = this.querySelector(selector);
    if (!(element instanceof HTMLElement) || !message) return;
    element.textContent = message;
    element.hidden = false;
  }

  /** @param {string | undefined} message */
  #announce(message) {
    const status = this.parentElement?.querySelector('[data-cart-status]');
    if (!status || !message) return;
    status.textContent = '';
    window.setTimeout(() => (status.textContent = message), 50);
  }
}

if (!customElements.get('eva-cart')) customElements.define('eva-cart', EvaCart);
