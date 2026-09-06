/* Keep all page-section ownership in one registry instead of letting features chase DOM anchors. */
(() => {
  /* Hold definitions in insertion order so the current visual order remains stable. */
  const panels = new Map();

  /* Reject duplicate ids early because two features owning one section is a rendering bug. */
  const register = definition => {
    /* Require the minimum information needed to identify and classify a panel. */
    if (!definition || !definition.id || !definition.tier || !definition.selector || typeof definition.defaultOpen !== 'boolean') {
      /* Make an invalid registration actionable during local development. */
      throw new Error('A panel requires id, tier, selector, and defaultOpen.');
    }

    /* Prevent silent overwrites that used to happen with late IIFE patches. */
    if (panels.has(definition.id)) {
      /* Keep the original owner authoritative. */
      throw new Error(`Duplicate panel id: ${definition.id}`);
    }

    /* Store an immutable shallow copy so later feature mutations cannot change layout ownership. */
    panels.set(definition.id, Object.freeze({ ...definition }));
  };

  /* Resolve current DOM nodes without moving them, preserving the existing visible page exactly. */
  const snapshot = () => [...panels.values()].map(panel => ({
    /* Return the stable public id. */
    id: panel.id,
    /* Return the information-architecture tier. */
    tier: panel.tier,
    /* Return whether the registered node exists after page boot. */
    mounted: Boolean(document.querySelector(panel.selector)),
    /* Return the default expansion policy used when this feature is migrated. */
    defaultOpen: panel.defaultOpen,
  }));

  /* Expose the tiny API to classic scripts during the incremental migration. */
  window.BTCPanels = Object.freeze({ register, snapshot });
})();
