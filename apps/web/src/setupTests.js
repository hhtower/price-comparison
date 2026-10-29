import '@testing-library/jest-dom/vitest';
import { beforeEach } from 'vitest';

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.setItem('catalog-browsing-mode', 'browse');
});

// jsdom has no element layout; VirtuosoMockContext supplies list measurements.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// jsdom has no browser top layer; real modal focus/stacking is checked in the browser.
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
