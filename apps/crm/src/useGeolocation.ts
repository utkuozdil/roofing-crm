import type { GeoPoint } from '@roofing-crm/shared';
import { useCallback, useState } from 'react';

/**
 * "Use my location", written for the case where it fails.
 *
 * A headless browser denies geolocation by default, an insecure origin has no API at all,
 * and a real user may simply refuse the prompt. In every one of those cases this hook
 * resolves to a status message and leaves the caller's centre untouched, so the map keeps
 * rendering. Nothing in the product is reachable only through GPS.
 */

export type GeolocationStatus = 'idle' | 'requesting' | 'granted' | 'unavailable' | 'denied';

export interface GeolocationState {
  status: GeolocationStatus;
  message: string;
}

const IDLE: GeolocationState = {
  status: 'idle',
  message: 'GPS centring is optional — the location field below sets the same centre.',
};

/** Long enough for a real fix, short enough that a headless run is never left hanging. */
const TIMEOUT_MS = 8000;

export function useGeolocation(onLocated: (point: GeoPoint) => void) {
  const [state, setState] = useState<GeolocationState>(IDLE);

  const request = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState({
        status: 'unavailable',
        message:
          'This browser exposes no geolocation API. Set the centre with the location field instead.',
      });
      return;
    }

    setState({ status: 'requesting', message: 'Requesting your position…' });

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const point = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        };
        setState({
          status: 'granted',
          message: `Centred on your position, accurate to about ${Math.round(position.coords.accuracy)} m.`,
        });
        onLocated(point);
      },
      (error) => {
        setState({
          status: error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable',
          message:
            error.code === error.PERMISSION_DENIED
              ? 'Location permission was denied. The map kept its previous centre — use the location field to move it.'
              : `Could not obtain a position (${error.message || 'unknown error'}). The map kept its previous centre.`,
        });
      },
      { enableHighAccuracy: false, timeout: TIMEOUT_MS, maximumAge: 60_000 },
    );
  }, [onLocated]);

  return { geolocation: state, requestGeolocation: request };
}
