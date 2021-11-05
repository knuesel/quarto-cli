window.QuartoLeafletCompat = function () {
  return {
    id: "quarto-leaflet-compat",
    init: function (deck) {
      if (window.L) {
        L.Map.addInitHook(function () {
          const slides = deck.getSlidesElement();
          const scale = deck.getScale();

          const container = this.getContainer();

          // Cancel revealjs scaling on map container by doing the opposite of what it set
          if (slides.style.zoom) {
            container.style.zoom = 1 / scale;
          } else if (slides.style.transform) {
            // reveal.js use transform: scale(..)
            container.style.transform = "scale(" + 1 / scale + ")";
          }
          // Update the map on container size changed
          this.invalidateSize();
        });
      }
    },
  };
};
