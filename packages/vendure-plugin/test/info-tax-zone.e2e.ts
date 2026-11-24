import { AddressBasedTaxZoneStrategy, DefaultTaxZoneStrategy } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPluginTestEnvironment } from './env';

// Places a sale exactly as its parent, but is not the class /info can describe, so it may read the address.
class OwnZone extends DefaultTaxZoneStrategy {}

// env.ts's default tax zone, Denmark, has one member: the country DK.
const cases: Array<[string, Parameters<typeof createPluginTestEnvironment>[0], boolean]> = [
  ['the default tax zone strategy', {}, false],
  ['AddressBasedTaxZoneStrategy', { taxOptions: { taxZoneStrategy: new AddressBasedTaxZoneStrategy() } }, true],
  ['a subclass of DefaultTaxZoneStrategy', { taxOptions: { taxZoneStrategy: new OwnZone() } }, true],
];

for (const [name, override, byAddress] of cases) {
  describe(`GET /tally/v1/info taxZone with ${name}`, () => {
    const environment = createPluginTestEnvironment(override);
    const { server, adminClient } = environment;
    beforeAll(() => environment.init());
    afterAll(() => server.destroy());

    async function taxZone() {
      const response = await fetch(`${await server.app.getUrl()}/tally/v1/info`, {
        headers: { Authorization: `Bearer ${adminClient.getAuthToken()}` },
      });
      expect(response.status).toBe(200);
      return (await response.json()).taxZone;
    }

    it(`advertises byAddress ${byAddress} and the default zone's countries`, async () => {
      expect(await taxZone()).toEqual({ byAddress, countries: ['DK'] });
    });

    if (byAddress) return;
    it('lists a country added to the default tax zone on the next read, sorted', async () => {
      expect(await taxZone()).toEqual({ byAddress, countries: ['DK'] });
      const { activeChannel, countries } = await adminClient.query<{
        activeChannel: { defaultTaxZone: { id: string } }; countries: { items: Array<{ id: string; code: string }> };
      }>(parse(`query { activeChannel { defaultTaxZone { id } } countries { items { id code } } }`));
      await adminClient.query(parse(`mutation AddMember($zoneId: ID!, $memberIds: [ID!]!) {
        addMembersToZone(zoneId: $zoneId, memberIds: $memberIds) { id }
      }`), { zoneId: activeChannel.defaultTaxZone.id, memberIds: [countries.items.find(country => country.code === 'DE')!.id] });
      expect(await taxZone()).toEqual({ byAddress, countries: ['DE', 'DK'] });
    });
  });
}
