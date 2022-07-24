import {ProxySetting} from 'get-proxy-settings';
import {HTTPError} from 'got';
import {getRestDescription, RestDescriptionExtended} from './discovery.js';

export async function* getGoogleAdsRestDescription(
  proxy?: ProxySetting
): AsyncGenerator<RestDescriptionExtended> {
  const baseUrl = 'https://googleads.googleapis.com/$discovery/rest';
  let version = 4; // starting version
  const params = {
    get version() {
      return `v${version}`;
    },
  };

  do {
    const restDescriptionSource = new URL(baseUrl);
    Object.entries(params).forEach(([paramName, paramValue]) => {
      restDescriptionSource.searchParams.set(paramName, paramValue);
    });

    try {
      console.log(`Getting ${restDescriptionSource}...`);
      const restDescription = await getRestDescription(
        restDescriptionSource,
        proxy
      );
      yield {
        restDescriptionSource,
        restDescription,
      };
    } catch (e) {
      if (e instanceof HTTPError && e.response.statusCode === 404) {
        // got 404 as expected, stop looking further
      } else {
        throw e;
      }
      return;
    }

    version++;
  } while (true);
}

export const allExtraApiGenerators = [getGoogleAdsRestDescription];
