import type { PanDirection } from './SearchPanel';

export interface MapControlsProps {
  onPan: (direction: PanDirection) => void;
  onZoom: (delta: number) => void;
  zoomOffset: number;
}

export function MapControls({ onPan, onZoom, zoomOffset }: MapControlsProps) {
  return (
    <div className="map-controls" role="group" aria-label="Pan and zoom the map">
      <button className="button button--icon" type="button" data-testid="map-pan-north" onClick={() => onPan('north')}>
        N
      </button>
      <button className="button button--icon" type="button" data-testid="map-pan-west" onClick={() => onPan('west')}>
        W
      </button>
      <button className="button button--icon" type="button" data-testid="map-pan-east" onClick={() => onPan('east')}>
        E
      </button>
      <button className="button button--icon" type="button" data-testid="map-pan-south" onClick={() => onPan('south')}>
        S
      </button>
      <button
        className="button button--icon"
        type="button"
        data-testid="map-zoom-in"
        onClick={() => onZoom(1)}
        disabled={zoomOffset >= 3}
      >
        +
      </button>
      <button
        className="button button--icon"
        type="button"
        data-testid="map-zoom-out"
        onClick={() => onZoom(-1)}
        disabled={zoomOffset <= -3}
      >
        −
      </button>
    </div>
  );
}
