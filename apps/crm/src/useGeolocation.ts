import { type GeoPoint, isInsideCounty } from '@roofing-crm/shared';
import { useCallback, useState } from 'react';

/**
 * "Use my location", written for the case where it fails.
 *
 * A headless browser denies geolocation by default, an insecure origin has no API at all,
 * and a real user may simply refuse the prompt. In every one of those cases this hook
 * resolves to a status message and leaves the caller's centre untouched, so the map keeps
 * rendering. Nothing in the product is reachable only through GPS.
 */

export type GeolocationStatus =
  'idle' | 'requesting' | 'granted' | 'unavailable' | 'denied' | 'outside_county';

export interface GeolocationState {
  status: GeolocationStatus;
  message: string;
}

const IDLE: GeolocationState = {
  status: 'idle',
  message: 'GPS is optional — a Seminole city, ZIP, or a pin sets the same centre.',
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
          'This browser exposes no geolocation API. Set the centre with a Seminole city, ZIP, or a pin.',
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

        /**
         * A fix outside the county is reported rather than used. The dataset covers Seminole
         * County only, so centring there would return nothing and look like a failed search
         * instead of a device that is simply somewhere else.
         */
        if (!isInsideCounty(point)) {
          setState({
            status: 'outside_county',
            message: `Your position (${point.latitude.toFixed(3)}, ${point.longitude.toFixed(3)}) is outside Seminole County, which is all this CRM holds. The map kept its previous centre.`,
          });
          return;
        }

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
              ? 'Location permission was denied. The map kept its previous centre.'
              : `Could not obtain a position (${error.message || 'unknown error'}). The map kept its previous centre.`,
        });
      },
      { enableHighAccuracy: false, timeout: TIMEOUT_MS, maximumAge: 60_000 },
    );
  }, [onLocated]);

  return { geolocation: state, requestGeolocation: request };
}
