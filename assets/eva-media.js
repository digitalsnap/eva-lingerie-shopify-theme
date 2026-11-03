/**
 * <eva-video> plays a muted background video only while it is on screen and only when the visitor
 * has not asked for reduced motion. It reveals a play/pause button so the motion can always be
 * stopped (WCAG 2.2.2). The video uses preload="none", so nothing downloads until it plays.
 */
class EvaVideo extends HTMLElement {
  /** @type {HTMLVideoElement | null} */
  #video = null;

  /** @type {HTMLButtonElement | null} */
  #button = null;

  /** @type {IntersectionObserver | null} */
  #observer = null;

  #pausedByVisitor = false;

  connectedCallback() {
    this.#video = this.querySelector('video');
    this.#button = this.querySelector('button');
    if (!this.#video) return;

    this.#button?.addEventListener('click', this.#toggle);
    if (this.#button) this.#button.hidden = false;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.#pausedByVisitor = true;
      this.#sync();
      return;
    }

    this.#observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && !this.#pausedByVisitor) {
        this.#play();
      } else {
        this.#video?.pause();
        this.#sync();
      }
    });
    this.#observer.observe(this);
  }

  disconnectedCallback() {
    this.#observer?.disconnect();
    this.#button?.removeEventListener('click', this.#toggle);
  }

  #play() {
    this.#video
      ?.play()
      .catch(() => {})
      .finally(() => this.#sync());
  }

  #toggle = () => {
    if (!this.#video) return;

    if (this.#video.paused) {
      this.#pausedByVisitor = false;
      this.#play();
    } else {
      this.#pausedByVisitor = true;
      this.#video.pause();
      this.#sync();
    }
  };

  #sync() {
    const playing = Boolean(this.#video && !this.#video.paused);
    this.toggleAttribute('playing', playing);

    if (this.#button) {
      const label = playing ? this.#button.dataset.labelPause : this.#button.dataset.labelPlay;
      if (label) this.#button.setAttribute('aria-label', label);
    }
  }
}

if (!customElements.get('eva-video')) customElements.define('eva-video', EvaVideo);
